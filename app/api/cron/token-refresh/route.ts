// Cron-ручка обновления Threads-токена. Запускается раз в неделю.
// Если токену осталось меньше ~10 дней — обновляет его и кладёт свежий в Redis,
// шлёт результат в Telegram. См. lib/token-refresh.ts.
import { NextResponse } from 'next/server';
import { refreshThreadsToken } from '@/lib/token-refresh';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function verifyAuth(req: Request): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev / ручной запуск
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!verifyAuth(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  // ?force=1 — обновить токен принудительно (для ручной проверки)
  const force = new URL(req.url).searchParams.get('force') === '1';
  const result = await refreshThreadsToken(force);
  const httpStatus = result.status === 'error' ? 500 : 200;
  return NextResponse.json(result, { status: httpStatus });
}
