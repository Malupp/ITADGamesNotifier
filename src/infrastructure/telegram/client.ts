import { request } from "../http.js";
/** API contract: https://core.telegram.org/bots/api */
export class TelegramClient {
  constructor(
    private token: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async call(
    method: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await request(
      this.fetcher,
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      true,
    );
  }
  async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: unknown,
    previewUrl?: string,
  ): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: previewUrl
        ? { is_disabled: false, url: previewUrl, prefer_large_media: true }
        : { is_disabled: true },
      ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
    });
  }
  async answerCallback(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: id,
      ...(text === undefined ? {} : { text }),
    });
  }
  async editMessage(
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: unknown,
  ): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
    });
  }
}
