import type { BotSession } from "./session.js";
import type { Preferences } from "../domain/models.js";
import { toCents } from "../domain/pricing.js";
import { HELP } from "./help.js";
import {
  formatExpiry,
  formatGiveaway,
  quoteText,
  money,
} from "./formatters.js";
import {
  SHOPS,
  SHOP_IDS,
  PAGE_SIZE,
  UUID,
  PRIVATE_COMMANDS,
  COMMANDS,
  html,
  button,
  keyboard,
  cancel,
  number,
  percent,
  priceArg,
  best,
} from "./options.js";
export async function handleCommand(session: BotSession): Promise<void> {
  const {
    context,
    update,
    callback,
    message,
    userId,
    chatId,
    username,
    isPrivate,
    reply,
    privateOnly,
    showPrices,
    wishlistPage,
  } = session;
  const match = /^\/([a-z_]+)(?:@[\w]+)?(?:\s+(.*))?$/is.exec(
    message?.text?.trim() ?? "",
  );
  if (!match) return;
  const command = match[1].toLowerCase(),
    args = match[2]?.trim().split(/\s+/) ?? [];
  if (!COMMANDS.has(command)) return;
  if (PRIVATE_COMMANDS.has(command) && !isPrivate) {
    await privateOnly();
    return;
  }
  if (command === "start" || command === "help") {
    await reply(HELP);
    return;
  }
  if (command === "status") {
    const status = await context.settings.status();
    await reply(
      `Scansione giochi gratuiti: ${status.lastGiveawayScan === null ? "in attesa" : `${formatExpiry(status.lastGiveawayScan)} (Italia)`}\nScansione wishlist: ${status.lastPriceScan === null ? "in attesa" : `${formatExpiry(status.lastPriceScan)} (Italia)`}\nControllo ogni 30 minuti.`,
    );
    return;
  }
  if (command === "deals") {
    const offers = await context.giveaways.getGiveaways();
    if (!offers.length)
      await reply(
        "😔 Nessun gioco completo gratuito da riscattare al momento.",
      );
    else for (const offer of offers) await reply(formatGiveaway(offer));
    return;
  }
  if (["cerca", "add", "confronta"].includes(command)) {
    if (!args.length) {
      await reply(`❌ Uso: /${command} &lt;titolo del gioco&gt;`);
      return;
    }
    const results = await context.itad.searchGames(args.join(" "));
    if (!results.length) {
      await reply("😔 Nessun gioco completo trovato.");
      return;
    }
    if (command === "confronta") {
      await showPrices(results[0], true);
      return;
    }
    const action = command === "add" ? "addwish" : "price";
    await reply(
      command === "add"
        ? "Quale gioco vuoi aggiungere alla wishlist?"
        : "Seleziona il gioco per vedere i prezzi:",
      keyboard([
        ...results.map((game) => [button(game.title, `${action}|${game.id}`)]),
        cancel,
      ]),
    );
    return;
  }
  if (
    command === "wishlist" ||
    command === "remove" ||
    command === "setscontog"
  ) {
    await wishlistPage(
      command === "wishlist"
        ? "wishlist"
        : command === "remove"
          ? "remove"
          : "discount",
    );
    return;
  }
  const prefs = isPrivate
    ? await context.preferences.getPrefs(userId)
    : { thresholdCents: 500, minCut: 0, minScore: 0, minDiscountPct: 10 };
  if (command === "setsconto") {
    if (!args.length) {
      await reply(
        `🔔 Soglia globale: <b>${prefs.minDiscountPct}%</b> di ulteriore ribasso rispetto all’ultima notifica consegnata. Cambiala con /setsconto &lt;10-99&gt;.`,
      );
      return;
    }
    const pct = percent(args[0], 10, 99);
    if (pct === null || args.length !== 1) {
      await reply("❌ Uso: /setsconto &lt;10-99&gt;. Il minimo è 10%.");
      return;
    }
    await context.preferences.setPrefs(userId, username, {
      minDiscountPct: pct,
    });
    await reply(
      `✅ Soglia globale impostata a <b>${pct}%</b> di ulteriore ribasso.`,
    );
    return;
  }
  if (command === "setsoglia") {
    if (!args.length) {
      await reply(
        `⚙️ Preferenze offerte:\nPrezzo massimo: <b>${money(prefs.thresholdCents)}</b>\nSconto minimo: ${prefs.minCut}%\nReview minima: ${prefs.minScore}\n/setsoglia prezzo|sconto|review &lt;valore&gt;`,
      );
      return;
    }
    const field = args[0].toLowerCase(),
      value = field === "prezzo" ? priceArg(args[1]) : percent(args[1]);
    if (
      args.length !== 2 ||
      value === null ||
      !["prezzo", "sconto", "review"].includes(field) ||
      (field === "prezzo" && (value <= 0 || value > 10000))
    ) {
      await reply(
        "❌ Uso: /setsoglia prezzo|sconto|review &lt;valore&gt;. Prezzo: 0-100€, percentuali: 0-100.",
      );
      return;
    }
    const patch: Partial<Preferences> =
      field === "prezzo"
        ? { thresholdCents: value }
        : field === "sconto"
          ? { minCut: value }
          : { minScore: value };
    await context.preferences.setPrefs(userId, username, patch);
    await reply(
      `✅ Filtro ${field} aggiornato: ${field === "prezzo" ? money(value) : value}.`,
    );
    return;
  }

  let maximum = prefs.thresholdCents,
    minimum = 0,
    minCut = prefs.minCut,
    minScore = prefs.minScore,
    limit = command === "offerte" ? 5 : 10;
  let shopIds: number[] | undefined;
  if (command === "offerte") {
    if (
      args.length > 3 ||
      (args[0] && (priceArg(args[0]) === null || priceArg(args[0])! <= 0)) ||
      (args[1] && percent(args[1]) === null) ||
      (args[2] && percent(args[2]) === null)
    ) {
      await reply(
        "❌ Uso: /offerte [prezzo] [sconto%] [score]. Es: /offerte 10 50 70",
      );
      return;
    }
    maximum = args[0] ? priceArg(args[0])! : maximum;
    minCut = args[1] ? percent(args[1])! : minCut;
    minScore = args[2] ? percent(args[2])! : minScore;
  } else {
    const tokens = args.slice();
    if (tokens[0] && /\d/.test(tokens[0])) {
      const range = tokens.shift()!.replace(",", ".").split("-");
      const left = toCents(range[0]),
        right = range.length === 2 ? toCents(range[1]) : left;
      if (
        range.length > 2 ||
        left === null ||
        right === null ||
        right <= 0 ||
        (range.length === 2 && left > right)
      ) {
        await reply(
          "❌ Range prezzo non valido. Es: /offerte_shop 5-20 steam,gog",
        );
        return;
      }
      minimum = range.length === 2 ? left : 0;
      maximum = right;
    }
    if (tokens[0] && /^\d+$/.test(tokens[0]))
      limit = Math.max(1, Math.min(30, Number(tokens.shift())));
    shopIds = SHOP_IDS;
    if (tokens.length) {
      const text = tokens.join(" ").toLowerCase().replace(/,/g, " ");
      let remaining = text;
      const ids = new Set<number>();
      for (const name of Object.keys(SHOPS).sort(
        (a, b) => b.length - a.length,
      )) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "g");
        if (pattern.test(remaining)) {
          ids.add(SHOPS[name]);
          remaining = remaining.replace(pattern, " ");
        }
      }
      if (remaining.trim() || !ids.size) {
        await reply(
          "❌ Negozio non riconosciuto. Es: steam,gog,epic,fanatical",
        );
        return;
      }
      shopIds = [...ids];
    }
  }
  const deals = await context.itad.getDeals({
    maxPriceCents: maximum,
    minPriceCents: minimum,
    minCut,
    minScore,
    limit,
    shopIds,
  });
  if (!deals.length) {
    await reply("😔 Nessuna offerta trovata con questi filtri.");
    return;
  }
  if (command === "offerte_shop")
    deals.sort(
      (a, b) =>
        b.quote.cut - a.quote.cut || a.quote.priceCents - b.quote.priceCents,
    );
  for (const deal of deals)
    await reply(
      `🎮 <b>${html(deal.game.title)}</b>\n${quoteText(deal.quote)}${deal.steamScore === null ? "" : `\n⭐ Review Steam: ${deal.steamScore}%`}`,
    );
}
