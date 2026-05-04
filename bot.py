import os
import logging
import requests
import psycopg2
import psycopg2.extras

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ApplicationBuilder, CommandHandler, ContextTypes,
    CallbackQueryHandler
)

load_dotenv()

BOT_TOKEN    = os.getenv("TELEGRAM_BOT_TOKEN")
ITAD_API_KEY = os.getenv("ITAD_API_KEY")
DATABASE_URL = os.getenv("DATABASE_URL")  # stringa di connessione Neon

logging.basicConfig(level=logging.INFO)


# ─── DATABASE ────────────────────────────────────────────────────────────────

def get_db():
    return psycopg2.connect(DATABASE_URL, sslmode="require")

def init_db():
    db = get_db()
    cursor = db.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS itad_wishlist (
            id          SERIAL PRIMARY KEY,
            user_id     BIGINT NOT NULL,
            username    VARCHAR(255),
            game_slug   VARCHAR(255) NOT NULL,
            game_title  VARCHAR(255) NOT NULL,
            added_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, game_slug)
        )
    """)
    db.commit()
    cursor.close()
    db.close()


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
        """SELECT game_slug, game_title, added_at
           FROM itad_wishlist
           WHERE user_id=%s
           ORDER BY added_at DESC""",
        (user_id,)
    )
    rows = cursor.fetchall()
    cursor.close()
    db.close()
    return rows


# ─── COMANDI ──────────────────────────────────────────────────────────────────

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 Ciao! Sono il tuo notificatore di offerte gaming.\n\n"
        "📌 <b>Comandi disponibili:</b>\n"
        "/deals — giochi gratuiti adesso\n"
        "/cerca &lt;titolo&gt; — cerca prezzi di un gioco\n"
        "/wishlist — vedi la tua wishlist\n"
        "/add &lt;titolo&gt; — aggiungi un gioco alla wishlist\n"
        "  <i>└ ti avviso automaticamente se il prezzo scende!</i>\n"
        "/remove — rimuovi un gioco dalla wishlist\n"
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

    # Salva i risultati in memoria per recuperarli nel callback
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

    # Recupera prezzi per tutti i giochi in una sola chiamata
    slugs = [item["game_slug"] for item in items]
    try:
        prices_data = get_game_prices(slugs)
    except:
        prices_data = {}

    lines = [f"📋 <b>La tua wishlist ({len(items)} giochi):</b>\n"]

    for item in items:
        title = item["game_title"]
        slug  = item["game_slug"]
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


# ─── CALLBACK BUTTONS ────────────────────────────────────────────────────────

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    parts = query.data.split("|")
    action = parts[0]

    if action == "cancel":
        await query.edit_message_text("✅ Operazione annullata.")
        return

    if action == "price":
        idx = parts[1]
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
        game_data = prices_data.get(game_id)

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

        idx = parts[1]

        game = context.user_data.get("add_results", {}).get(idx)

        if not game:
            await query.edit_message_text("❌ Sessione scaduta, rifai /add.")

            return

        # Recupera il prezzo attuale

        current_price = None

        try:

            prices_data = get_game_prices([game["id"]])

            game_data = prices_data.get(game["id"])

            if game_data and game_data.get("deals"):
                best = min(game_data["deals"], key=lambda x: x["price"]["amount"])

                current_price = best["price"]["amount"]

        except:

            pass

        user = query.from_user

        added = wishlist_add(user.id, user.username or user.first_name, game["id"], game["title"], current_price)

        price_str = f" (prezzo attuale: €{current_price})" if current_price is not None else ""

        if added:
            await query.edit_message_text(
                f"✅ <b>{game['title']}</b> aggiunto alla wishlist!\n\n"
                f"🔔 <b>Come funziona il monitoraggio prezzi:</b>\n"
                f"Ogni ora controllo automaticamente il prezzo di questo gioco. "
                f"Se scende rispetto al prezzo attuale (€{current_price if current_price is not None else '?'}), "
                f"ti mando un messaggio direttamente qui.\n\n"
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
        idx  = parts[1]
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


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"OK")

    def log_message(self, format, *args):
        return


def start_health_server():
    port = int(os.getenv("PORT", "10000"))
    server = HTTPServer(("0.0.0.0", port), HealthHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    logging.info(f"Health server listening on 0.0.0.0:{port}")

# ─── AVVIO ────────────────────────────────────────────────────────────────────

def main():
    init_db()
    start_health_server()
    app = ApplicationBuilder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start",    cmd_start))
    app.add_handler(CommandHandler("help",     cmd_help))
    app.add_handler(CommandHandler("deals",    cmd_deals))
    app.add_handler(CommandHandler("cerca",    cmd_cerca))
    app.add_handler(CommandHandler("add",      cmd_add))
    app.add_handler(CommandHandler("remove",   cmd_remove))
    app.add_handler(CommandHandler("wishlist", cmd_wishlist))
    app.add_handler(CallbackQueryHandler(handle_callback))

    print("✅ Bot avviato...")
    app.run_polling(drop_pending_updates=True)

    # Webhook invece di polling
    WEBHOOK_URL = os.getenv("WEBHOOK_URL")  # es. https://itad-bot.onrender.com
    PORT = int(os.getenv("PORT", 8443))

    app.run_webhook(
        listen="0.0.0.0",
        port=PORT,
        webhook_url=f"{WEBHOOK_URL}/webhook",
        url_path="/webhook",
    )

if __name__ == "__main__":
    main()
