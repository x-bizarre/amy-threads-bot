// Архив всех комментов под нашими постами.
// Каждый коммент дописывается сюда watcher'ом сразу как пришёл.
//
// Структура файла analytics/threads-report.md:
//   ## <YYYY-MM-DD HH:MM> · @<username> → <post_filename>
//   <text комментария>
//
// Используется weekly-analysis для извлечения findings.
import { getFile, putFile } from './github';
import { handleAt } from './brand-config';

const ARCHIVE_PATH = 'analytics/threads-report.md';

const HEADER = `# Threads Comments Archive

Автоматический архив всех комментариев под постами ${handleAt()}.
Дописывается watcher'ом каждые 5 минут. Анализируется weekly-analysis раз в неделю.

Формат записи:
\`\`\`
### <timestamp> · @<username> → <post_filename>
<текст коммента>
\`\`\`

---

`;

export interface ArchiveEntry {
  username: string;
  text: string;
  permalink?: string;
  post_filename: string;
  post_text_short: string;
}

// Дописать одну или несколько записей в архив.
// Берём текущий файл, append'им новые записи, коммитим обратно через putFile.
// Если файла нет — создаём с заголовком.
export async function appendToArchive(entries: ArchiveEntry[]): Promise<void> {
  if (entries.length === 0) return;

  let file = await getFile(ARCHIVE_PATH).catch(() => null);
  let content: string;
  let sha: string | undefined;
  if (!file) {
    content = HEADER;
    sha = undefined;
  } else {
    content = file.content;
    sha = file.sha;
    // Если файл существует но без нашего заголовка — он мог быть скопирован
    // вручную (legacy формат). Не трогаем — просто аппендим в конец.
  }

  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const block = entries
    .map((e) => {
      const link = e.permalink ? ` · [link](${e.permalink})` : '';
      return [
        `### ${now} · @${e.username} → ${e.post_filename}${link}`,
        `> Под постом: ${e.post_text_short.slice(0, 140)}…`,
        '',
        e.text.trim(),
        '',
      ].join('\n');
    })
    .join('\n---\n\n');

  const newContent = content.trimEnd() + '\n\n---\n\n' + block + '\n';
  await putFile(
    ARCHIVE_PATH,
    newContent,
    `archive: ${entries.length} new comment(s)`,
    sha
  );
}

// Прочитать архив целиком (для weekly-analysis)
export async function readArchive(): Promise<string> {
  const file = await getFile(ARCHIVE_PATH).catch(() => null);
  return file?.content ?? '';
}
