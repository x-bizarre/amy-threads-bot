// Cron watcher — раз в 10 минут через GitHub Actions.
// Для каждого опубликованного поста проверяет новые реплаи.
// Фильтрует свои, группирует по автору, создаёт диалоги в Redis,
// шлёт в Telegram с LLM-черновиком и инлайн-кнопками.
import { NextResponse } from 'next/server';
import { listQueue, QueueItem } from '@/lib/queue';
import { getPostReplies, ReplyItem } from '@/lib/threads';
import { sendTelegram } from '@/lib/telegram';
import { isReplySeen, markReplySeen } from '@/lib/state';
import { generateDraft } from '@/lib/openrouter';
import { logDecision } from '@/lib/decision-log';
import { Dialog, genDialogId, saveDialog } from '@/lib/dialog';
import { formatDialog } from '@/lib/format';
import { appendToArchive, ArchiveEntry } from '@/lib/comments-archive';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_AGE_DAYS = 14;

function isRecent(publishedAt?: string): boolean {
  if (!publishedAt) return false;
  const d = new Date(publishedAt.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return true;
  const daysAgo = (Date.now() - d.getTime()) / 86400_000;
  return daysAgo <= MAX_AGE_DAYS;
}

function verifyAuth(req: Request): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return auth === `Bearer ${secret}`;
}

function extractPostText(item: QueueItem): string {
  return item.posts[0] ?? '';
}

export async function GET(req: Request) {
  if (!verifyAuth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const myUsername = (process.env.THREADS_USERNAME ?? '').toLowerCase();
  if (!myUsername) {
    return NextResponse.json({ error: 'THREADS_USERNAME не задан' }, { status: 500 });
  }

  const items = await listQueue();
  const posted = items.filter(
    (i) =>
      String(i.frontmatter.status ?? '').toLowerCase() === 'posted' &&
      i.frontmatter.threads_post_id &&
      isRecent(String(i.frontmatter.published_at ?? ''))
  );

  let newDialogs = 0;
  let skippedOwn = 0;
  const archiveBatch: ArchiveEntry[] = [];

  for (const item of posted) {
    const postId = String(item.frontmatter.threads_post_id);
    let replies: ReplyItem[] = [];
    try {
      replies = await getPostReplies(postId);
    } catch (e) {
      console.error(`get replies for ${postId}:`, e);
      continue;
    }

    const fresh: ReplyItem[] = [];
    for (const reply of replies) {
      if (!reply.id) continue;
      if (await isReplySeen(postId, reply.id)) continue;
      if ((reply.username ?? '').toLowerCase() === myUsername) {
        await markReplySeen(postId, reply.id);
        skippedOwn++;
        continue;
      }
      fresh.push(reply);
    }

    const byUser = new Map<string, ReplyItem[]>();
    for (const r of fresh) {
      const uname = r.username ?? 'unknown';
      if (!byUser.has(uname)) byUser.set(uname, []);
      byUser.get(uname)!.push(r);
    }

    for (const [uname, userReplies] of byUser.entries()) {
      const userReplyIds = userReplies.map((r) => r.id!).filter(Boolean);
      // Помечаем seen ДО любых внешних вызовов — иначе при таймауте
      // следующий тик снова создаст диалог.
      await markReplySeen(postId, ...userReplyIds);

      const combinedText = userReplies.map((r) => r.text ?? '').join('\n\n').trim();
      if (!combinedText) continue;

      const rootReply = userReplies[0];
      const postText = extractPostText(item);

      // В архив комментов (для weekly-analysis). Каждый юзер — одна запись.
      archiveBatch.push({
        username: uname,
        text: combinedText,
        permalink: rootReply.permalink,
        post_filename: item.path.split('/').pop() ?? item.path,
        post_text_short: postText,
      });

      let draft;
      try {
        draft = await generateDraft({
          postText,
          replyText: combinedText,
          replyUsername: uname,
        });
      } catch (e: any) {
        console.error('LLM draft failed:', e);
        await sendTelegram(
          `<b>Новый комментарий (LLM упал — без черновика)</b>\n` +
            `Под постом: <code>${item.path.split('/').pop()}</code>\n` +
            `От <b>@${uname}</b>:\n\n${combinedText.slice(0, 600)}\n\n` +
            `<a href="${rootReply.permalink ?? ''}">Открыть</a>\nОшибка: ${String(e).slice(0, 200)}`,
          { disablePreview: true }
        );
        continue;
      }

      const now = new Date().toISOString();
      const dialog: Dialog = {
        id: genDialogId(),
        root_reply_id: rootReply.id!,
        reply_ids: userReplyIds,
        reply_username: uname,
        reply_text_en: combinedText,
        reply_permalink: rootReply.permalink ?? '',
        post_id: postId,
        post_text: postText,
        post_filename: item.path.split('/').pop() ?? item.path,
        comment_ru: draft.comment_ru ?? '',
        draft_ru: draft.draft_ru ?? '',
        status: draft.recommendation === 'skip' ? 'done' : 'awaiting_approval',
        skip_reason: draft.skip_reason,
        created_at: now,
        updated_at: now,
      };

      await saveDialog(dialog);

      // Журнал решений LLM — чтобы потом понять, почему ответили/пропустили.
      await logDecision({
        kind: 'reply',
        action: draft.recommendation,
        reason: draft.skip_reason,
        context: combinedText.slice(0, 160),
      });

      const { text, keyboard } = formatDialog(dialog);
      try {
        const msg = await sendTelegram(text, {
          disablePreview: true,
          inlineKeyboard: keyboard.length ? keyboard : undefined,
        });
        dialog.telegram_message_id = msg.message_id;
        await saveDialog(dialog);
      } catch (e) {
        console.error('Telegram send failed:', e);
      }

      newDialogs++;
    }
  }

  // Архивируем все новые комменты одним коммитом — для weekly-analysis
  if (archiveBatch.length > 0) {
    try {
      await appendToArchive(archiveBatch);
    } catch (e) {
      console.error('archive failed:', e);
    }
  }

  return NextResponse.json({
    checked: posted.length,
    new_dialogs: newDialogs,
    skipped_own: skippedOwn,
    archived: archiveBatch.length,
  });
}
