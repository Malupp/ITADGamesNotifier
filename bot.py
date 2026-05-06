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

from check_wishlist import get_user_min_discount

load_dotenv()

BOT_TOKEN    = os.getenv("TELEGRAM_BOT_TOKEN")
ITAD_API_KEY = os.getenv("ITAD_API_KEY")
DATABASE_URL = os.getenv("DATABASE_URL")
GGDEALS_API_KEY = os.getenv("GGDEALS_API_KEY")

logging.basicConfig(level=logging.INFO)

TRACKED_SHOPS = {
    6: "Fanatical",
    16: "Epic Games Store",
    24: "GamersGate",
    35: "GOG",
    36: "GreenManGaming",
    37: "Humble Store",
    42: "IndieGala",
    48: "Microsoft Store",
    52: "EA Store",
    61: "Steam",
    62: "Ubisoft Store",
    64: "WinGameStore",
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
    cursor.execute("""
        ALTER TABLE itad_wishlist
        ADD COLUMN IF NOT EXISTS last_notified_shop VARCHAR(255) DEFAULT NULL
    """)
    cursor.execute("""
        ALTER TABLE itad_wishlist
        ADD COLUMN IF NOT EXISTS last_notified_url TEXT DEFAULT NULL
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

def wishlist_add(user_id: int, username: str, slug: str, title: str, price: float = None, shop: str = None, url: str = None) -> bool:
    db = get_db()
    cursor = db.cursor()
    try:
        cursor.execute(
            """INSERT INTO itad_wishlist (
                   user_id, username, game_slug, game_title,
                   price_at_add, last_notified_price, last_notified_shop, last_notified_url
               )
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (user_id, username, slug, title, price, price, shop, url)
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
        """SELECT game_slug, game_title, price_at_add, last_notified_price, 
                  added_at, min_discount_pct
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

def get_deals_under_price(max_price: float, min_cut: int = 0, min_score: int = 0, limit: int = 10, fetch_limit: int = None, shop_ids: set = None) -> list:
    params = {
        "key": ITAD_API_KEY,
        "country": "IT",
        "limit": fetch_limit if fetch_limit else max(50, min(limit * 10, 500)),
        "sort": "rank",
    }

    # Passa gli shop_ids direttamente all'API se specificati
    if shop_ids:
        params["shops"] = ",".join(str(sid) for sid in shop_ids)

    response = requests.get(
        "https://api.isthereanydeal.com/deals/v2",
        params=params
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

        deal["_steam_score"] = steam_score
        results.append(deal)

        if len(results) >= limit:
            break

    return results

def parse_shop_names(raw_values: list) -> set:
    """
    Accetta nomi shop separati da spazio o virgola.
    Esempi:
      /offerte_shop 20 50 70 steam epic games store
      /offerte_shop 20 50 70 steam,gog,fanatical
    """
    if not raw_values:
        return set(TRACKED_SHOPS.keys())

    by_name = {name.lower(): sid for sid, name in TRACKED_SHOPS.items()}
    text = " ".join(raw_values).replace(",", " ").strip().lower()
    if not text:
        return set(TRACKED_SHOPS.keys())

    resolved = set()

    # Match nomi lunghi prima (es. "epic games store", "green man gaming")
    for name in sorted(by_name.keys(), key=len, reverse=True):
        if name in text:
            resolved.add(by_name[name])
            text = text.replace(name, " ")

    return resolved

def parse_price_filter(value: str):
    """
    Supporta:
    - soglia massima: "10"
    - range: "5-20"
    Ritorna tuple (min_price, max_price)
    """
    cleaned = value.strip().replace(",", ".")
    if "-" in cleaned:
        left, right = cleaned.split("-", 1)
        min_price = float(left.strip())
        max_price = float(right.strip())
        if min_price < 0 or max_price <= 0 or min_price > max_price:
            raise ValueError("range prezzo non valido")
        return min_price, max_price

    max_price = float(cleaned)
    if max_price <= 0:
        raise ValueError("soglia prezzo non valida")
    return 0.0, max_price

def filter_deals_by_shop_ids(deals: list, shop_ids: set) -> list:
    filtered = []
    for deal in deals:
        shop = deal.get("deal", {}).get("shop", {})
        shop_id = shop.get("id")
        if shop_id in shop_ids:
            filtered.append(deal)
    return filtered


#  ─── GG Deals ──────────────────────────────────────────────────────────────────

def get_steam_appid(title: str) -> str | None:
    """Cerca lo Steam App ID dal titolo tramite Steam Search API."""
    try:
        response = requests.get(
            "https://store.steampowered.com/api/storesearch/",
            params={"term": title, "l": "italian", "cc": "IT"},
            timeout=5
        )
        data = response.json()
        items = data.get("items", [])
        if items:
            return str(items[0]["id"])
    except:
        pass
    return None

def get_ggdeals_prices(steam_app_ids: list) -> dict:
    if not GGDEALS_API_KEY or not steam_app_ids:
        print("DEBUG gg.deals: API key mancante o lista vuota")
        return {}

    try:
        response = requests.get(
            "https://api.gg.deals/v1/prices/by-steam-app-id/",
            params={
                "key": GGDEALS_API_KEY,
                "ids": ",".join(steam_app_ids),
                "region": "it"
            },
            timeout=10
        )

        print(f"DEBUG gg.deals status: {response.status_code}")
        print(f"DEBUG gg.deals response: {response.text[:300]}")

        response.raise_for_status()
        data = response.json()

        return data.get("data", {})

    except Exception as e:
        print(f"DEBUG gg.deals errore: {e}")
        return {}

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
        "/offerte_shop [prezzo o range] [shop...] — migliore offerta per piattaforma\n"
        "  <i>└ es. /offerte_shop 10 steam epic games store</i>\n"
        "  <i>└ es. /offerte_shop 5-20 steam,gog,fanatical</i>\n"
        "  <i>└ es. /offerte_shop steam,epic games store (usa la soglia default)</i>\n"
        "/confronta &lt;titolo&gt; — confronta i prezzi su tutte le piattaforme monitorate\n"
        "/setsoglia prezzo|sconto|review &lt;valore&gt; — imposta i tuoi filtri\n"
        "/setsconto [%] — soglia sconto globale per notifiche wishlist\n"
        "  <i>└ es. /setsconto 20 → notifica solo se sconto ≥20%</i>\n"
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
    /offerte_shop [prezzo o range] [shop ...]
    Esempi:
      /offerte_shop 10 10 steam epic games store
      /offerte_shop 5-20 20 steam,gog,fanatical
      /offerte_shop steam,epic games store
    """
    args = context.args or []
    prefs = get_user_deal_prefs(update.effective_user.id)
    min_cut = prefs["min_cut"]
    min_score = prefs["min_score"]
    min_price = 0.0
    max_price = prefs["threshold"] if prefs["threshold"] > 0 else 20.0
    shop_tokens = args
    result_limit = 10

    if args:
        first = args[0]
        if any(ch.isdigit() for ch in first):
            try:
                min_price, max_price = parse_price_filter(first)
                shop_tokens = args[1:]
            except ValueError:
                await update.message.reply_text(
                    "❌ Formato prezzo non valido. Usa ad esempio:\n"
                    "/offerte_shop 10 steam epic games store\n"
                    "/offerte_shop 5-20 steam,gog"
                )
                return

    if shop_tokens and shop_tokens[0].isdigit():
        result_limit = max(1, min(30, int(shop_tokens[0])))
        shop_tokens = shop_tokens[1:]

    shop_ids = parse_shop_names(shop_tokens) if shop_tokens else set(TRACKED_SHOPS.keys())
    if not shop_ids:
        await update.message.reply_text(
            "❌ Uso: /offerte_shop [prezzo o range] [shop ...]\n"
            "Esempi:\n"
            "/offerte_shop 10 steam epic games store\n"
            "/offerte_shop 5-20 steam,gog,fanatical\n"
            "/offerte_shop steam,epic games store"
        )
        return

    deals = get_deals_under_price(
        max_price,
        min_cut=min_cut,
        min_score=min_score,
        limit=result_limit,
        fetch_limit=max(200, min(result_limit * 20, 500)),
        shop_ids=shop_ids  # ← passato direttamente all'API
    )
    deals = [
        d for d in deals
        if min_price <= d.get("deal", {}).get("price", {}).get("amount", 0) <= max_price
    ]

    if not deals:
        selected_shops = ", ".join(TRACKED_SHOPS[sid] for sid in sorted(shop_ids))
        await update.message.reply_text(
            "😔 Nessuna offerta trovata con i filtri selezionati.\n"
            f"Shop: {selected_shops}\n"
            f"Range: €{min_price}-€{max_price}\n"
            "Prova ad alzare il prezzo massimo o rimuovere filtri con /setsoglia."
        )
        return

    deals = sorted(
        deals,
        key=lambda d: (
            -d.get("deal", {}).get("cut", 0),
            d.get("deal", {}).get("price", {}).get("amount", 999999)
        )
    )[:result_limit]

    lines = [f"🏷 <b>Migliori sconti per piattaforma</b> (range €{min_price}-€{max_price}, top {result_limit}):\n"]
    for deal in deals:
        sid = deal.get("deal", {}).get("shop", {}).get("id")
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

async def cmd_setsconto(update: Update, context: ContextTypes.DEFAULT_TYPE):
        """
        /setsconto 20          → imposta soglia globale al 20%
        /setsconto             → mostra soglia attuale
        """
        user_id  = update.effective_user.id
        username = update.effective_user.username or update.effective_user.first_name

        if not context.args:
            current = get_user_min_discount(user_id)
            await update.message.reply_text(
                f"🔔 La tua soglia di sconto globale è <b>{current}%</b>\n\n"
                f"Ricevi notifiche solo quando un gioco in wishlist\n"
                f"scende di almeno questa % rispetto al prezzo iniziale.\n\n"
                f"Per cambiarla: /setsconto &lt;percentuale&gt;\n"
                f"Es: /setsconto 20",
                parse_mode="HTML"
            )
            return

        try:
            v = int(context.args[0])
            if v < 1 or v > 99:
                await update.message.reply_text("❌ La soglia deve essere tra 1 e 99.")
                return
        except ValueError:
            await update.message.reply_text("❌ Uso: /setsconto <percentuale>\nEs: /setsconto 20")
            return

        db = get_db()
        cursor = db.cursor()
        cursor.execute(
            """INSERT INTO itad_user_prefs (user_id, username, min_discount_pct)
               VALUES (%s, %s, %s)
               ON CONFLICT (user_id) DO UPDATE SET min_discount_pct=%s, username=%s""",
            (user_id, username, v, v, username)
        )
        db.commit()
        cursor.close()
        db.close()

        await update.message.reply_text(
            f"✅ Soglia sconto globale impostata a <b>{v}%</b>\n"
            f"Riceverai notifiche solo per sconti ≥{v}% rispetto al prezzo iniziale.",
            parse_mode="HTML"
        )


async def cmd_setsconto_gioco(update: Update, context: ContextTypes.DEFAULT_TYPE):
        """
        /setscontog → mostra wishlist con bottoni per impostare soglia per gioco
        """
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

        game_id = game["id"]
        game_title = game["title"]

        await query.edit_message_text(
            f"🔍 Carico prezzi per <b>{game_title}</b>...", parse_mode="HTML"
        )

        prices_data = get_game_prices([game_id])
        game_data = prices_data.get(game_id)

        if not game_data or not game_data.get("deals"):
            await query.edit_message_text(
                f"😔 Nessun prezzo trovato per <b>{game_title}</b>.", parse_mode="HTML"
            )
            return

        lines = [f"💰 <b>Prezzi per {game_title}:</b>\n"]
        for deal in sorted(game_data["deals"], key=lambda x: x["price"]["amount"])[:8]:
            shop = deal.get("shop", {}).get("name", "?")
            price = deal.get("price", {}).get("amount", 0)
            cut = deal.get("cut", 0)
            url = deal.get("url", "")
            cut_str = f" (-{cut}%)" if cut > 0 else ""
            lines.append(f"🏪 {shop}: <b>€{price}</b>{cut_str} — <a href='{url}'>link</a>")

        # Aggiunge prezzo keyshop da gg.deals
        steam_id = get_steam_appid(game_title)
        print(f"DEBUG steam_id per '{game_title}': {steam_id}")
        if steam_id:
            gg_data = get_ggdeals_prices([steam_id])
            print(f"DEBUG gg_data: {gg_data}")
            gg_game = gg_data.get(steam_id)
            print(f"DEBUG gg_data: {gg_game}")
            if gg_game:
                keyshop_price = gg_game.get("prices", {}).get("currentKeyshops")
                gg_url = gg_game.get("url", "")
                if keyshop_price:
                    lines.append(
                        f"\n🔑 <b>Miglior keyshop: €{keyshop_price}</b> "
                        f"— <a href='https://gg.deals{gg_url}'>vedi su gg.deals</a>"
                    )
                    lines.append("<i>(keyshop = rivenditori terzi, acquista a tuo rischio)</i>")

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
        current_shop = None
        current_url = None
        try:
            prices_data = get_game_prices([game["id"]])
            game_data   = prices_data.get(game["id"])
            if game_data and game_data.get("deals"):
                best          = min(game_data["deals"], key=lambda x: x["price"]["amount"])
                current_price = best["price"]["amount"]
                current_shop  = best.get("shop", {}).get("name")
                current_url   = best.get("url")
        except:
            pass

        user  = query.from_user
        added = wishlist_add(
            user.id,
            user.username or user.first_name,
            game["id"],
            game["title"],
            current_price,
            current_shop,
            current_url
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

    elif action == "setscontog":
        item = context.user_data.get("sconto_items", {}).get(idx)
        if not item:
            await query.edit_message_text("❌ Sessione scaduta, rifai /setscontog.")
            return

        context.user_data["sconto_target"] = item

        keyboard = [
            [InlineKeyboardButton("🌐 Usa soglia globale", callback_data="setscontog_apply|None")],
            [InlineKeyboardButton("10%", callback_data="setscontog_apply|10"),
             InlineKeyboardButton("20%", callback_data="setscontog_apply|20"),
             InlineKeyboardButton("30%", callback_data="setscontog_apply|30")],
            [InlineKeyboardButton("40%", callback_data="setscontog_apply|40"),
             InlineKeyboardButton("50%", callback_data="setscontog_apply|50"),
             InlineKeyboardButton("60%", callback_data="setscontog_apply|60")],
            [InlineKeyboardButton("70%", callback_data="setscontog_apply|70"),
             InlineKeyboardButton("75%", callback_data="setscontog_apply|75"),
             InlineKeyboardButton("80%", callback_data="setscontog_apply|80")],
            [InlineKeyboardButton("❌ Annulla", callback_data="cancel")],
        ]

        current_pct = item.get("min_discount_pct")
        current_str = f"{current_pct}%" if current_pct is not None else "soglia globale"

        await query.edit_message_text(
            f"🎮 <b>{item['game_title']}</b>\n"
            f"Soglia attuale: <b>{current_str}</b>\n\n"
            f"Scegli la soglia di sconto per questo gioco:",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode="HTML"
        )

    elif action == "setscontog_apply":
        item = context.user_data.get("sconto_target")
        if not item:
            await query.edit_message_text("❌ Sessione scaduta, rifai /setscontog.")
            return

        raw_pct = parts[1]
        pct = None if raw_pct == "None" else int(raw_pct)

        db = get_db()
        cursor = db.cursor()
        cursor.execute(
            """UPDATE itad_wishlist
               SET min_discount_pct=%s
               WHERE user_id=%s AND game_slug=%s""",
            (pct, query.from_user.id, item["game_slug"])
        )
        db.commit()
        cursor.close()
        db.close()

        if pct is None:
            msg = f"✅ <b>{item['game_title']}</b>\nUsa ora la soglia globale."
        else:
            msg = f"✅ <b>{item['game_title']}</b>\nNotifica quando sconto ≥<b>{pct}%</b>."

        await query.edit_message_text(msg, parse_mode="HTML")


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
    app.add_handler(CommandHandler("setsconto", cmd_setsconto))
    app.add_handler(CommandHandler("setscontog", cmd_setsconto_gioco))
    app.add_handler(CallbackQueryHandler(handle_callback))

    print("✅ Bot avviato...")
    app.run_polling(drop_pending_updates=True)

if __name__ == "__main__":
    main()
