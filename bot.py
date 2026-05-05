import os
import logging
import requests
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ApplicationBuilder, CommandHandler, ContextTypes, CallbackQueryHandler
)

load_dotenv()

BOT_TOKEN    = os.getenv("TELEGRAM_BOT_TOKEN")
ITAD_API_KEY = os.getenv("ITAD_API_KEY")
DATABASE_URL = os.getenv("DATABASE_URL")

logging.basicConfig(level=logging.INFO)

TRACKED_SHOPS = {
    4: "GamersGate",
    6: "Green Man Gaming",
    16: "GameBillet",
    35: "GOG",
    36: "Humble Store",
    37: "IndieGala",
    48: "Fanatical",
    52: "Gamesplanet",
    61: "Steam",
    62: "Epic Games Store",
}


# ─── DATABASE ────────────────────────────────────────────────────────────────

def get_db():
    return psycopg2.connect(DATABASE_URL, sslmode="require")

def init_db():
    db = get_db()
    cursor = db.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS itad_wishlist (
            id                  SERIAL PRIMARY KEY,
            user_id             BIGINT NOT NULL,
            username            VARCHAR(255),
            game_slug           VARCHAR(255) NOT NULL,
            game_title          VARCHAR(255) NOT NULL,
            price_at_add        NUMERIC(10,2) DEFAULT NULL,
            last_notified_price NUMERIC(10,2) DEFAULT NULL,
            added_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, game_slug)
        )
    """)
    db.commit()
    cursor.close()
    db.close()

def get_user_threshold(user_id: int) -> float:
    db = get_db()
    cursor = db.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cursor.execute(
        "SELECT price_threshold FROM itad_user_prefs WHERE user_id=%s",
        (user_id,)
    )
    row = cursor.fetchone()
    cursor.close()
    db.close()
    return float(row["price_threshold"]) if row else 5.00

def set_user_threshold(user_id: int, username: str, threshold: float):
    db = get_db()
    cursor = db.cursor()
    cursor.execute(
        """INSERT INTO itad_user_prefs (user_id, username, price_threshold)
           VALUES (%s, %s, %s)
           ON CONFLICT (user_id) DO UPDATE SET price_threshold=%s, username=%s""",
        (user_id, username, threshold, threshold, username)
    )
    db.commit()
    cursor.close()
    db.close()

def get_user_deal_prefs(user_id: int) -> dict:
    db = get_db()
    cursor = db.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cursor.execute(
        "SELECT price_threshold, min_cut, min_score FROM itad_user_prefs WHERE user_id=%s",
        (user_id,)
    )
    row = cursor.fetchone()
    cursor.close()
    db.close()
    return {
        "threshold": float(row["price_threshold"]) if row and row["price_threshold"] else 5.00,
        "min_cut":   int(row["min_cut"])            if row and row["min_cut"]           else 0,
        "min_score": int(row["min_score"])          if row and row["min_score"]         else 0,
    }

def set_user_deal_prefs(user_id: int, username: str, threshold: float = None, min_cut: int = None, min_score: int = None):
    db = get_db()
    cursor = db.cursor()
    cursor.execute(
        """INSERT INTO itad_user_prefs (user_id, username, price_threshold, min_cut, min_score)
           VALUES (%s, %s, %s, %s, %s)
           ON CONFLICT (user_id) DO UPDATE SET
               username        = EXCLUDED.username,
               price_threshold = COALESCE(%s, itad_user_prefs.price_threshold),
               min_cut         = COALESCE(%s, itad_user_prefs.min_cut),
               min_score       = COALESCE(%s, itad_user_prefs.min_score)""",
        (user_id, username,
         threshold or 5.00, min_cut or 0, min_score or 0,
         threshold, min_cut, min_score)
    )
    db.commit()
    cursor.close()
    db.close()

# ─── WISHLIST HELPERS ─────────────────────────────────────────────────────────

def wishlist_add(user_id: int, username: str, slug: str, title: str, price: float = None) -> bool:
    db = get_db()
    cursor = db.cursor()
    try:
        cursor.execute(
            """INSERT INTO itad_wishlist (user_id, username, game_slug, game_title, price_at_add, last_notified_price)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (user_id, username, slug, title, price, price)
        )
        db.commit()
        return True
    except psycopg2.errors.UniqueViolation:
        db.rollback()
        return False
    finally:
        cursor.close()
        db.close()

def wishlist_remove(user_id: int, slug: str) -> bool:
    db = get_db()
    cursor = db.cursor()
    cursor.execute(
        "DELETE FROM itad_wishlist WHERE user_id=%s AND game_slug=%s",
        (user_id, slug)
    )
    db.commit()
    affected = cursor.rowcount
    cursor.close()
    db.close()
    return affected > 0

def wishlist_get(user_id: int) -> list:
    db = get_db()
    cursor = db.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cursor.execute(
        """SELECT game_slug, game_title, price_at_add, last_notified_price, added_at
           FROM itad_wishlist
           WHERE user_id=%s
           ORDER BY added_at DESC""",
        (user_id,)
    )
    rows = cursor.fetchall()
    cursor.close()
    db.close()
    return rows


# ─── ITAD API ─────────────────────────────────────────────────────────────────

def search_games(query: str) -> list:
    response = requests.get(
        "https://api.isthereanydeal.com/games/search/v1",
        params={"key": ITAD_API_KEY, "title": query, "results": 5}
    )
    response.raise_for_status()
    return response.json()

def get_game_prices(game_ids: list) -> dict:
    response = requests.post(
        "https://api.isthereanydeal.com/games/prices/v3",
        params={"key": ITAD_API_KEY, "country": "IT"},
        json=game_ids
    )
    response.raise_for_status()
    return {item["id"]: item for item in response.json()}

def get_free_games_now() -> list:
    response = requests.get(
        "https://api.isthereanydeal.com/deals/v2",
        params={"key": ITAD_API_KEY, "country": "IT", "limit": 20, "sort": "price"}
    )
    response.raise_for_status()
    data = response.json()
    return [
        d for d in data.get("list", [])
        if d.get("deal", {}).get("price", {}).get("amount") == 0
    ]

def get_deals_under_price(max_price: float, min_cut: int = 0, min_score: int = 0, limit: int = 10) -> list:
    response = requests.get(
        "https://api.isthereanydeal.com/deals/v2",
        params={
            "key": ITAD_API_KEY,
            "country": "IT",
            "limit": 50,  # prendiamo più risultati per poi filtrare
            "sort": "rank",
        }
    )
    response.raise_for_status()
    data = response.json()

    results = []
    for deal in data.get("list", []):
        price = deal.get("deal", {}).get("price", {}).get("amount")
        cut   = deal.get("deal", {}).get("cut", 0)

        # Filtro prezzo e sconto
        if price is None or price <= 0 or price > max_price:
            continue
        if cut < min_cut:
            continue

        # Filtro review score Steam
        reviews     = deal.get("reviews") or {}
        steam       = reviews.get("steam") or {}
        steam_score = steam.get("score")

        if min_score > 0 and (steam_score is None or steam_score < min_score):
            continue

        deal["_steam_score"] = steam_score  # salviamo per mostrarlo nel messaggio
        results.append(deal)

        if len(results) >= limit:
            break

    return results

def normalize_shop_ids(raw_values: list) -> set:
    """Converte una lista di ID o nomi shop in un set di ID validi."""
    if not raw_values:
        return set(TRACKED_SHOPS.keys())

    by_name = {name.lower(): sid for sid, name in TRACKED_SHOPS.items()}
    resolved = set()

    for value in raw_values:
        cleaned = value.strip().lower()
        if cleaned.isdigit():
            sid = int(cleaned)
            if sid in TRACKED_SHOPS:
                resolved.add(sid)
        elif cleaned in by_name:
            resolved.add(by_name[cleaned])

    return resolved

def filter_deals_by_shop_ids(deals: list, shop_ids: set) -> list:
    filtered = []
    for deal in deals:
        shop = deal.get("deal", {}).get("shop", {})
        shop_id = shop.get("id")
        if shop_id in shop_ids:
            filtered.append(deal)
    return filtered

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
        "/offerte_shop [prezzo] [sconto%] [score] [shop_id...] — migliore offerta per piattaforma\n"
        "  <i>└ es. /offerte_shop 20 50 70 61 62</i>\n"
        "/confronta &lt;titolo&gt; — confronta i prezzi su tutte le piattaforme monitorate\n"
        "/setsoglia prezzo|sconto|review &lt;valore&gt; — imposta i tuoi filtri\n"
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
    deals = get_free_games_now()

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
            f"🎮 <b>{title}</b>\n"
            f"🏪 {shop}\n"
            f"💰 {price_line}"
            f"{expiry_line}\n"
            f"🔗 {url}",
            parse_mode="HTML"
        )

async def cmd_cerca(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("❌ Uso: /cerca <titolo del gioco>")
        return

    query = " ".join(context.args)
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

    query = " ".join(context.args)
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
    items = wishlist_get(user_id)

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
    items = wishlist_get(user_id)

    if not items:
        await update.message.reply_text(
            "📋 La tua wishlist è vuota.\nUsa /add <titolo> per aggiungere giochi."
        )
        return

    await update.message.reply_text("🔍 Carico prezzi attuali...")

    slugs = [item["game_slug"] for item in items]
    try:
        prices_data = get_game_prices(slugs)
    except:
        prices_data = {}

    lines = [f"📋 <b>La tua wishlist ({len(items)} giochi):</b>\n"]
    for item in items:
        title     = item["game_title"]
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

        lines.append(f"🎮 <b>{title}</b>\n   💰 {price_str}\n")

    lines.append("Usa /remove per rimuovere un gioco.")

    await update.message.reply_text(
        "\n".join(lines),
        parse_mode="HTML",
        disable_web_page_preview=True
    )

async def cmd_offerte(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id  = update.effective_user.id
    username = update.effective_user.username or update.effective_user.first_name
    prefs    = get_user_deal_prefs(user_id)

    # Parsing argomenti: /offerte [prezzo] [sconto%] [score]
    threshold = prefs["threshold"]
    min_cut   = prefs["min_cut"]
    min_score = prefs["min_score"]

    args = context.args or []
    try:
        if len(args) >= 1:
            threshold = float(args[0].replace(",", "."))
        if len(args) >= 2:
            min_cut = int(args[1])
        if len(args) >= 3:
            min_score = int(args[2])
    except ValueError:
        await update.message.reply_text(
            "❌ Uso: /offerte [prezzo] [sconto%] [score]\n"
            "Es: /offerte 10 50 70\n"
            "    prezzo massimo €10, sconto min 50%, review min 70"
        )
        return

    filtri = []
    if min_cut   > 0: filtri.append(f"sconto ≥{min_cut}%")
    if min_score > 0: filtri.append(f"review ≥{min_score}")
    filtri_str = " — ".join(filtri) if filtri else "nessun filtro aggiuntivo"

    await update.message.reply_text(
        f"🔍 Cerco offerte sotto €{threshold} ({filtri_str})...",
        parse_mode="HTML"
    )

    deals = get_deals_under_price(threshold, min_cut=min_cut, min_score=min_score, limit=5)

    if not deals:
        await update.message.reply_text(
            f"😔 Nessuna offerta trovata con questi filtri.\n"
            f"Prova ad alzare il prezzo o abbassare i requisiti."
        )
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
        score_str  = f"⭐ {steam_score}%" if steam_score is not None else ""
        expiry_str = f"⏳ scade il {expiry[:10]}" if expiry else ""

        meta = " — ".join(filter(None, [score_str, expiry_str]))
        meta_line = f"\n   {meta}" if meta else ""

        lines.append(
            f"🎮 <b>{title}</b>\n"
            f"   🏪 {shop} — {price_str}"
            f"{meta_line}\n"
            f"   🔗 <a href='{url}'>link</a>\n"
        )

    lines.append(
        f"<i>Filtri: €{threshold} | sconto ≥{min_cut}% | review ≥{min_score}\n"
        f"Cambia i default con /setsoglia</i>"
    )

    await update.message.reply_text(
        "\n".join(lines),
        parse_mode="HTML",
        disable_web_page_preview=True
    )

async def cmd_offerte_shop(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    /offerte_shop [prezzo] [sconto%] [score] [shop_id ...]
    Esempio: /offerte_shop 20 50 70 61 62
    """
    args = context.args or []
    try:
        threshold = float(args[0].replace(",", ".")) if len(args) >= 1 else 20.0
        min_cut = int(args[1]) if len(args) >= 2 else 0
        min_score = int(args[2]) if len(args) >= 3 else 0
        shop_ids = normalize_shop_ids(args[3:]) if len(args) >= 4 else set(TRACKED_SHOPS.keys())
    except ValueError:
        await update.message.reply_text(
            "❌ Uso: /offerte_shop [prezzo] [sconto%] [score] [shop_id ...]\n"
            "Esempio: /offerte_shop 20 50 70 61 62"
        )
        return

    if not shop_ids:
        await update.message.reply_text("❌ Nessuno shop valido. Usa ID tra: 4,6,16,35,36,37,48,52,61,62")
        return

    deals = get_deals_under_price(threshold, min_cut=min_cut, min_score=min_score, limit=50)
    deals = filter_deals_by_shop_ids(deals, shop_ids)

    if not deals:
        await update.message.reply_text("😔 Nessuna offerta trovata con i filtri selezionati.")
        return

    best_by_shop = {}
    for deal in deals:
        shop = deal.get("deal", {}).get("shop", {})
        sid = shop.get("id")
        price = deal.get("deal", {}).get("price", {}).get("amount")
        if sid not in best_by_shop or price < best_by_shop[sid].get("deal", {}).get("price", {}).get("amount", 999999):
            best_by_shop[sid] = deal

    lines = ["🏷 <b>Migliori sconti per piattaforma:</b>\n"]
    for sid in sorted(best_by_shop.keys()):
        deal = best_by_shop[sid]
        title = deal.get("title", "?")
        shop_name = TRACKED_SHOPS.get(sid, deal.get("deal", {}).get("shop", {}).get("name", "?"))
        price = deal.get("deal", {}).get("price", {}).get("amount")
        regular = deal.get("deal", {}).get("regular", {}).get("amount")
        cut = deal.get("deal", {}).get("cut", 0)
        url = deal.get("deal", {}).get("url", "")
        price_str = f"<s>€{regular}</s> → <b>€{price}</b> (-{cut}%)" if regular else f"<b>€{price}</b> (-{cut}%)"
        lines.append(f"🏪 <b>{shop_name}</b>\n🎮 {title}\n💰 {price_str}\n🔗 <a href='{url}'>link</a>\n")

    await update.message.reply_text("\n".join(lines), parse_mode="HTML", disable_web_page_preview=True)

async def cmd_confronta(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("❌ Uso: /confronta <titolo gioco>")
        return

    query = " ".join(context.args)
    results = search_games(query)
    if not results:
        await update.message.reply_text("😔 Nessun risultato trovato.")
        return

    game = results[0]
    game_id = game["id"]
    game_title = game["title"]
    prices_data = get_game_prices([game_id])
    game_data = prices_data.get(game_id)
    if not game_data or not game_data.get("deals"):
        await update.message.reply_text(f"😔 Nessun prezzo trovato per <b>{game_title}</b>.", parse_mode="HTML")
        return

    allowed_shop_ids = set(TRACKED_SHOPS.keys())
    deals = [d for d in game_data["deals"] if d.get("shop", {}).get("id") in allowed_shop_ids]
    if not deals:
        await update.message.reply_text("😔 Nessun prezzo disponibile sulle piattaforme monitorate.")
        return

    best = min(deals, key=lambda x: x["price"]["amount"])
    lines = [f"⚖️ <b>Confronto prezzi: {game_title}</b>\n"]
    for deal in sorted(deals, key=lambda x: x["price"]["amount"]):
        sid = deal.get("shop", {}).get("id")
        shop = TRACKED_SHOPS.get(sid, deal.get("shop", {}).get("name", "?"))
        price = deal.get("price", {}).get("amount", 0)
        cut = deal.get("cut", 0)
        url = deal.get("url", "")
        lines.append(f"🏪 {shop}: <b>€{price}</b> (-{cut}%) — <a href='{url}'>link</a>")

    best_sid = best.get("shop", {}).get("id")
    best_shop = TRACKED_SHOPS.get(best_sid, best.get("shop", {}).get("name", "?"))
    best_price = best.get("price", {}).get("amount", 0)
    lines.append(f"\n🥇 <b>Prezzo più basso: {best_shop} a €{best_price}</b>")

    await update.message.reply_text("\n".join(lines), parse_mode="HTML", disable_web_page_preview=True)

async def cmd_setsoglia(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id  = update.effective_user.id
    username = update.effective_user.username or update.effective_user.first_name
    prefs    = get_user_deal_prefs(user_id)

    if not context.args:
        await update.message.reply_text(
            f"⚙️ <b>Le tue preferenze offerte:</b>\n\n"
            f"💰 Prezzo massimo: <b>€{prefs['threshold']}</b>\n"
            f"✂️ Sconto minimo: <b>{prefs['min_cut']}%</b>\n"
            f"⭐ Review minima: <b>{prefs['min_score']}</b>\n\n"
            f"<b>Come aggiornare:</b>\n"
            f"/setsoglia prezzo 15\n"
            f"/setsoglia sconto 50\n"
            f"/setsoglia review 70",
            parse_mode="HTML"
        )
        return

    if len(context.args) < 2:
        await update.message.reply_text(
            "❌ Uso:\n"
            "/setsoglia prezzo 15\n"
            "/setsoglia sconto 50\n"
            "/setsoglia review 70"
        )
        return

    campo  = context.args[0].lower()
    valore = context.args[1].replace(",", ".")

    try:
        if campo == "prezzo":
            v = float(valore)
            if v <= 0 or v > 100:
                await update.message.reply_text("❌ Il prezzo deve essere tra 0 e 100.")
                return
            set_user_deal_prefs(user_id, username, threshold=v)
            await update.message.reply_text(f"✅ Prezzo massimo impostato a <b>€{v}</b>", parse_mode="HTML")

        elif campo == "sconto":
            v = int(float(valore))
            if v < 0 or v > 100:
                await update.message.reply_text("❌ Lo sconto deve essere tra 0 e 100.")
                return
            set_user_deal_prefs(user_id, username, min_cut=v)
            await update.message.reply_text(f"✅ Sconto minimo impostato a <b>{v}%</b>", parse_mode="HTML")

        elif campo == "review":
            v = int(float(valore))
            if v < 0 or v > 100:
                await update.message.reply_text("❌ Il review score deve essere tra 0 e 100.")
                return
            set_user_deal_prefs(user_id, username, min_score=v)
            await update.message.reply_text(f"✅ Review minima impostata a <b>{v}</b>", parse_mode="HTML")

        else:
            await update.message.reply_text(
                "❌ Campo non riconosciuto. Usa: prezzo, sconto, oppure review"
            )

    except ValueError:
        await update.message.reply_text("❌ Valore non valido.")

# ─── CALLBACK BUTTONS ────────────────────────────────────────────────────────

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
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

        await query.edit_message_text(
            f"🔍 Carico prezzi per <b>{game_title}</b>...", parse_mode="HTML"
        )

        prices_data = get_game_prices([game_id])
        game_data   = prices_data.get(game_id)

        if not game_data or not game_data.get("deals"):
            await query.edit_message_text(
                f"😔 Nessun prezzo trovato per <b>{game_title}</b>.", parse_mode="HTML"
            )
            return

        lines = [f"💰 <b>Prezzi per {game_title}:</b>\n"]
        for deal in sorted(game_data["deals"], key=lambda x: x["price"]["amount"])[:8]:
            shop    = deal.get("shop", {}).get("name", "?")
            price   = deal.get("price", {}).get("amount", 0)
            cut     = deal.get("cut", 0)
            url     = deal.get("url", "")
            cut_str = f" (-{cut}%)" if cut > 0 else ""
            lines.append(f"🏪 {shop}: <b>€{price}</b>{cut_str} — <a href='{url}'>link</a>")

        await query.edit_message_text(
            "\n".join(lines), parse_mode="HTML", disable_web_page_preview=True
        )

    elif action == "addwish":
        game = context.user_data.get("add_results", {}).get(idx)
        if not game:
            await query.edit_message_text("❌ Sessione scaduta, rifai /add.")
            return

        # Recupera prezzo attuale
        current_price = None
        try:
            prices_data = get_game_prices([game["id"]])
            game_data   = prices_data.get(game["id"])
            if game_data and game_data.get("deals"):
                best          = min(game_data["deals"], key=lambda x: x["price"]["amount"])
                current_price = best["price"]["amount"]
        except:
            pass

        user  = query.from_user
        added = wishlist_add(
            user.id,
            user.username or user.first_name,
            game["id"],
            game["title"],
            current_price
        )

        price_str = f" (prezzo attuale: €{current_price})" if current_price is not None else ""

        if added:
            await query.edit_message_text(
                f"✅ <b>{game['title']}</b> aggiunto alla wishlist{price_str}!\n\n"
                f"🔔 <b>Come funziona il monitoraggio prezzi:</b>\n"
                f"Ogni ora controllo automaticamente il prezzo di questo gioco. "
                f"Se scende rispetto al prezzo attuale, ti mando un messaggio direttamente qui.\n\n"
                f"Non devi fare nulla, ci penso io! 😊",
                parse_mode="HTML"
            )
        else:
            await query.edit_message_text(
                f"ℹ️ <b>{game['title']}</b> è già nella tua wishlist.\n"
                f"Stai già ricevendo notifiche sui cali di prezzo.",
                parse_mode="HTML"
            )

    elif action == "remwish":
        item = context.user_data.get("remove_items", {}).get(idx)
        if not item:
            await query.edit_message_text("❌ Sessione scaduta, rifai /remove.")
            return

        removed = wishlist_remove(query.from_user.id, item["game_slug"])
        if removed:
            await query.edit_message_text(
                f"✅ <b>{item['game_title']}</b> rimosso dalla wishlist.", parse_mode="HTML"
            )
        else:
            await query.edit_message_text("❌ Gioco non trovato nella wishlist.")


# ─── AVVIO ────────────────────────────────────────────────────────────────────

def main():
    init_db()

    app = ApplicationBuilder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start",    cmd_start))
    app.add_handler(CommandHandler("help",     cmd_help))
    app.add_handler(CommandHandler("deals",    cmd_deals))
    app.add_handler(CommandHandler("cerca",    cmd_cerca))
    app.add_handler(CommandHandler("add",      cmd_add))
    app.add_handler(CommandHandler("remove",   cmd_remove))
    app.add_handler(CommandHandler("wishlist", cmd_wishlist))
    app.add_handler(CommandHandler("offerte", cmd_offerte))
    app.add_handler(CommandHandler("offerte_shop", cmd_offerte_shop))
    app.add_handler(CommandHandler("confronta", cmd_confronta))
    app.add_handler(CommandHandler("setsoglia", cmd_setsoglia))
    app.add_handler(CallbackQueryHandler(handle_callback))

    print("✅ Bot avviato...")
    app.run_polling(drop_pending_updates=True)

if __name__ == "__main__":
    main()
