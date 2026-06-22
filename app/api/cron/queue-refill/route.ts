// Cron — раз в день проверяет очередь и если в ней меньше threshold драфтов,
// генерит N новых и шлёт в Telegram на одобрение.
// Опубликованные посты НЕ публикуются автоматически — только после ✅ в TG.
import { NextResponse } from 'next/server';
import { listQueue } from '@/lib/queue';
import { generatePost } from '@/lib/post-generator';
import { genDraftId, saveDraft, listPendingDrafts, PostDraft } from '@/lib/post-draft';
import { formatDraft } from '@/lib/format';
import { sendTelegram } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const QUEUE_MIN = 5; // если драфтов меньше — генерим
const GENERATE_BATCH = 3; // сколько генерим за раз

function verifyAuth(req: Request): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!verifyAuth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const items = await listQueue();
  const drafts = items.filter((i) => {
    const status = String(i.frontmatter.status ?? '').toLowerCase();
    return status === '' || status === 'draft';
  });

  // Уже есть pending (ждущие одобрения) — не плодим больше
  const pending = await listPendingDrafts();
  const totalUpcoming = drafts.length + pending.length;

  if (totalUpcoming >= QUEUE_MIN) {
    return NextResponse.json({
      status: 'ok',
      message: `В очереди ${drafts.length} драфтов + ${pending.length} ждут одобрения. Норм.`,
    });
  }

  const need = Math.min(GENERATE_BATCH, QUEUE_MIN - totalUpcoming);
  const generated: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < need; i++) {
    try {
      const gen = await generatePost();
      const draft: PostDraft = {
        id: genDraftId(),
        goal: gen.goal,
        castdev_module: gen.castdev_module,
        text_en: gen.text_en,
        suggested_filename: gen.suggested_filename,
        rationale: gen.rationale,
        corrections_ru: [],
        status: 'awaiting_approval',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await saveDraft(draft);
      const { text, keyboard } = formatDraft(draft);
      const sent = await sendTelegram(text, { disablePreview: true, inlineKeyboard: keyboard });
      draft.telegram_message_id = sent.message_id;
      await saveDraft(draft);
      generated.push(`${gen.goal}: ${gen.suggested_filename}`);
    } catch (e: any) {
      errors.push(String(e).slice(0, 200));
    }
  }

  if (errors.length > 0) {
    await sendTelegram(`<b>⚠️ Ошибки при генерации:</b>\n<pre>${errors.join('\n')}</pre>`);
  }

  return NextResponse.json({
    status: 'generated',
    queue_drafts: drafts.length,
    pending_approval: pending.length,
    generated,
    errors,
  });
}
