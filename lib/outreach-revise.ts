// Ревизия outreach-комментария по правке пользователя.
// Отдельный файл, чтобы route.ts мог делать dynamic import
// (не тянуть весь outreach-промпт в главный бандл).

import { BRAND, handleAt } from './brand-config';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-sonnet-4.6';

const SYSTEM_PROMPT = `
Ты пишешь комментарий от аккаунта ${handleAt()} под чужим постом в Threads.
${BRAND.name} — ${BRAND.oneLiner}.
Тон: тёплый, живой, от первого лица.
Макс 3-4 предложения. Без URL, без цен.
{{Добавь сюда свои запретные слова, если есть.}}
`.trim();

export async function reviseOutreachComment(
  originalPostText: string,
  currentCommentEn: string,
  correctionRu: string
): Promise<{ comment_en: string; comment_ru: string }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY не задан');

  const userPrompt = `Чужой пост в Threads:
"""
${originalPostText}
"""

Текущий вариант комментария (EN):
"""
${currentCommentEn}
"""

Правка от автора (на русском):
"""
${correctionRu}
"""

Перепиши комментарий с учётом правки. Верни JSON:
{
  "comment_en": "новый текст комментария на английском",
  "comment_ru": "перевод на русский"
}`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://your-app.vercel.app',
      'X-Title': 'Threads Bot Outreach Revise',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 400,
      temperature: 0.5,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenRouter revise ${res.status}: ${t}`);
  }

  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const raw = data.choices[0]?.message?.content ?? '';

  let cleaned = raw.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) cleaned = fenced[1];

  try {
    return JSON.parse(cleaned) as { comment_en: string; comment_ru: string };
  } catch {
    throw new Error('LLM parse failure при ревизии outreach-комментария');
  }
}
