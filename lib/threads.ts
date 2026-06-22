// Обёртка над Threads Graph API — публикация и чтение реплаев
const API_BASE = 'https://graph.threads.net/v1.0';

function token(): string {
  const t = process.env.THREADS_ACCESS_TOKEN;
  if (!t) throw new Error('THREADS_ACCESS_TOKEN не задан');
  return t;
}

function userId(): string {
  const id = process.env.THREADS_USER_ID;
  if (!id) throw new Error('THREADS_USER_ID не задан');
  return id;
}

async function tApi(method: string, path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${API_BASE}${path}`);
  // Для POST шлём поля в body (form-encoded), а не в URL.
  // Иначе undici/fetch на Vercel runtime падает на не-ASCII символах в URL
  // (например em-dash 8212) с "ByteString character > 255".
  // Для GET — параметры в URL (там обычно короткие fields/limit).
  let res: Response;
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', token());
    res = await fetch(url.toString(), { method });
  } else {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) form.set(k, v);
    form.set('access_token', token());
    res = await fetch(url.toString(), {
      method,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Threads API ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

// Пауза между созданием контейнера и публикацией — Threads требует
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Возможные статусы Threads-контейнера:
// IN_PROGRESS — обрабатывается, ждём дальше
// FINISHED   — готов к threads_publish
// PUBLISHED  — уже опубликован параллельным вызовом → publish пропускаем
// ERROR / EXPIRED — нерабочий
type ContainerWaitResult = 'ready' | 'already_published';

// Ждём пока контейнер станет FINISHED. Без этого Threads отвечает
// "Media Not Found" на threads_publish — контейнер ещё не обработан.
async function waitContainerReady(creationId: string, maxAttempts = 15): Promise<ContainerWaitResult> {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);
    try {
      const status = await tApi('GET', `/${creationId}`, { fields: 'status,error_message' });
      if (status.status === 'FINISHED') return 'ready';
      if (status.status === 'PUBLISHED') return 'already_published';
      if (status.status === 'ERROR' || status.status === 'EXPIRED') {
        throw new Error(`Контейнер ${creationId} в статусе ${status.status}: ${status.error_message ?? 'без описания'}`);
      }
      // IN_PROGRESS — продолжаем ждать
    } catch (e) {
      // Если на ранней итерации ещё не видно контейнер — подождём ещё
      if (i >= maxAttempts - 1) throw e;
    }
  }
  throw new Error(`Контейнер ${creationId} не дошёл до FINISHED за ${maxAttempts} попыток`);
}

// Если контейнер оказался PUBLISHED (его опубликовал параллельный вызов),
// мы не знаем post_id напрямую — берём самый свежий пост из ленты.
// Считаем «нашим» только если он младше 5 минут.
async function findRecentPostId(uid: string): Promise<PublishedPost | null> {
  try {
    const resp = await tApi('GET', `/${uid}/threads`, {
      fields: 'id,permalink,timestamp',
      limit: '1',
    });
    const posts = (resp.data ?? []) as Array<{ id: string; permalink?: string; timestamp?: string }>;
    if (posts.length === 0) return null;
    const p = posts[0];
    const ts = Date.parse(p.timestamp ?? '');
    if (Number.isNaN(ts) || Date.now() - ts > 5 * 60 * 1000) return null;
    return { id: p.id, permalink: p.permalink ?? '', timestamp: p.timestamp ?? '' };
  } catch {
    return null;
  }
}

export interface PublishedPost {
  id: string;
  permalink: string;
  timestamp: string;
}

// Описание медиа-вложения для поста
export interface MediaItem {
  type: 'image' | 'video';
  url: string; // публичный URL (Threads сам скачает по нему)
  alt?: string; // alt-текст (не все поля API поддерживают)
}

// Универсальный публикатор — выбирает text / image / video / carousel
// в зависимости от media. text может быть '' для медиа-постов без подписи.
export async function publish(
  text: string,
  media: MediaItem[] = [],
  replyToId?: string
): Promise<PublishedPost> {
  if (media.length === 0) return publishText(text, replyToId);
  if (media.length === 1) {
    return media[0].type === 'image'
      ? publishImage(text, media[0].url, replyToId, media[0].alt)
      : publishVideo(text, media[0].url, replyToId, media[0].alt);
  }
  return publishCarousel(text, media, replyToId);
}

// Публикует пост с одной картинкой.
export async function publishImage(
  text: string,
  imageUrl: string,
  replyToId?: string,
  altText?: string
): Promise<PublishedPost> {
  const uid = userId();
  const createParams: Record<string, string> = {
    media_type: 'IMAGE',
    image_url: imageUrl,
    text,
  };
  if (replyToId) createParams.reply_to_id = replyToId;
  if (altText) createParams.alt_text = altText;

  const container = await tApi('POST', `/${uid}/threads`, createParams);
  return await finalizeContainer(container.id, uid);
}

// Публикует пост с одним видео.
export async function publishVideo(
  text: string,
  videoUrl: string,
  replyToId?: string,
  altText?: string
): Promise<PublishedPost> {
  const uid = userId();
  const createParams: Record<string, string> = {
    media_type: 'VIDEO',
    video_url: videoUrl,
    text,
  };
  if (replyToId) createParams.reply_to_id = replyToId;
  if (altText) createParams.alt_text = altText;

  const container = await tApi('POST', `/${uid}/threads`, createParams);
  // Видео требуется обрабатывать дольше — увеличиваем таймаут ожидания
  return await finalizeContainer(container.id, uid, 30);
}

// Публикует карусель (несколько медиа).
// Алгоритм: создаём дочерние контейнеры с is_carousel_item=true,
// потом основной CAROUSEL-контейнер со списком children, потом публикуем.
export async function publishCarousel(
  text: string,
  media: MediaItem[],
  replyToId?: string
): Promise<PublishedPost> {
  if (media.length < 2) throw new Error('Карусель требует минимум 2 медиа');
  if (media.length > 20) throw new Error('Карусель поддерживает максимум 20 медиа');

  const uid = userId();
  // Шаг 1 — дочерние контейнеры
  const childIds: string[] = [];
  for (const m of media) {
    const params: Record<string, string> = {
      media_type: m.type.toUpperCase(),
      is_carousel_item: 'true',
    };
    if (m.type === 'image') params.image_url = m.url;
    else params.video_url = m.url;
    if (m.alt) params.alt_text = m.alt;

    const child = await tApi('POST', `/${uid}/threads`, params);
    childIds.push(child.id);
  }

  // Шаг 2 — основной CAROUSEL контейнер
  const createParams: Record<string, string> = {
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    text,
  };
  if (replyToId) createParams.reply_to_id = replyToId;

  const container = await tApi('POST', `/${uid}/threads`, createParams);
  // Карусель долгая — ждём дольше
  return await finalizeContainer(container.id, uid, 30);
}

// Общая логика: ждём готовности контейнера → публикуем → возвращаем PublishedPost.
async function finalizeContainer(creationId: string, uid: string, maxAttempts = 15): Promise<PublishedPost> {
  const waitResult = await waitContainerReady(creationId, maxAttempts);
  if (waitResult === 'already_published') {
    const recent = await findRecentPostId(uid);
    if (recent) return recent;
    throw new Error(`Контейнер ${creationId} в статусе PUBLISHED, но в ленте свежего поста нет`);
  }
  const published = await tApi('POST', `/${uid}/threads_publish`, { creation_id: creationId });
  const postId = published.id;
  const details = await tApi('GET', `/${postId}`, { fields: 'id,permalink,timestamp' });
  return {
    id: postId,
    permalink: details.permalink ?? '',
    timestamp: details.timestamp ?? '',
  };
}

// Публикует текстовый пост. Если reply_to_id задан — реплай.
export async function publishText(text: string, replyToId?: string): Promise<PublishedPost> {
  const uid = userId();
  const createParams: Record<string, string> = { media_type: 'TEXT', text };
  if (replyToId) createParams.reply_to_id = replyToId;

  const container = await tApi('POST', `/${uid}/threads`, createParams);
  const creationId = container.id;

  // Ждём пока контейнер станет FINISHED — иначе threads_publish вернёт Media Not Found
  const waitResult = await waitContainerReady(creationId);

  // Контейнер уже опубликован параллельным вызовом — берём свежий пост из ленты
  if (waitResult === 'already_published') {
    const recent = await findRecentPostId(uid);
    if (recent) return recent;
    throw new Error(`Контейнер ${creationId} в статусе PUBLISHED, но в ленте свежего поста нет`);
  }

  const published = await tApi('POST', `/${uid}/threads_publish`, { creation_id: creationId });
  const postId = published.id;

  const details = await tApi('GET', `/${postId}`, { fields: 'id,permalink,timestamp' });
  return {
    id: postId,
    permalink: details.permalink ?? '',
    timestamp: details.timestamp ?? '',
  };
}

export interface ReplyItem {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  permalink?: string;
}

// Получить недавние посты текущего юзера. Используется чтобы найти media_id
// по shortcode из permalink (когда пользователь регистрирует пост, опубликованный
// руками через приложение Threads).
export interface UserPost {
  id: string;
  permalink: string;
  text?: string;
  timestamp: string;
  media_type?: string;
}

export async function listUserPosts(limit = 25): Promise<UserPost[]> {
  const uid = userId();
  const resp = await tApi('GET', `/${uid}/threads`, {
    fields: 'id,permalink,text,timestamp,media_type',
    limit: String(limit),
  });
  return (resp.data ?? []) as UserPost[];
}

// Найти media_id по shortcode из permalink. Permalink выглядит как
// https://www.threads.com/@your-handle/post/DYy53UNlhyD — shortcode = DYy53UNlhyD.
// API ищет среди последних N постов аккаунта.
export async function findPostByPermalink(permalink: string, limit = 50): Promise<UserPost | null> {
  // Извлекаем shortcode
  const m = /\/post\/([A-Za-z0-9_-]+)/.exec(permalink);
  if (!m) return null;
  const shortcode = m[1];

  const posts = await listUserPosts(limit);
  for (const p of posts) {
    const pm = /\/post\/([A-Za-z0-9_-]+)/.exec(p.permalink ?? '');
    if (pm && pm[1] === shortcode) return p;
  }
  return null;
}

// Удалить пост через Threads API. Работает только для постов, опубликованных
// через API, и обычно только в пределах ~24 часов после публикации. Если пост
// старше или не наш — Threads вернёт ошибку, которую мы прокинем выше.
export async function deletePost(postId: string): Promise<void> {
  const url = new URL(`${API_BASE}/${postId}`);
  url.searchParams.set('access_token', token());
  const res = await fetch(url.toString(), { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Threads DELETE /${postId} failed: ${res.status} ${text}`);
  }
}

// Реплаи верхнего уровня под постом
export async function getPostReplies(postId: string, limit = 50): Promise<ReplyItem[]> {
  // Используем /conversation — он возвращает ВСЕ реплаи, включая вложенные.
  // Endpoint /replies с fields has_replies+permalink почему-то режет список
  // (видели: возвращал только 1 реплай, когда в API было 2).
  // Минусы conversation: возвращает и вложенные реплаи к нашим реплаям,
  // поэтому дополнительно фильтруем в watcher'е по username.
  const resp = await tApi('GET', `/${postId}/conversation`, {
    fields: 'id,text,username,timestamp,permalink',
    limit: String(limit),
  });
  return (resp.data ?? []) as ReplyItem[];
}

// Публикует тред: массив текстов → первый пост, затем реплаи цепочкой.
// Возвращает id корневого поста и его permalink.
export async function publishThread(posts: string[]): Promise<PublishedPost> {
  if (posts.length === 0) throw new Error('Пустой список постов');

  const first = await publishText(posts[0]);
  let prevId = first.id;

  for (let i = 1; i < posts.length; i++) {
    // Пауза между последовательными публикациями — защищаемся от rate-limit
    await sleep(5000);
    const reply = await publishText(posts[i], prevId);
    prevId = reply.id;
  }

  return first;
}

// Reply-bait — публикация авторского комментария к последнему посту треда.
// В serverless важно НЕ ждать 10 минут в одной функции (timeout у Vercel — 60с/300с).
// Поэтому bait публикуется сразу, с короткой паузой.
export async function publishReplyBait(rootPostId: string, baitText: string): Promise<PublishedPost> {
  // Находим последний пост в цепочке: для упрощения — прикрепляем bait к корню.
  // Threads показывает его как верхний коммент к треду.
  return publishText(baitText, rootPostId);
}

// Последний пост в цепочке реплаев, связанных с корнем —
// нужен чтобы повесить bait на хвост, а не на корень.
export async function findTailOfThread(rootPostId: string): Promise<string> {
  // Получаем conversation — всё дерево под постом (включая наши собственные реплаи).
  const resp = await tApi('GET', `/${rootPostId}/conversation`, {
    fields: 'id,text,username,timestamp,replied_to',
    limit: '50',
  });
  const data = (resp.data ?? []) as Array<{ id: string; username?: string; replied_to?: { id: string } }>;

  // Ищем пост, у которого никто не замечен как replied_to
  const repliedToIds = new Set(data.map((d) => d.replied_to?.id).filter(Boolean) as string[]);
  const myUsername = process.env.THREADS_USERNAME; // например, your-brand-handle

  // Подходит последний пост от нашего аккаунта, на который никто не отвечал
  const candidates = data
    .filter((d) => !repliedToIds.has(d.id))
    .filter((d) => !myUsername || d.username === myUsername);

  if (candidates.length === 0) return rootPostId;
  // Возвращаем самый свежий (API отдаёт в обратном хронологическом порядке — первый)
  return candidates[0].id;
}
