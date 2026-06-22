// ─────────────────────────────────────────────────────────────────────────────
// Обновление long-lived Threads-токена.
//
// Проблема: токен Threads живёт ~60 дней, потом бот молча перестаёт публиковать.
// Решение: раз в неделю cron-ручка дёргает refreshThreadsToken():
//   1. Проверяет, сколько токену осталось жить.
//   2. Если меньше порога — обновляет его через Threads API и сохраняет в Redis.
//   3. Шлёт алерт в Telegram (и при успешном обновлении, и если что-то не так).
//
// Почему новый токен храним в Redis, а не в env: на Vercel переменные окружения
// во время выполнения менять нельзя. Поэтому актуальный токен кладём в Redis под
// ключ THREADS_TOKEN_KEY, а lib/threads.ts при каждом запросе сначала смотрит туда
// (см. функцию token() — она проверяет Redis-override перед env).
// ─────────────────────────────────────────────────────────────────────────────

import { get, set } from './redis';
import { sendTelegram } from './telegram';

const API_BASE = 'https://graph.threads.net';

// Ключ в Redis, где лежит актуальный токен и когда он истекает.
export const THREADS_TOKEN_KEY = 'threads:access_token';

interface StoredToken {
  token: string;
  expires_at: number; // unix ms
}

// За сколько дней до конца начинаем обновлять.
const REFRESH_BEFORE_DAYS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

// Возвращает текущий токен: сначала Redis-override (свежий после refresh),
// потом env. Используется в lib/threads.ts.
export async function getActiveToken(): Promise<string | null> {
  const stored = await get<StoredToken>(THREADS_TOKEN_KEY).catch(() => null);
  if (stored?.token) return stored.token;
  return process.env.THREADS_ACCESS_TOKEN ?? null;
}

// Сам вызов Threads API на обновление long-lived токена.
// Возвращает новый токен и срок его жизни в секундах.
async function callRefresh(token: string): Promise<{ access_token: string; expires_in: number }> {
  const url = new URL(`${API_BASE}/refresh_access_token`);
  url.searchParams.set('grant_type', 'th_refresh_token');
  url.searchParams.set('access_token', token);
  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`refresh_access_token ${res.status}: ${text}`);
  }
  return (await res.json()) as { access_token: string; expires_in: number };
}

// Главная функция — вызывается из cron-ручки.
// force=true обновит токен даже если до конца ещё далеко (для ручной проверки).
export async function refreshThreadsToken(force = false): Promise<{
  status: 'refreshed' | 'still_fresh' | 'no_token' | 'error';
  daysLeft?: number;
  message: string;
}> {
  const current = await getActiveToken();
  if (!current) {
    const message = 'THREADS_ACCESS_TOKEN не задан — нечего обновлять.';
    return { status: 'no_token', message };
  }

  // Узнаём, сколько токену осталось. Если в Redis есть expires_at — берём его,
  // иначе считаем, что токен «свежий» неизвестного возраста и обновляем по графику.
  const stored = await get<StoredToken>(THREADS_TOKEN_KEY).catch(() => null);
  const now = Date.now();
  const daysLeft = stored?.expires_at
    ? Math.round((stored.expires_at - now) / DAY_MS)
    : undefined;

  // Если знаем срок и он ещё большой — не трогаем (Threads не даёт обновлять
  // токен чаще, чем раз в 24 часа, и не раньше, чем ему исполнится сутки).
  if (!force && daysLeft !== undefined && daysLeft > REFRESH_BEFORE_DAYS) {
    return {
      status: 'still_fresh',
      daysLeft,
      message: `Токен Threads ещё свежий: осталось ~${daysLeft} дн. Обновлять рано.`,
    };
  }

  try {
    const fresh = await callRefresh(current);
    const expiresAt = now + fresh.expires_in * 1000;
    await set<StoredToken>(THREADS_TOKEN_KEY, {
      token: fresh.access_token,
      expires_at: expiresAt,
    });
    const newDaysLeft = Math.round(fresh.expires_in / 86400);
    const message = `✅ Threads-токен обновлён. Новый срок: ~${newDaysLeft} дн.`;
    await sendTelegram(`<b>Threads-токен</b>\n${message}`).catch(() => {});
    return { status: 'refreshed', daysLeft: newDaysLeft, message };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const alert =
      `⚠️ <b>Не удалось обновить Threads-токен</b>\n` +
      `<pre>${msg.slice(0, 400)}</pre>\n` +
      `Обнови токен вручную (см. SETUP.md → раздел Threads) и положи в env ` +
      `THREADS_ACCESS_TOKEN, иначе публикация скоро остановится.`;
    await sendTelegram(alert).catch(() => {});
    return { status: 'error', daysLeft, message: msg };
  }
}
