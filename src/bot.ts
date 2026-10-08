import type { Env, Game, Preferences, PriceQuote, TelegramUpdate } from './types.js';
import { ApiError, ItadClient, TelegramClient } from './clients.js';
import { escapeHtml, formatExpiry, formatGiveaway, money, safeUrl, toCents } from './domain.js';
import { Store } from './store.js';

const SHOPS: Record<string, number> = {
  fanatical: 6, 'epic games store': 16, epic: 16, gamersgate: 24, gog: 35, greenmangaming: 36,
  'humble store': 37, humble: 37, indiegala: 42, 'microsoft store': 48, microsoft: 48,
  'ea store': 52, ea: 52, steam: 61, 'ubisoft store': 62, ubisoft: 62, wingamestore: 64,
};
const SHOP_IDS = [6, 16, 24, 35, 36, 37, 42, 48, 52, 61, 62, 64];
const PAGE_SIZE = 10;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const PRIVATE_COMMANDS = new Set(['add', 'remove', 'wishlist', 'setsoglia', 'setsconto', 'setscontog']);
const COMMANDS = new Set(['start', 'help', 'deals', 'cerca', 'add', 'remove', 'wishlist', 'offerte', 'offerte_shop', 'confronta', 'setsoglia', 'setsconto', 'setscontog', 'status']);
const html = (text: unknown, maximum = 240) => escapeHtml(String(text ?? '').slice(0, maximum));
const button = (text: string, data: string) => ({ text: text.slice(0, 60), callback_data: data });
const keyboard = (rows: ReturnType<typeof button>[][]) => ({ inline_keyboard: rows });
const cancel = [button('❌ Annulla', 'cancel')];
const number = (text: string | undefined): number | null => text && /^\d+$/.test(text) ? Number(text) : null;
const percent = (text: string | undefined, minimum = 0, maximum = 100): number | null => {
  const value = number(text); return value !== null && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
};
const priceArg = (text: string | undefined): number | null => text ? toCents(text.replace(',', '.')) : null;
const best = (quotes: PriceQuote[] | undefined) => quotes?.slice().sort((a, b) => a.priceCents - b.priceCents)[0] ?? null;
function quoteText(quote: PriceQuote): string {
  const url = safeUrl(quote.url);
  const price = quote.priceCents === 0 ? 'GRATIS' : money(quote.priceCents);
  return `🏪 ${html(quote.shop, 100)} — <b>${price}</b>` + (quote.cut > 0 ? ` (-${quote.cut}%)` : '') +
    (url && url.length <= 2048 ? `\n🔗 <a href="${escapeHtml(url)}">Vedi l'offerta</a>` : '') +
    (quote.expiry === null ? '' : `\n⏳ Scade il ${formatExpiry(quote.expiry)} (Italia)`);
}
const HELP = `👋 <b>Benvenuto! Giochi PC gratis e prezzi sotto controllo</b>

Ti aiuto a trovare giochi completi da riscattare gratis e a seguire i ribassi dei giochi che desideri. Prezzi in euro per l'Italia; orari e scadenze nel fuso italiano.

🎁 <b>Giochi gratis da tenere</b>
/deals — mostra le promozioni gratuite attive verificate.
Controllo IsThereAnyDeal e confermo la promozione sul negozio ufficiale: al momento la verifica automatica copre Epic Games Store e Steam. Escludo DLC, demo, weekend gratuiti, free-to-play permanenti e offerte che richiedono abbonamenti a pagamento.
Apri il link e riscatta il gioco prima della scadenza: il bot non lo riscatta per te. Gli avvisi gratuiti arrivano nelle chat configurate.

📋 <b>La tua wishlist · in chat privata</b>
/add &lt;titolo&gt; — cerca un gioco, poi premi il pulsante per aggiungerlo.
/wishlist — mostra i tuoi giochi con i prezzi attuali; usa i pulsanti per cambiare pagina.
/remove — scegli con un pulsante il gioco da rimuovere.
Per iniziare, prova <code>/add Hollow Knight</code>.

🔔 <b>Quando ricevi un avviso</b>
Controllo ogni 30 minuti. Per la wishlist invio un avviso solo se c'è un effettivo sconto e almeno il 10% di ulteriore ribasso rispetto all'ultima notifica consegnata, oppure al prezzo iniziale se non hai ancora ricevuto avvisi.
Esempio con soglia 10%: 10€ → 9€: avviso; 9€ → 8,90€: nessun avviso; 9€ → 8,10€: nuovo avviso. Lo sconto sul prezzo di listino è un dato distinto da questa soglia.
L'aggiunta e il recupero della wishlist registrano il riferimento senza una raffica di avvisi; se manca il prezzo, attendo la prima osservazione valida. Gli avvisi wishlist arrivano nella tua chat privata. Ricontrollo l'offerta prima dell'invio e ritento gli invii falliti: in casi rari può arrivare un duplicato.

⚙️ <b>Personalizza gli avvisi · in chat privata</b>
/setsconto — mostra la soglia globale della wishlist.
<code>/setsconto 20</code> — richiedi almeno un ulteriore ribasso del 20% (valori 10–99).
/setscontog — scegli una soglia per un singolo gioco o ripristina quella globale.

🔎 <b>Cerca e confronta</b>
/cerca &lt;titolo&gt; — scegli il gioco e visualizza i prezzi disponibili.
/confronta &lt;titolo&gt; — confronta i negozi monitorati per il primo gioco trovato; usa un titolo preciso.
/offerte [prezzo] [sconto%] [score] — cerca offerte a pagamento con questi filtri.
<code>/offerte 10 50 70</code>: massimo 10€, sconto sul listino almeno 50%, recensioni positive Steam almeno 70%.
/offerte_shop [prezzo o range] [numero] [shop...] — filtra anche per negozio.
<code>/offerte_shop 5-20 10 steam,gog</code>: fino a 10 risultati tra 5€ e 20€ su Steam e GOG. Puoi usare anche epic, fanatical, humble e gli altri negozi monitorati.

🛠 <b>Filtri delle ricerche · in chat privata</b>
/setsoglia — mostra i filtri salvati, usati quando ometti gli argomenti.
Esempi: <code>/setsoglia prezzo 10</code>, <code>/setsoglia sconto 50</code>, <code>/setsoglia review 70</code>.
Questi filtri riguardano le ricerche di offerte; le soglie degli avvisi wishlist si impostano con /setsconto e /setscontog.

ℹ️ /status — ultime scansioni completate.
/start o /help — riapri questa guida.`;

/** Replies remain in D1 until the delivery consumer confirms Telegram accepted them. */
export async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const callback = update.callback_query, message = update.message;
  const user = callback?.from ?? message?.from;
  const chat = callback?.message?.chat ?? message?.chat;
  if (!user || !chat) return;
  const userId = String(user.id), chatId = String(chat.id), username = user.username ?? user.first_name ?? null;
  const isPrivate = chat.id === user.id && (!message || message.chat.type === undefined || message.chat.type === 'private');
  const store = new Store(env.DB), itad = new ItadClient(env.ITAD_API_KEY);
  let ordinal = 0;
  const reply = (text: string, markup?: unknown) => store.queueMessage(`reply:${update.update_id}:${ordinal++}`, chatId, text, markup);
  const privateOnly = () => reply('🔒 Gestisci wishlist e preferenze nella chat privata con il bot.');

  async function showPrices(game: Game, trackedOnly = false) {
    let quotes = (await itad.getPrices([game.id])).get(game.id) ?? [];
    if (trackedOnly) quotes = quotes.filter(quote => SHOP_IDS.includes(quote.shopId));
    quotes.sort((a, b) => a.priceCents - b.priceCents);
    if (!quotes.length) { await reply(`😔 Nessun prezzo disponibile per <b>${html(game.title)}</b>.`); return; }
    for (const quote of quotes.slice(0, 8)) await reply(`🎮 <b>${html(game.title)}</b>\n${quoteText(quote)}`);
  }
  async function wishlistPage(mode: 'wishlist' | 'remove' | 'discount', offset = 0) {
    const items = await store.getWishlist(userId);
    if (!items.length) { await reply('📋 La tua wishlist è vuota. Usa /add &lt;titolo&gt; per aggiungere giochi.'); return; }
    const page = items.slice(offset, offset + PAGE_SIZE);
    if (!page.length) { await reply('Pagina non disponibile. Riapri /wishlist.'); return; }
    const rows: ReturnType<typeof button>[][] = [];
    if (mode === 'wishlist') {
      const prices = await itad.getPrices(page.map(item => item.game_id));
      for (const item of page) {
        const quote = best(prices.get(item.game_id));
        await reply(`🎮 <b>${html(item.title)}</b>\n${quote ? quoteText(quote) : 'Prezzo non disponibile.'}`);
      }
    } else for (const item of page) {
      rows.push([button(mode === 'remove' ? `❌ ${item.title}` : `${item.title} (${item.min_discount_pct ?? 'globale'}${item.min_discount_pct === null ? '' : '%'})`,
        `${mode === 'remove' ? 'remwish' : 'setscontog'}|${item.game_id}`)]);
    }
    const prefix = mode === 'wishlist' ? 'wishlistpage' : mode === 'remove' ? 'rempage' : 'discpage';
    const navigation: ReturnType<typeof button>[] = [];
    if (offset > 0) navigation.push(button('◀️ Indietro', `${prefix}|${Math.max(0, offset - PAGE_SIZE)}`));
    if (offset + PAGE_SIZE < items.length) navigation.push(button('Altri giochi ▶️', `${prefix}|${offset + PAGE_SIZE}`));
    if (navigation.length) rows.push(navigation);
    if (mode !== 'wishlist') rows.push(cancel);
    await reply(mode === 'wishlist' ? `📋 Wishlist: ${offset + 1}-${offset + page.length} di ${items.length}. Usa /remove per rimuovere un gioco.` :
      mode === 'remove' ? 'Seleziona il gioco da rimuovere:' : 'Seleziona il gioco per impostare il ribasso minimo:', rows.length ? keyboard(rows) : undefined);
  }

  if (callback) {
    // Expired callback acknowledgements never prevent an otherwise valid operation.
    try { await new TelegramClient(env.TELEGRAM_BOT_TOKEN).answerCallback(callback.id); } catch { /* noncritical */ }
    const [action, gameId, value] = (callback.data ?? '').split('|');
    if (action === 'cancel') { await reply('✅ Operazione annullata.'); return; }
    if (['wishlistpage', 'rempage', 'discpage'].includes(action)) {
      if (!isPrivate) { await privateOnly(); return; }
      const offset = number(gameId);
      if (offset === null || !Number.isSafeInteger(offset) || offset < 0) return;
      await wishlistPage(action === 'wishlistpage' ? 'wishlist' : action === 'rempage' ? 'remove' : 'discount', offset); return;
    }
    if (!['price', 'addwish', 'remwish', 'setscontog', 'setscontog_apply'].includes(action)) return;
    if (action !== 'price' && !isPrivate) { await privateOnly(); return; }
    if (!gameId || !UUID.test(gameId)) { await reply('❌ Selezione scaduta o non valida. Riprova /cerca, /add o /setscontog.'); return; }
    if (action === 'price' || action === 'addwish') {
      const game = await itad.getGameInfo(gameId);
      if (!game || game.id !== gameId) { await reply('❌ Gioco completo non trovato. Riprova /cerca o /add.'); return; }
      if (action === 'price') { await showPrices(game); return; }
      let quote: PriceQuote | null = null;
      try { quote = best((await itad.getPrices([gameId])).get(gameId)); } catch (error) { if (!(error instanceof ApiError)) throw error; }
      const added = await store.addWishlist(userId, username, game, quote);
      const already = !added && (await store.getWishlist(userId)).some(item=>item.game_id===game.id);
      await reply(added ? `✅ <b>${html(game.title)}</b> aggiunto alla wishlist${quote ? ` (${money(quote.priceCents)})` : ''}.\nControllo ogni 30 minuti; il prezzo iniziale viene registrato senza notifiche.` : already ? `ℹ️ <b>${html(game.title)}</b> è già nella tua wishlist.` : 'ℹ️ Capacità raggiunta: il servizio gratuito monitora fino a 200 giochi distinti. Rimuovi un gioco prima di aggiungerne uno nuovo.'); return;
    }
    const item = (await store.getWishlist(userId)).find(item => item.game_id === gameId);
    if (!item) { await reply('❌ Gioco non trovato nella tua wishlist.'); return; }
    if (action === 'remwish') {
      await store.removeWishlist(userId, gameId); await reply(`✅ <b>${html(item.title)}</b> rimosso dalla wishlist.`); return;
    }
    if (action === 'setscontog') {
      const rows = [[button('🌐 Usa soglia globale', `setscontog_apply|${gameId}|None`)]];
      for (const values of [[10, 20, 30], [40, 50, 60], [70, 75, 80]]) rows.push(values.map(pct => button(`${pct}%`, `setscontog_apply|${gameId}|${pct}`)));
      rows.push(cancel);
      await reply(`🎮 <b>${html(item.title)}</b>\nSoglia attuale: ${item.min_discount_pct === null ? 'globale' : `${item.min_discount_pct}%`}. Scegli il ribasso:`, keyboard(rows)); return;
    }
    const pct = value === 'None' ? null : percent(value, 10, 99);
    if (value !== 'None' && pct === null) { await reply('❌ La soglia deve essere fra 10% e 99%.'); return; }
    await store.setWishlistDiscount(userId, gameId, pct);
    await reply(`✅ <b>${html(item.title)}</b>: ${pct === null ? 'usa la soglia globale' : `ribasso minimo ${pct}% rispetto all’ultima notifica consegnata`}.`); return;
  }

  const match = /^\/([a-z_]+)(?:@[\w]+)?(?:\s+(.*))?$/is.exec(message?.text?.trim() ?? '');
  if (!match) return;
  const command = match[1].toLowerCase(), args = match[2]?.trim().split(/\s+/) ?? [];
  if (!COMMANDS.has(command)) return;
  if (PRIVATE_COMMANDS.has(command) && !isPrivate) { await privateOnly(); return; }
  if (command === 'start' || command === 'help') { await reply(HELP); return; }
  if (command === 'status') {
    const status = await store.status();
    await reply(`Scansione giochi gratuiti: ${status.lastGiveawayScan === null ? 'in attesa' : `${formatExpiry(status.lastGiveawayScan)} (Italia)`}\nScansione wishlist: ${status.lastPriceScan === null ? 'in attesa' : `${formatExpiry(status.lastPriceScan)} (Italia)`}\nControllo ogni 30 minuti.`); return;
  }
  if (command === 'deals') {
    const offers = await store.getGiveaways();
    if (!offers.length) await reply('😔 Nessun gioco completo gratuito da riscattare al momento.');
    else for (const offer of offers) await reply(formatGiveaway(offer));
    return;
  }
  if (['cerca', 'add', 'confronta'].includes(command)) {
    if (!args.length) { await reply(`❌ Uso: /${command} &lt;titolo del gioco&gt;`); return; }
    const results = await itad.searchGames(args.join(' '));
    if (!results.length) { await reply('😔 Nessun gioco completo trovato.'); return; }
    if (command === 'confronta') { await showPrices(results[0], true); return; }
    const action = command === 'add' ? 'addwish' : 'price';
    await reply(command === 'add' ? 'Quale gioco vuoi aggiungere alla wishlist?' : 'Seleziona il gioco per vedere i prezzi:',
      keyboard([...results.map(game => [button(game.title, `${action}|${game.id}`)]), cancel])); return;
  }
  if (command === 'wishlist' || command === 'remove' || command === 'setscontog') {
    await wishlistPage(command === 'wishlist' ? 'wishlist' : command === 'remove' ? 'remove' : 'discount'); return;
  }
  const prefs = isPrivate ? await store.getPrefs(userId) : { thresholdCents: 500, minCut: 0, minScore: 0, minDiscountPct: 10 };
  if (command === 'setsconto') {
    if (!args.length) { await reply(`🔔 Soglia globale: <b>${prefs.minDiscountPct}%</b> di ulteriore ribasso rispetto all’ultima notifica consegnata. Cambiala con /setsconto &lt;10-99&gt;.`); return; }
    const pct = percent(args[0], 10, 99);
    if (pct === null || args.length !== 1) { await reply('❌ Uso: /setsconto &lt;10-99&gt;. Il minimo è 10%.'); return; }
    await store.setPrefs(userId, username, { minDiscountPct: pct }); await reply(`✅ Soglia globale impostata a <b>${pct}%</b> di ulteriore ribasso.`); return;
  }
  if (command === 'setsoglia') {
    if (!args.length) { await reply(`⚙️ Preferenze offerte:\nPrezzo massimo: <b>${money(prefs.thresholdCents)}</b>\nSconto minimo: ${prefs.minCut}%\nReview minima: ${prefs.minScore}\n/setsoglia prezzo|sconto|review &lt;valore&gt;`); return; }
    const field = args[0].toLowerCase(), value = field === 'prezzo' ? priceArg(args[1]) : percent(args[1]);
    if (args.length !== 2 || value === null || !['prezzo', 'sconto', 'review'].includes(field) || (field === 'prezzo' && (value <= 0 || value > 10000))) {
      await reply('❌ Uso: /setsoglia prezzo|sconto|review &lt;valore&gt;. Prezzo: 0-100€, percentuali: 0-100.'); return;
    }
    const patch: Partial<Preferences> = field === 'prezzo' ? { thresholdCents: value } : field === 'sconto' ? { minCut: value } : { minScore: value };
    await store.setPrefs(userId, username, patch); await reply(`✅ Filtro ${field} aggiornato: ${field === 'prezzo' ? money(value) : value}.`); return;
  }

  let maximum = prefs.thresholdCents, minimum = 0, minCut = prefs.minCut, minScore = prefs.minScore, limit = command === 'offerte' ? 5 : 10;
  let shopIds: number[] | undefined;
  if (command === 'offerte') {
    if (args.length > 3 || (args[0] && (priceArg(args[0]) === null || priceArg(args[0])! <= 0)) || (args[1] && percent(args[1]) === null) || (args[2] && percent(args[2]) === null)) {
      await reply('❌ Uso: /offerte [prezzo] [sconto%] [score]. Es: /offerte 10 50 70'); return;
    }
    maximum = args[0] ? priceArg(args[0])! : maximum; minCut = args[1] ? percent(args[1])! : minCut; minScore = args[2] ? percent(args[2])! : minScore;
  } else {
    const tokens = args.slice();
    if (tokens[0] && /\d/.test(tokens[0])) {
      const range = tokens.shift()!.replace(',', '.').split('-');
      const left = toCents(range[0]), right = range.length === 2 ? toCents(range[1]) : left;
      if (range.length > 2 || left === null || right === null || right <= 0 || (range.length === 2 && left > right)) { await reply('❌ Range prezzo non valido. Es: /offerte_shop 5-20 steam,gog'); return; }
      minimum = range.length === 2 ? left : 0; maximum = right;
    }
    if (tokens[0] && /^\d+$/.test(tokens[0])) limit = Math.max(1, Math.min(30, Number(tokens.shift())));
    shopIds = SHOP_IDS;
    if (tokens.length) {
      const text = tokens.join(' ').toLowerCase().replace(/,/g, ' ');
      let remaining = text;
      const ids = new Set<number>();
      for (const name of Object.keys(SHOPS).sort((a, b) => b.length - a.length)) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'g');
        if (pattern.test(remaining)) { ids.add(SHOPS[name]); remaining = remaining.replace(pattern, ' '); }
      }
      if (remaining.trim() || !ids.size) { await reply('❌ Negozio non riconosciuto. Es: steam,gog,epic,fanatical'); return; }
      shopIds = [...ids];
    }
  }
  const deals = await itad.getDeals({ maxPriceCents: maximum, minPriceCents: minimum, minCut, minScore, limit, shopIds });
  if (!deals.length) { await reply('😔 Nessuna offerta trovata con questi filtri.'); return; }
  if (command === 'offerte_shop') deals.sort((a, b) => b.quote.cut - a.quote.cut || a.quote.priceCents - b.quote.priceCents);
  for (const deal of deals) await reply(`🎮 <b>${html(deal.game.title)}</b>\n${quoteText(deal.quote)}${deal.steamScore === null ? '' : `\n⭐ Review Steam: ${deal.steamScore}%`}`);
}
