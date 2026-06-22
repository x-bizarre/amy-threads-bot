// Cron-ручка автопостинга. Вызывается Vercel cron 5 раз в день.
// Берёт следующий draft из queue/, публикует, обновляет статус, шлёт Telegram.
import { NextResponse } from 'next/server';
import { extractMediaForPost, markPosted, nextDraft } from '@/lib/queue';
import { publish } from '@/lib/threads';
import { sendTelegram } from '@/lib/telegram';
import { acquireLock, releaseLock, get, setWithTtl } from '@/lib/redis';

// Анти-дубль: глобальный лок на публикацию (только один cron публикует за раз)
// и пометка «этот файл уже опубликован» на случай, если markPosted в репо упал.
const AUTOPOST_LOCK = 'lock:autopost';
const postedKey = (path: string) => `posted:${path}`;

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

  // Берём глобальный лок на 4 минуты (меньше maxDuration). Если другой вызов
  // cron уже публикует — выходим, чтобы не опубликовать тот же пост дважды.
  const gotLock = await acquireLock(AUTOPOST_LOCK, 240).catch(() => true);
  if (!gotLock) {
    return NextResponse.json({ status: 'busy', reason: 'autopost уже выполняется' });
  }

  // item объявляем здесь, чтобы он был виден и в catch (для текста ошибки)
  let item: Awaited<ReturnType<typeof nextDraft>> = null;
  try {
    item = await nextDraft();
    if (!item) {
      // Уведомление «очередь пуста» отключено: теперь посты идут не из очереди,
      // а пишутся вручную → согласование → только потом кладутся в очередь.
      // Поэтому пустая очередь — нормальное состояние, спамить не нужно.
      return NextResponse.json({ status: 'queue_empty' });
    }

    if (item.posts.length === 0) {
      return NextResponse.json({ status: 'error', reason: `${item.path}: нет постов` }, { status: 500 });
    }

    // Двойная защита: если файл уже помечен опубликованным в Redis (а в репо
    // статус не успел записаться) — не публикуем повторно.
    const alreadyPosted = await get(postedKey(item.path)).catch(() => null);
    if (alreadyPosted) {
      return NextResponse.json({ status: 'skipped_duplicate', file: item.path });
    }

    // Публикуем первый пост (с медиа из frontmatter если есть)
    const firstMedia = extractMediaForPost(item, 0);
    const first = await publish(item.posts[0], firstMedia);

    // СРАЗУ помечаем файл опубликованным в Redis — до записи статуса в репо.
    // Это закрывает окно «опубликовали, но markPosted упал»: следующий cron
    // увидит пометку и не опубликует тот же пост повторно. TTL 7 дней.
    await setWithTtl(postedKey(item.path), { post_id: first.id }, 7 * 24 * 3600).catch(() => {});

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
    const fname = item ? (item.path.split('/').pop() ?? item.path) : '(файл не выбран)';
    try {
      await sendTelegram(
        `<b>Threads: ошибка публикации</b>\nФайл: <code>${fname}</code>\n<pre>${msg.slice(0, 500)}</pre>`
      );
    } catch {}
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 });
  } finally {
    // Снимаем лок, чтобы следующий слот не ждал TTL
    await releaseLock(AUTOPOST_LOCK).catch(() => {});
  }
}
