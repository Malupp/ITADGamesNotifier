import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes, CallbackQueryHandler

from config import BOT_TOKEN, TRACKED_SHOPS
from db import (
    init_db, wishlist_add, wishlist_remove, wishlist_get, wishlist_set_discount,
    prefs_get, prefs_set
)
from itad_api import (
    search_games, get_game_prices, get_free_games, get_deals_under_price,
    parse_shop_names, parse_price_filter, get_steam_appid, get_ggdeals_prices
)
from telegram_utils import format_expiry

logger = logging.getLogger(__name__)


# ─── COMANDI ──────────────────────────────────────────────────────────────────

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 Ciao! Sono il tuo notificatore di offerte gaming.\n\n"
        "📌 <b>Comandi disponibili:</b>\n"
        "/deals — giochi gratuiti adesso\n"
        "/cerca &lt;titolo&gt; — cerca prezzi di un gioco\n"
        "/wishlist — vedi la tua wishlist con prezzi attuali\n"
        "/add &lt;titolo&gt; — aggiungi un gioco alla wishlist\n"
        "  <i>└ ti avviso automaticamente se il prezzo scende!</i>\n"
        "/remove — rimuovi un gioco dalla wishlist\n"
        "/offerte [prezzo] [sconto%] [score] — offerte filtrate\n"
        "  <i>└ es. /offerte 10 50 70</i>\n"
        "/offerte_shop [prezzo] [shop...] — offerte per piattaforma\n"
        "  <i>└ es. /offerte_shop 10 steam,gog</i>\n"
        "/confronta &lt;titolo&gt; — confronta prezzi su tutti gli store\n"
        "/setsoglia prezzo|sconto|review &lt;valore&gt; — filtri offerte\n"
        "/setsconto [%] — soglia sconto globale notifiche wishlist\n"
        "/setscontog — soglia sconto per singolo gioco\n"
        "/help — mostra questo messaggio\n\n"
        "🔔 <b>Monitoraggio prezzi automatico:</b>\n"
        "Ogni ora controllo i prezzi dei giochi nella tua wishlist. "
        "Se un gioco scende di prezzo ti mando una notifica direttamente qui!",
        parse_mode="HTML"
    )

async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await cmd_start(update, context)

async def cmd_deals(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🔍 Cerco giochi gratuiti...")
    deals = get_free_games()

    if not deals:
        await update.message.reply_text("😔 Nessun gioco gratuito al momento.")
        return

    for deal in deals:
        title   = deal.get("title", "?")
        shop    = deal.get("deal", {}).get("shop", {}).get("name", "?")
        url     = deal.get("deal", {}).get("url", "")
        regular = deal.get("deal", {}).get("regular", {}).get("amount")
        expiry  = deal.get("deal", {}).get("expiry")

        price_line  = f"<s>€{regular}</s> → <b>GRATIS</b>" if regular else "<b>GRATIS</b>"
        expiry_line = f"\n⏳ Scade il {expiry[:10]}" if expiry else ""

        await update.message.reply_text(
            f"🎮 <b>{title}</b>\n🏪 {shop}\n💰 {price_line}{expiry_line}\n🔗 {url}",
            parse_mode="HTML"
        )

async def cmd_cerca(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("❌ Uso: /cerca <titolo del gioco>")
        return

    query   = " ".join(context.args)
    await update.message.reply_text(f"🔍 Cerco <b>{query}</b>...", parse_mode="HTML")
    results = search_games(query)

    if not results:
        await update.message.reply_text("😔 Nessun risultato trovato.")
        return

    context.user_data["search_results"] = {str(i): g for i, g in enumerate(results[:5])}
    keyboard = [
        [InlineKeyboardButton(g["title"], callback_data=f"price|{i}")]
        for i, g in enumerate(results[:5])
    ]
    keyboard.append([InlineKeyboardButton("❌ Annulla", callback_data="cancel")])
    await update.message.reply_text(
        "Seleziona il gioco per vedere i prezzi:",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

async def cmd_add(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("❌ Uso: /add <titolo del gioco>")
        return

    query   = " ".join(context.args)
    await update.message.reply_text(f"🔍 Cerco <b>{query}</b>...", parse_mode="HTML")
    results = search_games(query)

    if not results:
        await update.message.reply_text("😔 Nessun risultato trovato.")
        return

    context.user_data["add_results"] = {str(i): g for i, g in enumerate(results[:5])}
    keyboard = [
        [InlineKeyboardButton(g["title"], callback_data=f"addwish|{i}")]
        for i, g in enumerate(results[:5])
    ]
    keyboard.append([InlineKeyboardButton("❌ Annulla", callback_data="cancel")])
    await update.message.reply_text(
        "Quale vuoi aggiungere alla wishlist?",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

async def cmd_remove(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    items   = wishlist_get(user_id)

    if not items:
        await update.message.reply_text("📋 La tua wishlist è vuota.")
        return

    context.user_data["remove_items"] = {str(i): item for i, item in enumerate(items)}
    keyboard = [
        [InlineKeyboardButton(f"❌ {item['game_title']}", callback_data=f"remwish|{i}")]
        for i, item in enumerate(items)
    ]
    keyboard.append([InlineKeyboardButton("🔙 Annulla", callback_data="cancel")])
    await update.message.reply_text(
        "Seleziona il gioco da rimuovere:",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

async def cmd_wishlist(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    items   = wishlist_get(user_id)

    if not items:
        await update.message.reply_text(
            "📋 La tua wishlist è vuota.\nUsa /add <titolo> per aggiungere giochi."
        )
        return

    await update.message.reply_text("🔍 Carico prezzi attuali...")

    try:
        prices_data = get_game_prices([item["game_slug"] for item in items])
    except Exception:
        prices_data = {}

    lines = [f"📋 <b>La tua wishlist ({len(items)} giochi):</b>\n"]
    for item in items:
        slug      = item["game_slug"]
        game_data = prices_data.get(slug)

        if game_data and game_data.get("deals"):
            best  = min(game_data["deals"], key=lambda x: x["price"]["amount"])
            price = best["price"]["amount"]
            shop  = best.get("shop", {}).get("name", "?")
            url   = best.get("url", "")
            if price == 0:
                price_str = f'<b>GRATIS</b> su {shop} — <a href="{url}">link</a>'
            else:
                price_str = f'<b>€{price}</b> su {shop} — <a href="{url}">link</a>'
        else:
            price_str = "prezzo non disponibile"

        lines.append(f"🎮 <b>{item['game_title']}</b>\n   💰 {price_str}\n")

    lines.append("Usa /remove per rimuovere un gioco.")
    await update.message.reply_text("\n".join(lines), parse_mode="HTML", disable_web_page_preview=True)

async def cmd_offerte(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    prefs   = prefs_get(user_id)

    threshold = prefs["threshold"]
    min_cut   = prefs["min_cut"]
    min_score = prefs["min_score"]

    args = context.args or []
    try:
        if len(args) >= 1: threshold = float(args[0].replace(",", "."))
        if len(args) >= 2: min_cut   = int(args[1])
        if len(args) >= 3: min_score = int(args[2])
    except ValueError:
        await update.message.reply_text(
            "❌ Uso: /offerte [prezzo] [sconto%] [score]\nEs: /offerte 10 50 70"
        )
        return

    filtri     = [s for s in [f"sconto ≥{min_cut}%" if min_cut > 0 else "", f"review ≥{min_score}" if min_score > 0 else ""] if s]
    filtri_str = " — ".join(filtri) if filtri else "nessun filtro aggiuntivo"

    await update.message.reply_text(f"🔍 Cerco offerte sotto €{threshold} ({filtri_str})...")
    deals = get_deals_under_price(threshold, min_cut=min_cut, min_score=min_score, limit=5)

    if not deals:
        await update.message.reply_text("😔 Nessuna offerta trovata. Prova ad alzare il prezzo o abbassare i requisiti.")
        return

    lines = [f"🏷 <b>Offerte sotto €{threshold}:</b>\n"]
    for deal in deals:
        title       = deal.get("title", "?")
        shop        = deal.get("deal", {}).get("shop", {}).get("name", "?")
        price       = deal.get("deal", {}).get("price", {}).get("amount")
        regular     = deal.get("deal", {}).get("regular", {}).get("amount")
        cut         = deal.get("deal", {}).get("cut", 0)
        url         = deal.get("deal", {}).get("url", "")
        expiry      = deal.get("deal", {}).get("expiry")
        steam_score = deal.get("_steam_score")

        price_str  = f"<s>€{regular}</s> → <b>€{price}</b> (-{cut}%)" if regular else f"<b>€{price}</b> (-{cut}%)"
        meta_parts = [f"⭐ {steam_score}%" if steam_score else "", f"⏳ scade il {expiry[:10]}" if expiry else ""]
        meta_line  = f"\n   {' — '.join(p for p in meta_parts if p)}" if any(meta_parts) else ""

        lines.append(f"🎮 <b>{title}</b>\n   🏪 {shop} — {price_str}{meta_line}\n   🔗 <a href='{url}'>link</a>\n")

    lines.append(f"<i>Filtri: €{threshold} | sconto ≥{min_cut}% | review ≥{min_score} — cambia con /setsoglia</i>")
    await update.message.reply_text("\n".join(lines), parse_mode="HTML", disable_web_page_preview=True)

async def cmd_offerte_shop(update: Update, context: ContextTypes.DEFAULT_TYPE):
    args         = context.args or []
    prefs        = prefs_get(update.effective_user.id)
    min_cut      = prefs["min_cut"]
    min_score    = prefs["min_score"]
    min_price    = 0.0
    max_price    = prefs["threshold"] if prefs["threshold"] > 0 else 20.0
    shop_tokens  = args
    result_limit = 10

    if args and any(ch.isdigit() for ch in args[0]):
        try:
            min_price, max_price = parse_price_filter(args[0])
            shop_tokens = args[1:]
        except ValueError:
            await update.message.reply_text("❌ Formato prezzo non valido. Es: /offerte_shop 10 steam,gog")
            return

    if shop_tokens and shop_tokens[0].isdigit():
        result_limit = max(1, min(30, int(shop_tokens[0])))
        shop_tokens  = shop_tokens[1:]

    shop_ids = parse_shop_names(shop_tokens) if shop_tokens else set(TRACKED_SHOPS.keys())

    deals = get_deals_under_price(
        max_price, min_cut=min_cut, min_score=min_score,
        limit=result_limit,
        fetch_limit=max(200, min(result_limit * 20, 500)),
        shop_ids=shop_ids
    )
    deals = [d for d in deals if min_price <= d.get("deal", {}).get("price", {}).get("amount", 0) <= max_price]

    if not deals:
        shops_str = ", ".join(TRACKED_SHOPS.get(sid, str(sid)) for sid in sorted(shop_ids))
        await update.message.reply_text(
            f"😔 Nessuna offerta trovata.\nShop: {shops_str}\nRange: €{min_price}-€{max_price}"
        )
        return

    deals = sorted(deals, key=lambda d: (-d.get("deal", {}).get("cut", 0), d.get("deal", {}).get("price", {}).get("amount", 999999)))[:result_limit]

    lines = [f"🏷 <b>Migliori sconti</b> (€{min_price}-€{max_price}, top {result_limit}):\n"]
    for deal in deals:
        sid       = deal.get("deal", {}).get("shop", {}).get("id")
        title     = deal.get("title", "?")
        shop_name = TRACKED_SHOPS.get(sid, deal.get("deal", {}).get("shop", {}).get("name", "?"))
        price     = deal.get("deal", {}).get("price", {}).get("amount")
        regular   = deal.get("deal", {}).get("regular", {}).get("amount")
        cut       = deal.get("deal", {}).get("cut", 0)
        url       = deal.get("deal", {}).get("url", "")
        price_str = f"<s>€{regular}</s> → <b>€{price}</b> (-{cut}%)" if regular else f"<b>€{price}</b> (-{cut}%)"
        lines.append(f"🏪 <b>{shop_name}</b>\n🎮 {title}\n💰 {price_str}\n🔗 <a href='{url}'>link</a>\n")

    await update.message.reply_text("\n".join(lines), parse_mode="HTML", disable_web_page_preview=True)

async def cmd_confronta(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("❌ Uso: /confronta <titolo gioco>")
        return

    results = search_games(" ".join(context.args))
    if not results:
        await update.message.reply_text("😔 Nessun risultato trovato.")
        return

    game       = results[0]
    game_id    = game["id"]
    game_title = game["title"]

    prices_data = get_game_prices([game_id])
    game_data   = prices_data.get(game_id)
    if not game_data or not game_data.get("deals"):
        await update.message.reply_text(f"😔 Nessun prezzo trovato per <b>{game_title}</b>.", parse_mode="HTML")
        return

    allowed = set(TRACKED_SHOPS.keys())
    deals   = [d for d in game_data["deals"] if d.get("shop", {}).get("id") in allowed]
    if not deals:
        await update.message.reply_text("😔 Nessun prezzo sulle piattaforme monitorate.")
        return

    best  = min(deals, key=lambda x: x["price"]["amount"])
    lines = [f"⚖️ <b>Confronto prezzi: {game_title}</b>\n"]
    for deal in sorted(deals, key=lambda x: x["price"]["amount"]):
        sid   = deal.get("shop", {}).get("id")
        shop  = TRACKED_SHOPS.get(sid, deal.get("shop", {}).get("name", "?"))
        price = deal.get("price", {}).get("amount", 0)
        cut   = deal.get("cut", 0)
        url   = deal.get("url", "")
        lines.append(f"🏪 {shop}: <b>€{price}</b> (-{cut}%) — <a href='{url}'>link</a>")

    best_shop  = TRACKED_SHOPS.get(best.get("shop", {}).get("id"), "?")
    best_price = best.get("price", {}).get("amount", 0)
    lines.append(f"\n🥇 <b>Prezzo più basso: {best_shop} a €{best_price}</b>")
    await update.message.reply_text("\n".join(lines), parse_mode="HTML", disable_web_page_preview=True)

async def cmd_setsoglia(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id  = update.effective_user.id
    username = update.effective_user.username or update.effective_user.first_name
    prefs    = prefs_get(user_id)

    if not context.args:
        await update.message.reply_text(
            f"⚙️ <b>Le tue preferenze offerte:</b>\n\n"
            f"💰 Prezzo massimo: <b>€{prefs['threshold']}</b>\n"
            f"✂️ Sconto minimo: <b>{prefs['min_cut']}%</b>\n"
            f"⭐ Review minima: <b>{prefs['min_score']}</b>\n\n"
            f"<b>Come aggiornare:</b>\n"
            f"/setsoglia prezzo 15\n/setsoglia sconto 50\n/setsoglia review 70",
            parse_mode="HTML"
        )
        return

    if len(context.args) < 2:
        await update.message.reply_text("❌ Uso:\n/setsoglia prezzo 15\n/setsoglia sconto 50\n/setsoglia review 70")
        return

    campo  = context.args[0].lower()
    valore = context.args[1].replace(",", ".")

    try:
        if campo == "prezzo":
            v = float(valore)
            if not (0 < v <= 100): raise ValueError
            prefs_set(user_id, username, threshold=v)
            await update.message.reply_text(f"✅ Prezzo massimo impostato a <b>€{v}</b>", parse_mode="HTML")
        elif campo == "sconto":
            v = int(float(valore))
            if not (0 <= v <= 100): raise ValueError
            prefs_set(user_id, username, min_cut=v)
            await update.message.reply_text(f"✅ Sconto minimo impostato a <b>{v}%</b>", parse_mode="HTML")
        elif campo == "review":
            v = int(float(valore))
            if not (0 <= v <= 100): raise ValueError
            prefs_set(user_id, username, min_score=v)
            await update.message.reply_text(f"✅ Review minima impostata a <b>{v}</b>", parse_mode="HTML")
        else:
            await update.message.reply_text("❌ Campo non riconosciuto. Usa: prezzo, sconto, oppure review")
    except ValueError:
        await update.message.reply_text("❌ Valore non valido.")

async def cmd_setsconto(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id  = update.effective_user.id
    username = update.effective_user.username or update.effective_user.first_name
    prefs    = prefs_get(user_id)

    if not context.args:
        await update.message.reply_text(
            f"🔔 La tua soglia di sconto globale è <b>{prefs['min_discount_pct']}%</b>\n\n"
            f"Ricevi notifiche solo quando un gioco scende di almeno questa % rispetto al prezzo iniziale.\n\n"
            f"Per cambiarla: /setsconto &lt;percentuale&gt;\nEs: /setsconto 20",
            parse_mode="HTML"
        )
        return

    try:
        v = int(context.args[0])
        if not (1 <= v <= 99): raise ValueError
        prefs_set(user_id, username, min_discount_pct=v)
        await update.message.reply_text(
            f"✅ Soglia sconto globale impostata a <b>{v}%</b>\n"
            f"Riceverai notifiche solo per sconti ≥{v}% rispetto al prezzo iniziale.",
            parse_mode="HTML"
        )
    except ValueError:
        await update.message.reply_text("❌ Uso: /setsconto <percentuale>\nEs: /setsconto 20")

async def cmd_setsconto_gioco(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    items   = wishlist_get(user_id)

    if not items:
        await update.message.reply_text("📋 La tua wishlist è vuota.")
        return

    context.user_data["sconto_items"] = {str(i): item for i, item in enumerate(items)}
    keyboard = []
    for i, item in enumerate(items):
        pct     = item.get("min_discount_pct")
        pct_str = f" ({pct}%)" if pct is not None else " (globale)"
        keyboard.append([InlineKeyboardButton(
            f"🎮 {item['game_title']}{pct_str}",
            callback_data=f"setscontog|{i}"
        )])
    keyboard.append([InlineKeyboardButton("❌ Annulla", callback_data="cancel")])
    await update.message.reply_text(
        "Seleziona il gioco per impostare la soglia di sconto:",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )


# ─── CALLBACK ─────────────────────────────────────────────────────────────────

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query  = update.callback_query
    await query.answer()
    parts  = query.data.split("|")
    action = parts[0]
    idx    = parts[1] if len(parts) > 1 else None

    if action == "cancel":
        await query.edit_message_text("✅ Operazione annullata.")
        return

    if action == "price":
        game = context.user_data.get("search_results", {}).get(idx)
        if not game:
            await query.edit_message_text("❌ Sessione scaduta, rifai /cerca.")
            return

        game_id    = game["id"]
        game_title = game["title"]
        await query.edit_message_text(f"🔍 Carico prezzi per <b>{game_title}</b>...", parse_mode="HTML")

        prices_data = get_game_prices([game_id])
        game_data   = prices_data.get(game_id)

        if not game_data or not game_data.get("deals"):
            await query.edit_message_text(f"😔 Nessun prezzo trovato per <b>{game_title}</b>.", parse_mode="HTML")
            return

        lines = [f"💰 <b>Prezzi per {game_title}:</b>\n"]
        for deal in sorted(game_data["deals"], key=lambda x: x["price"]["amount"])[:8]:
            shop    = deal.get("shop", {}).get("name", "?")
            price   = deal.get("price", {}).get("amount", 0)
            cut     = deal.get("cut", 0)
            url     = deal.get("url", "")
            cut_str = f" (-{cut}%)" if cut > 0 else ""
            lines.append(f"🏪 {shop}: <b>€{price}</b>{cut_str} — <a href='{url}'>link</a>")

        # gg.deals keyshop
        steam_id = get_steam_appid(game_title)
        logger.debug(f"steam_id per '{game_title}': {steam_id}")
        if steam_id:
            gg_data = get_ggdeals_prices([steam_id])
            logger.debug(f"gg_data: {gg_data}")
            gg_game = gg_data.get(steam_id)
            if gg_game:
                keyshop_price = gg_game.get("prices", {}).get("currentKeyshops")
                gg_url        = gg_game.get("url", "")
                if keyshop_price:
                    full_url = gg_url if gg_url.startswith("http") else f"https://gg.deals{gg_url}"
                    lines.append(f"\n🔑 <b>Miglior keyshop: €{keyshop_price}</b> — <a href='{full_url}'>vedi su gg.deals</a>")
                    lines.append("<i>(keyshop = rivenditori terzi, acquista a tuo rischio)</i>")

        await query.edit_message_text("\n".join(lines), parse_mode="HTML", disable_web_page_preview=True)

    elif action == "addwish":
        game = context.user_data.get("add_results", {}).get(idx)
        if not game:
            await query.edit_message_text("❌ Sessione scaduta, rifai /add.")
            return

        current_price, current_shop, current_url = None, None, None
        try:
            prices_data = get_game_prices([game["id"]])
            game_data   = prices_data.get(game["id"])
            if game_data and game_data.get("deals"):
                best          = min(game_data["deals"], key=lambda x: x["price"]["amount"])
                current_price = best["price"]["amount"]
                current_shop  = best.get("shop", {}).get("name")
                current_url   = best.get("url")
        except Exception:
            pass

        user  = query.from_user
        added = wishlist_add(user.id, user.username or user.first_name,
                             game["id"], game["title"],
                             current_price, current_shop, current_url)

        price_str = f" (prezzo attuale: €{current_price})" if current_price is not None else ""

        if added:
            await query.edit_message_text(
                f"✅ <b>{game['title']}</b> aggiunto alla wishlist{price_str}!\n\n"
                f"🔔 Ogni ora controllo automaticamente il prezzo di questo gioco. "
                f"Se scende ti mando una notifica qui. Non devi fare nulla! 😊",
                parse_mode="HTML"
            )
        else:
            await query.edit_message_text(
                f"ℹ️ <b>{game['title']}</b> è già nella tua wishlist.",
                parse_mode="HTML"
            )

    elif action == "remwish":
        item = context.user_data.get("remove_items", {}).get(idx)
        if not item:
            await query.edit_message_text("❌ Sessione scaduta, rifai /remove.")
            return

        removed = wishlist_remove(query.from_user.id, item["game_slug"])
        if removed:
            await query.edit_message_text(f"✅ <b>{item['game_title']}</b> rimosso dalla wishlist.", parse_mode="HTML")
        else:
            await query.edit_message_text("❌ Gioco non trovato nella wishlist.")

    elif action == "setscontog":
        item = context.user_data.get("sconto_items", {}).get(idx)
        if not item:
            await query.edit_message_text("❌ Sessione scaduta, rifai /setscontog.")
            return

        context.user_data["sconto_target"] = item
        current_pct = item.get("min_discount_pct")
        current_str = f"{current_pct}%" if current_pct is not None else "soglia globale"

        keyboard = [
            [InlineKeyboardButton("🌐 Usa soglia globale", callback_data="setscontog_apply|None")],
            [InlineKeyboardButton("10%",  callback_data="setscontog_apply|10"),
             InlineKeyboardButton("20%",  callback_data="setscontog_apply|20"),
             InlineKeyboardButton("30%",  callback_data="setscontog_apply|30")],
            [InlineKeyboardButton("40%",  callback_data="setscontog_apply|40"),
             InlineKeyboardButton("50%",  callback_data="setscontog_apply|50"),
             InlineKeyboardButton("60%",  callback_data="setscontog_apply|60")],
            [InlineKeyboardButton("70%",  callback_data="setscontog_apply|70"),
             InlineKeyboardButton("75%",  callback_data="setscontog_apply|75"),
             InlineKeyboardButton("80%",  callback_data="setscontog_apply|80")],
            [InlineKeyboardButton("❌ Annulla", callback_data="cancel")],
        ]
        await query.edit_message_text(
            f"🎮 <b>{item['game_title']}</b>\nSoglia attuale: <b>{current_str}</b>\n\nScegli la soglia:",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode="HTML"
        )

    elif action == "setscontog_apply":
        item = context.user_data.get("sconto_target")
        if not item:
            await query.edit_message_text("❌ Sessione scaduta, rifai /setscontog.")
            return

        pct     = None if parts[1] == "None" else int(parts[1])
        wishlist_set_discount(query.from_user.id, item["game_slug"], pct)

        msg = (f"✅ <b>{item['game_title']}</b>\nUsa ora la soglia globale." if pct is None
               else f"✅ <b>{item['game_title']}</b>\nNotifica quando sconto ≥<b>{pct}%</b>.")
        await query.edit_message_text(msg, parse_mode="HTML")


# ─── AVVIO ────────────────────────────────────────────────────────────────────

def main():
    init_db()
    app = ApplicationBuilder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start",       cmd_start))
    app.add_handler(CommandHandler("help",        cmd_help))
    app.add_handler(CommandHandler("deals",       cmd_deals))
    app.add_handler(CommandHandler("cerca",       cmd_cerca))
    app.add_handler(CommandHandler("add",         cmd_add))
    app.add_handler(CommandHandler("remove",      cmd_remove))
    app.add_handler(CommandHandler("wishlist",    cmd_wishlist))
    app.add_handler(CommandHandler("offerte",     cmd_offerte))
    app.add_handler(CommandHandler("offerte_shop", cmd_offerte_shop))
    app.add_handler(CommandHandler("confronta",   cmd_confronta))
    app.add_handler(CommandHandler("setsoglia",   cmd_setsoglia))
    app.add_handler(CommandHandler("setsconto",   cmd_setsconto))
    app.add_handler(CommandHandler("setscontog",  cmd_setsconto_gioco))
    app.add_handler(CallbackQueryHandler(handle_callback))

    logger.debug("✅ Bot avviato...")
    app.run_polling(drop_pending_updates=True)

if __name__ == "__main__":
    main()