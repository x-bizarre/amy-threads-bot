// ─────────────────────────────────────────────────────────────────────────────
// Журнал решений LLM — чтобы можно было разобраться, ПОЧЕМУ бот ответил/пропустил.
//
// Каждое решение (ответить на коммент / пропустить / тон аутрича) пишется одной
// записью в Redis-список `decisions:log`. Хранятся последние LOG_LIMIT записей.
// Посмотреть журнал можно командой /log в Telegram (или напрямую в Redis).
//
// Намеренно лёгкое: не БД, не аналитика — just enough, чтобы дебажить «почему так».
// ─────────────────────────────────────────────────────────────────────────────

import { cmdRaw } from './redis';

const LOG_KEY = 'decisions:log';
const LOG_LIMIT = 200; // сколько последних решений держим

export interface Decision {
  ts: string; // ISO-время
  kind: 'reply' | 'outreach' | 'post'; // тип решения
  action: string; // publish | skip | тон и т.п.
  reason?: string; // короткое объяснение
  context?: string; // обрезанный текст, на который реагировали
}

// Записать решение в журнал (не падаем, если Redis недоступен).
export async function logDecision(d: Omit<Decision, 'ts'>): Promise<void> {
  const entry: Decision = { ts: new Date().toISOString(), ...d };
  try {
    // LPUSH свежие в начало, LTRIM держит длину списка ограниченной.
    await cmdRaw(['LPUSH', LOG_KEY, JSON.stringify(entry)]);
    await cmdRaw(['LTRIM', LOG_KEY, 0, LOG_LIMIT - 1]);
  } catch {
    // журнал — не критичный путь, ошибку глотаем
  }
}

// Прочитать последние N решений (для команды /log).
export async function recentDecisions(n = 20): Promise<Decision[]> {
  try {
    const raw = (await cmdRaw(['LRANGE', LOG_KEY, 0, n - 1])) as string[];
    return (raw ?? [])
      .map((s) => {
        try {
          return JSON.parse(s) as Decision;
        } catch {
          return null;
        }
      })
      .filter((d): d is Decision => d !== null);
  } catch {
    return [];
  }
}
