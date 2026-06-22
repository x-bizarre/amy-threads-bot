// Парсер очереди постов — читает markdown-файлы из queue/ в репозитории
import matter from 'gray-matter';
import { getFile, listDir, putFile } from './github';
import type { MediaItem } from './threads';

export interface QueueItem {
  path: string;
  sha: string;
  frontmatter: Record<string, any>;
  posts: string[];
  replyBait?: string;
  rawContent: string;
}

// Базовый URL для медиа из репо. На Vercel это домен деплоя; локально — задаётся env.
function publicBaseUrl(): string {
  const explicit = process.env.PUBLIC_MEDIA_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  // Vercel автоматически выставляет VERCEL_URL (без https://)
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return 'http://localhost:3000';
}

// Достаёт media-вложения из frontmatter и превращает их в абсолютные URL.
// Ожидаемый формат во frontmatter:
//   media:
//     - { type: image, path: /media/2026-05-28/photo.jpg, alt: "..." }
//     - { type: image, url: https://... }   # абсолютный URL — тоже ок
// post_index (опционально) указывает к какому посту в треде прикреплено медиа
// (0 = первый, по умолчанию 0). Если у нескольких медиа одинаковый post_index —
// они станут каруселью.
export function extractMediaForPost(item: QueueItem, postIdx: number): MediaItem[] {
  const raw = item.frontmatter.media;
  if (!Array.isArray(raw)) return [];
  const base = publicBaseUrl();
  return raw
    .filter((m: any) => {
      const idx = typeof m?.post_index === 'number' ? m.post_index : 0;
      return idx === postIdx;
    })
    .map((m: any) => {
      const type: 'image' | 'video' = m.type === 'video' ? 'video' : 'image';
      let url: string = m.url ?? '';
      if (!url && m.path) {
        const path = String(m.path).startsWith('/') ? m.path : `/${m.path}`;
        url = `${base}${path}`;
      }
      return { type, url, alt: m.alt } as MediaItem;
    })
    .filter((m: MediaItem) => !!m.url);
}

function extractSections(body: string): { posts: string[]; replyBait?: string } {
  const postHeader = /^##\s+Пост\s+(\d+)[^\n]*$/gm;
  const baitHeader = /^##\s+Reply-?bait[^\n]*$/im;

  const headers: Array<{ idx: number; end: number }> = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(postHeader.source, 'gm');
  while ((m = re.exec(body)) !== null) headers.push({ idx: m.index, end: m.index + m[0].length });

  const baitMatch = baitHeader.exec(body);
  const baitStart = baitMatch ? baitMatch.index : -1;

  const posts: string[] = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].end;
    let end: number;
    if (i + 1 < headers.length) end = headers[i + 1].idx;
    else if (baitStart >= 0 && baitStart > start) end = baitStart;
    else end = body.length;
    const text = body.slice(start, end).trim();
    if (text) posts.push(text);
  }

  let replyBait: string | undefined;
  if (baitMatch) {
    const start = baitMatch.index + baitMatch[0].length;
    const text = body.slice(start).trim();
    if (text) replyBait = text;
  }

  return { posts, replyBait };
}

// Threads post_id — это 17-значное число, выходящее за пределы Number.MAX_SAFE_INTEGER (2^53).
// gray-matter парсит YAML и превращает такое число в JS number, теряя точность последних цифр.
// Достаём эти поля сырым regex-ом по тексту frontmatter'а до парсинга.
const RAW_ID_FIELDS = ['threads_post_id'] as const;

function extractRawFrontmatter(content: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const lm = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.+)$/.exec(line.trim());
    if (lm) out[lm[1]] = lm[2].replace(/^['"](.*)['"]$/, '$1');
  }
  return out;
}

export async function listQueue(): Promise<QueueItem[]> {
  const entries = await listDir('queue');
  const items: QueueItem[] = [];
  for (const e of entries) {
    if (e.type !== 'file') continue;
    if (!e.path.endsWith('.md')) continue;
    // Служебные файлы — не посты:
    if (e.path.endsWith('INDEX.md')) continue;
    if (e.path.endsWith('castdev_findings.md')) continue;
    if (e.path.endsWith('README.md')) continue;
    const file = await getFile(e.path);
    if (!file) continue;
    const parsed = matter(file.content);
    const rawFm = extractRawFrontmatter(file.content);
    const frontmatter: Record<string, any> = { ...parsed.data };
    // Перезаписываем "опасные" поля сырыми строками, чтобы не потерять точность
    for (const key of RAW_ID_FIELDS) {
      if (rawFm[key]) frontmatter[key] = rawFm[key];
    }
    const { posts, replyBait } = extractSections(parsed.content);
    items.push({
      path: file.path,
      sha: file.sha,
      frontmatter,
      posts,
      replyBait,
      rawContent: file.content,
    });
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  return items;
}

export async function nextDraft(): Promise<QueueItem | null> {
  const items = await listQueue();
  for (const item of items) {
    const status = String(item.frontmatter.status ?? '').toLowerCase();
    if (status === '' || status === 'draft') return item;
  }
  return null;
}

export async function markPosted(
  item: QueueItem,
  meta: { post_id: string; permalink: string; published_at: string }
): Promise<void> {
  const newFm = {
    ...item.frontmatter,
    status: 'posted',
    published_at: meta.published_at,
    threads_post_id: meta.post_id,
    threads_url: meta.permalink,
  };
  const parsed = matter(item.rawContent);
  const newContent = matter.stringify(parsed.content, newFm);
  await putFile(
    item.path,
    newContent,
    `posted: ${item.path.split('/').pop()}`,
    item.sha
  );
}
