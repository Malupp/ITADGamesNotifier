import type { BotSession } from "./session.js";
import { button, keyboard } from "./options.js";
export async function showNotifications(session: BotSession) {
  if (!session.isPrivate) return;
  const c = session.context;
  const prefs = await c.preferences.notifications(session.userId);
  const news = await c.news.subscriber(session.chatId);
  await session.reply(`🔔 <b>Le tue notifiche</b>\n\n📋 Wishlist: segui i ribassi dei giochi aggiunti con /add.\n📰 News: ${news.enabled?"attive":"disattivate"}.\n🔑 Affari giochi recenti: ${prefs.enabled?"attivi":"disattivati"}.\n\nGli affari recenti riguardano giochi del 2026/2027. Sono indipendenti dalla wishlist. Puoi cambiare queste preferenze quando vuoi.`,keyboard([
    [button(news.enabled?"Disattiva news":"Attiva news",`news|${news.enabled?"off":"on"}|${news.revision}`)],
    [button(prefs.enabled?"Disattiva affari recenti":"Attiva affari recenti",`recent|${prefs.enabled?"off":"on"}|${prefs.revision}`)],
  ]));
}
export async function handleRecentCallback(session: BotSession) {
  if (!session.isPrivate) return;
  const parts = session.callback!.data?.split("|") ?? [];
  try {
    await session.context.telegram.answerCallback(session.callback!.id);
  } catch {
    /* Noncritical acknowledgement. */
  }
  if (
    parts.length !== 3 || !["on", "off"].includes(parts[1]) ||
    !/^\d+$/.test(parts[2]) || !Number.isSafeInteger(Number(parts[2]))
  ) return;
  const changed = await session.context.preferences.setRecentDeals(
    session.userId, parts[1] === "on", session.context.now(),
    session.update.update_id, session.receivedAt, Number(parts[2]),
  );
  if (!changed) {
    await session.reply("Questa selezione è superata. Riapri /notifiche per vedere lo stato attuale.");
    return;
  }
  await showNotifications(session);
}
