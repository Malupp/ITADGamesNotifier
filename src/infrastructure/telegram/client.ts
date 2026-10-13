import { request, ApiError } from "../http.js";
/** API contract: https://core.telegram.org/bots/api */
export class TelegramClient {
  private botId?: number;
  constructor(
    private token: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async call(
    method: string,
    body: Record<string, unknown>,
  ): Promise<any> {
    const response = await request(
      this.fetcher,
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      true,
    );
    return (response as any)?.result;
  }
  async getGroupAccess(chatId: string, userId?: string) {
    const chat = await this.call('getChat', {chat_id:chatId});
    if (String(chat?.id)!==chatId || !['private','channel','group','supergroup'].includes(chat?.type)) throw new ApiError(502);
    const isGroup = chat.type==='group' || chat.type==='supergroup';
    if (!isGroup) return {isGroup:false,botCanSend:false,userIsAdmin:false,chatType:null};
    if (this.botId===undefined) {
      const bot = await this.call('getMe', {});
      if (!Number.isSafeInteger(bot?.id) || bot.id<=0 || bot.is_bot!==true) throw new ApiError(502);
      this.botId=bot.id;
    }
    const member = async (id:number) => {
      const result = await this.call('getChatMember', {chat_id:chatId,user_id:id});
      if (result?.user?.id!==id || !['creator','administrator','member','restricted','left','kicked'].includes(result?.status)) throw new ApiError(502);
      return result;
    };
    const bot = await member(this.botId!);
    // Telegram guarantees checking other members only when the bot is an administrator.
    const botCanSend=bot.status==='administrator' || bot.status==='creator';
    let userIsAdmin=false;
    if (botCanSend && userId!==undefined) {
      const id=Number(userId); if(!Number.isSafeInteger(id)||id<=0) throw new ApiError(502);
      const user=await member(id);
      userIsAdmin=user.user.is_bot!==true && (user.status==='administrator'||user.status==='creator');
    }
    return {isGroup:true,botCanSend,userIsAdmin,chatType:chat.type as 'group'|'supergroup'};
  }
  async getChatType(chatId: string): Promise<"private" | "channel" | "group" | "supergroup"> {
    const chat = await this.call("getChat", { chat_id: chatId });
    const matches = String(chat?.id) === chatId ||
      (/^@[a-z0-9_]+$/i.test(chatId) && typeof chat?.username === "string" &&
        chat.username.toLowerCase() === chatId.slice(1).toLowerCase());
    if (!Number.isSafeInteger(chat?.id) || !matches ||
      !["private", "channel", "group", "supergroup"].includes(chat?.type)) throw new ApiError(502);
    return chat.type;
  }
  async sendPhoto(chatId: string,caption: string,photo: string,replyMarkup?: unknown): Promise<void> {
    await this.call("sendPhoto", {
      chat_id: chatId, photo, caption, parse_mode: "HTML",
      ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
    });
  }
  async editPhoto(chatId: string, messageId: number, caption: string, photo: string, replyMarkup?: unknown): Promise<void> {
    await this.call("editMessageMedia", {
      chat_id: chatId, message_id: messageId,
      media: { type: "photo", media: photo, caption, parse_mode: "HTML" },
      ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
    });
  }
  async editCaption(chatId: string, messageId: number, caption: string, replyMarkup?: unknown): Promise<void> {
    await this.call("editMessageCaption", {
      chat_id: chatId, message_id: messageId, caption, parse_mode: "HTML",
      ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
    });
  }
  async sendIllustrated(
    chatId: string, text: string, photo?: string | null, previewUrl?: string, replyMarkup?: unknown,
  ): Promise<void> {
    if (photo) {
      try {
        await this.sendPhoto(chatId, text, photo, replyMarkup);
        return;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 400) throw error;
      }
    }
    await this.sendMessage(chatId, text, replyMarkup, previewUrl);
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
    previewUrl?: string,
  ): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      link_preview_options: previewUrl
        ? { is_disabled: false, url: previewUrl, prefer_large_media: true }
        : { is_disabled: true },
      ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
    });
  }
}
