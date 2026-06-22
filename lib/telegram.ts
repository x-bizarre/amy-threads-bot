// Отправка и редактирование сообщений через Telegram-бота.
// Используется и watcher'ом (новые комменты с кнопками) и webhook'ом (ответы на действия).

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type InlineKeyboard = InlineKeyboardButton[][];

async function tg(method: string, body: Record<string, any>): Promise<any> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (!res.ok || !data.ok) {
    console.error(`Telegram ${method} failed:`, data);
    throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
  }
  return data.result;
}

export interface SendOpts {
  parseMode?: 'HTML' | 'Markdown';
  disablePreview?: boolean;
  inlineKeyboard?: InlineKeyboard;
  replyToMessageId?: number;
}

export async function sendTelegram(text: string, opts: SendOpts = {}): Promise<{ message_id: number }> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID не задан');

  const body: Record<string, any> = {
    chat_id: chatId,
    text,
    parse_mode: opts.parseMode ?? 'HTML',
    disable_web_page_preview: opts.disablePreview ?? false,
  };
  if (opts.inlineKeyboard) body.reply_markup = { inline_keyboard: opts.inlineKeyboard };
  if (opts.replyToMessageId) body.reply_to_message_id = opts.replyToMessageId;

  return await tg('sendMessage', body);
}

// Редактирование текста сообщения (после того как ты нажала кнопку — заменяем клавиатуру на статус).
export async function editMessageText(
  messageId: number,
  text: string,
  opts: { parseMode?: 'HTML' | 'Markdown'; inlineKeyboard?: InlineKeyboard } = {}
): Promise<void> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID не задан');
  const body: Record<string, any> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: opts.parseMode ?? 'HTML',
    disable_web_page_preview: true,
  };
  if (opts.inlineKeyboard) body.reply_markup = { inline_keyboard: opts.inlineKeyboard };
  await tg('editMessageText', body);
}

// Ответ на callback query — убирает "крутилку" на кнопке.
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await tg('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text ?? '',
  });
}

export async function setWebhook(url: string, secretToken?: string): Promise<void> {
  const body: Record<string, any> = {
    url,
    allowed_updates: ['message', 'callback_query'],
  };
  // Telegram не принимает пустой secret_token — поле шлём только если он задан.
  if (secretToken) body.secret_token = secretToken;
  await tg('setWebhook', body);
}
