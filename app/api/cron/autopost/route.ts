// Cron-ручка автопостинга. Вызывается Vercel cron 5 раз в день.
// Берёт следующий draft из queue/, публикует, обновляет статус, шлёт Telegram.
import { NextResponse } from 'next/server';
import { extractMediaForPost, markPosted, nextDraft } from '@/lib/queue';
import { publish } from '@/lib/threads';
import { sendTelegram } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 минут — хватит на тред

function verifyAuth(req: Request): boolean {
  // Vercel cron шлёт заголовок Authorization: Bearer <CRON_SECRET>
  // Env CRON_SECRET устанавливается автоматически при включении cron.
  const auth = req.headers.get('authorization') ?? '';
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev / ручной запуск
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!verifyAuth(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Пауза автопостинга. Установить env THREADS_AUTOPOST_PAUSED=1 в Vercel,
  // чтобы остановить публикации без отключения cron. Снять — удалить переменную.
  if (process.env.THREADS_AUTOPOST_PAUSED === '1') {
    return NextResponse.json({ status: 'paused' });
  }

  const item = await nextDraft();
  if (!item) {
    // Уведомление «очередь пуста» отключено: теперь посты идут не из очереди,
    // а пишутся вручную → согласование → только потом кладутся в очередь.
    // Поэтому пустая очередь — нормальное состояние, спамить не нужно.
    return NextResponse.json({ status: 'queue_empty' });
  }

  if (item.posts.length === 0) {
    return NextResponse.json({ status: 'error', reason: `${item.path}: нет постов` }, { status: 500 });
  }

  try {
    // Публикуем первый пост (с медиа из frontmatter если есть)
    const firstMedia = extractMediaForPost(item, 0);
    const first = await publish(item.posts[0], firstMedia);
    let tailId = first.id;
    const publishedIds: string[] = [first.id];

    // Остальные — как реплаи цепочкой
    for (let i = 1; i < item.posts.length; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const media = extractMediaForPost(item, i);
      const reply = await publish(item.posts[i], media, tailId);
      tailId = reply.id;
      publishedIds.push(reply.id);
    }

    // Reply-bait отключён: раньше он публиковался отдельным авторским
    // комментарием, но в эту секцию очереди попадали внутренние заметки.
    // Бот больше НЕ публикует никаких авторских комментариев к посту.

    // Статус в файле и Telegram
    const publishedAt = new Date().toISOString().replace('T', ' ').slice(0, 16);
    await markPosted(item, {
      post_id: first.id,
      permalink: first.permalink,
      published_at: publishedAt,
    });

    const filename = item.path.split('/').pop() ?? item.path;
    const notes = String(item.frontmatter.notes ?? '').slice(0, 200);
    await sendTelegram(
      `<b>Threads: опубликовано</b>\n` +
        `Файл: <code>${filename}</code>\n` +
        `Постов в треде: ${item.posts.length}\n` +
        `<a href="${first.permalink}">Открыть пост</a>\n${notes}`,
      { disablePreview: true }
    );

    return NextResponse.json({
      status: 'posted',
      file: item.path,
      post_id: first.id,
      permalink: first.permalink,
      ids: publishedIds,
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    try {
      await sendTelegram(
        `<b>Threads: ошибка публикации</b>\nФайл: <code>${item.path.split('/').pop()}</code>\n<pre>${msg.slice(0, 500)}</pre>`
      );
    } catch {}
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 });
  }
}
