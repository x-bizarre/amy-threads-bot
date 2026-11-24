// Общие проверки авторизации для API-роутов.
// Все проверки fail-closed: если секрет не задан в env — запрос отклоняется.
import { timingSafeEqual } from 'crypto';

// Сравнение строк за постоянное время (защита от timing-атак).
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Проверка заголовка Authorization: Bearer <CRON_SECRET>.
// Vercel cron шлёт его сам, но только если CRON_SECRET задан в env проекта —
// автоматически Vercel эту переменную НЕ создаёт. Без CRON_SECRET запрос отклоняется.
export function verifyCronAuth(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get('authorization') ?? '';
  return safeEqual(auth, `Bearer ${secret}`);
}
