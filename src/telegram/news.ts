import type { BotSession } from "./session.js";
import { button, keyboard } from "./options.js";
export async function handleNews(
  session: BotSession,
  args: string[],
  expected?: number,
) {
  const { context: c, chatId, userId, reply } = session;
  if (session.isPrivate) {
    await reply("📰 Le news sono disponibili soltanto nei gruppi.");
    return;
  }
  const action = args[0]?.toLowerCase();
  if (
    args.length > 1 ||
    (action !== undefined && action !== "on" && action !== "off")
  ) {
    await reply("Uso: /news oppure /news on o /news off.");
    return;
  }
  let access;
  try {
    access = await c.telegram.getGroupAccess(chatId, userId);
  } catch {
    await reply(
      "Non riesco a verificare i permessi del gruppo. Riprova tra poco.",
    );
    return;
  }
  if (!access.isGroup) {
    await reply("📰 Le news sono disponibili soltanto nei gruppi.");
    return;
  }
  if (action) {
    if (session.message?.sender_chat) {
      await reply(
        "Per cambiare le news, invia il comando con il tuo profilo amministratore.",
      );
      return;
    }
    if (!access.botCanSend) {
      await reply(
        "Per gestire le news, rendi il bot amministratore del gruppo.",
      );
      return;
    }
    if (!access.userIsAdmin) {
      await reply(
        "Soltanto gli amministratori del gruppo possono cambiare le news.",
      );
      return;
    }
    const result = await c.news.setEnabled(
      chatId,
      access.chatType!,
      action === "on",
      c.now(),
      session.update.update_id,
      expected,
      session.receivedAt,
    );
    if (result === "capacity") {
      await reply("È stato raggiunto il limite di 10 gruppi con news attive.");
      return;
    }
    if (result === "stale") {
      await reply(
        "Questa selezione è superata. Riapri /news per vedere lo stato attuale.",
      );
      return;
    }
  }
  const group = await c.news.group(chatId);
  const paused =
    c.env.NEWS_ENABLED !== "true" || c.env.SCANS_ENABLED === "false";
  await reply(
    `📰 <b>News ${group.enabled ? "attive" : "disattivate"} in questo gruppo</b>\nVideogiochi, film, anime e manga in italiano.\nSingole notizie, massimo 3 all’ora per gruppo.${paused ? "\nIl servizio news è momentaneamente in pausa." : ""}${!access.botCanSend ? "\nRendi il bot amministratore per gestire le news." : ""}`,
    access.userIsAdmin && access.botCanSend
      ? keyboard([
          [
            button(
              group.enabled ? "Disattiva news" : "Attiva news",
              `news|${group.enabled ? "off" : "on"}|${group.revision}`,
            ),
          ],
        ])
      : undefined,
  );
}
export async function handleNewsCallback(session: BotSession) {
  try {
    await session.context.telegram.answerCallback(session.callback!.id);
  } catch {
    /* Noncritical acknowledgement. */
  }
  const parts = session.callback!.data?.split("|") ?? [];
  if (
    parts.length !== 3 ||
    !["on", "off"].includes(parts[1]) ||
    !/^\d+$/.test(parts[2]) ||
    !Number.isSafeInteger(Number(parts[2]))
  )
    return;
  await handleNews(session, [parts[1]], Number(parts[2]));
}
