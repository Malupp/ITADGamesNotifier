import { showNotifications } from "./notifications.js";
import type { BotSession } from "./session.js";
import { button, keyboard } from "./options.js";
export async function handleNews(
  session: BotSession, args: string[], expected?: number, panel = false,
) {
  if (!session.isPrivate) return;
  const { context: c, chatId, reply } = session;
  const action = args[0]?.toLowerCase();
  if (args.length > 1 || (action !== undefined && action !== "on" && action !== "off")) {
    await reply("Uso: /news oppure /news on o /news off.");
    return;
  }
  if (action) {
    const result = await c.news.setEnabled(
      chatId, "private", action === "on", c.now(), session.update.update_id,
      expected, session.receivedAt,
    );
    if (result === "capacity") {
      await reply("È stato raggiunto il limite di 10 utenti con news attive.");
      return;
    }
    if (result === "stale") {
      await reply("Questa selezione è superata. Riapri /news per vedere lo stato attuale.");
      return;
    }
  }
  if (panel) {
    await showNotifications(session);
    return;
  }
  const subscriber = await c.news.subscriber(chatId);
  const paused = c.env.NEWS_ENABLED !== "true" || c.env.SCANS_ENABLED === "false";
  await reply(`📰 <b>News ${subscriber.enabled ? "attive" : "disattivate"}</b>\n\nVideogiochi, film, anime e manga in italiano, nella tua chat privata.\nTitolo, estratto della fonte, immagine quando disponibile e link. Massimo 3 tentativi di invio all’ora.${paused?"\nIl servizio news è momentaneamente in pausa.":""}`,keyboard([[button(subscriber.enabled?"Disattiva news":"Attiva news",`news|${subscriber.enabled?"off":"on"}|${subscriber.revision}`)]]));
}
export async function handleNewsCallback(session: BotSession) {
  if (!session.isPrivate) return;
  try {
    await session.context.telegram.answerCallback(session.callback!.id);
  } catch {
    /* Noncritical acknowledgement. */
  }
  const parts = session.callback!.data?.split("|") ?? [];
  if (
    parts.length !== 3 || !["on", "off"].includes(parts[1]) ||
    !/^\d+$/.test(parts[2]) || !Number.isSafeInteger(Number(parts[2]))
  ) return;
  await handleNews(session, [parts[1]], Number(parts[2]), true);
}
