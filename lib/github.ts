// Работа с файлами в GitHub-репозитории через Contents API.
// Нужно, потому что Vercel serverless ФС read-only —
// состояние (status=posted, replies_state) храним в репо как commits.

const API = 'https://api.github.com';

function repoEnv() {
  const owner = process.env.GITHUB_REPO_OWNER ?? 'your-github-org';
  const repo = process.env.GITHUB_REPO_NAME ?? 'threads-bot';
  const token = process.env.GITHUB_TOKEN;
  const branch = process.env.GITHUB_BRANCH ?? 'main';
  if (!token) throw new Error('GITHUB_TOKEN не задан');
  return { owner, repo, branch, token };
}

async function gh(method: string, path: string, body?: any): Promise<any> {
  const { token } = repoEnv();
  // cache: 'no-store' + Cache-Control — иначе Next.js на Vercel кеширует GET к
  // GitHub API и getFile/listDir возвращают stale SHA. Симптом: putFile падает
  // с 409 потому что отправляем устаревший sha. Аналог фикса в lib/redis.ts.
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Cache-Control': 'no-store',
    },
    cache: 'no-store',
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

export interface GhFile {
  path: string;
  content: string; // decoded utf-8
  sha: string;
}

export async function getFile(path: string): Promise<GhFile | null> {
  const { owner, repo, branch } = repoEnv();
  const data = await gh('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`);
  if (!data || Array.isArray(data)) return null;
  const content = Buffer.from(data.content, data.encoding ?? 'base64').toString('utf-8');
  return { path: data.path, content, sha: data.sha };
}

export async function listDir(path: string): Promise<Array<{ path: string; sha: string; type: string }>> {
  const { owner, repo, branch } = repoEnv();
  const data = await gh('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`);
  if (!data || !Array.isArray(data)) return [];
  return data as Array<{ path: string; sha: string; type: string }>;
}

export async function putFile(path: string, content: string, message: string, sha?: string): Promise<void> {
  const { owner, repo, branch } = repoEnv();
  await gh('PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch,
    sha,
  });
}
