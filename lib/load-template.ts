// ─────────────────────────────────────────────────────────────────────────────
// Загрузчик шаблонов из папки prompts/.
//
// Идея: голос бренда, продукт, кастдев-вопросы человек правит ТОЛЬКО в markdown-
// файлах prompts/*.md — переносить текст в код руками не нужно. Код читает эти
// файлы напрямую и подставляет в промпты для LLM.
//
// Почему через GitHub API, а не fs.readFile: на Vercel файловая система во время
// выполнения read-only и не содержит исходники в нужном виде. Тот же подход, что
// и для очереди постов (queue/). Локально (vercel dev / next dev) тоже работает,
// если задан GITHUB_TOKEN.
//
// Подстановки в тексте шаблона: {{BRAND_NAME}}, {{BRAND_SITE}}, {{BRAND_HANDLE}},
// {{BRAND_FOUNDER}} — заменяются на значения из brand-config.
// ─────────────────────────────────────────────────────────────────────────────

import { getFile } from './github';
import { BRAND } from './brand-config';

// Кэш на время жизни одного serverless-инстанса — чтобы не дёргать GitHub API
// на каждый вызов в рамках одного запроса.
const cache = new Map<string, { text: string; at: number }>();
const TTL_MS = 60_000; // минута — шаблоны меняются редко

function applyVars(text: string): string {
  return text
    .replaceAll('{{BRAND_NAME}}', BRAND.name)
    .replaceAll('{{BRAND_SITE}}', BRAND.site)
    .replaceAll('{{BRAND_HANDLE}}', BRAND.handle)
    .replaceAll('{{BRAND_FOUNDER}}', BRAND.founder || '(основатель не указан)');
}

// Читает prompts/<name> и подставляет переменные бренда.
// Пример: await loadTemplate('brand-voice.md')
export async function loadTemplate(name: string): Promise<string> {
  const path = `prompts/${name}`;
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;

  const file = await getFile(path);
  if (!file) {
    throw new Error(
      `Шаблон не найден: ${path}. Проверь, что файл существует в репозитории ` +
        `и что заданы GITHUB_TOKEN / GITHUB_REPO_OWNER / GITHUB_REPO_NAME.`
    );
  }
  const text = applyVars(file.content).trim();
  cache.set(path, { text, at: Date.now() });
  return text;
}
