import os
import logging
import requests
import psycopg2
import psycopg2.extras
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

def wishlist_add(user_id: int, username: str, slug: str, title: str) -> bool:
    db = get_db()
    cursor = db.cursor()
    try:
        cursor.execute(
            """INSERT INTO itad_wishlist (user_id, username, game_slug, game_title)
               VALUES (%s, %s, %s, %s)""",
            (user_id, username, slug, title)
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
        "/remove — rimuovi un gioco dalla wishlist\n"
        "/help — mostra questo messaggio",
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

    keyboard = [
        [InlineKeyboardButton(g["title"], callback_data=f"price|{g['id']}|{g['title'][:40]}")]
        for g in results[:5]
    ]
    keyboard.append([InlineKeyboardButton("❌ Annulla", callback_data="cancel|0|0")])

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

    keyboard = [
        [InlineKeyboardButton(g["title"], callback_data=f"addwish|{g['id']}|{g['title'][:40]}")]
        for g in results[:5]
    ]
    keyboard.append([InlineKeyboardButton("❌ Annulla", callback_data="cancel|0|0")])

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

    keyboard = [
        [InlineKeyboardButton(f"❌ {i['game_title']}", callback_data=f"remwish|{i['game_slug']}|{i['game_title'][:40]}")]
        for i in items
    ]
    keyboard.append([InlineKeyboardButton("🔙 Annulla", callback_data="cancel|0|0")])

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

    lines = [f"📋 <b>La tua wishlist ({len(items)} giochi):</b>\n"]
    for i, item in enumerate(items, 1):
        lines.append(f"{i}. {item['game_title']}")
    lines.append("\nUsa /remove per rimuovere un gioco.")

    await update.message.reply_text("\n".join(lines), parse_mode="HTML")


# ─── CALLBACK BUTTONS ────────────────────────────────────────────────────────

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    parts = query.data.split("|", 2)
    action, game_id, game_title = parts[0], parts[1], parts[2]

    if action == "cancel":
        await query.edit_message_text("✅ Operazione annullata.")
        return

    if action == "price":
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
            shop  = deal.get("shop", {}).get("name", "?")
            price = deal.get("price", {}).get("amount", 0)
            cut   = deal.get("cut", 0)
            url   = deal.get("url", "")
            cut_str = f" (-{cut}%)" if cut > 0 else ""
            lines.append(f"🏪 {shop}: <b>€{price}</b>{cut_str} — <a href='{url}'>link</a>")

        await query.edit_message_text(
            "\n".join(lines), parse_mode="HTML", disable_web_page_preview=True
        )

    elif action == "addwish":
        user   = query.from_user
        added  = wishlist_add(user.id, user.username or user.first_name, game_id, game_title)

        if added:
            await query.edit_message_text(
                f"✅ <b>{game_title}</b> aggiunto alla wishlist!", parse_mode="HTML"
            )
        else:
            await query.edit_message_text(
                f"ℹ️ <b>{game_title}</b> è già nella tua wishlist.", parse_mode="HTML"
            )

    elif action == "remwish":
        removed = wishlist_remove(query.from_user.id, game_id)
        if removed:
            await query.edit_message_text(
                f"✅ <b>{game_title}</b> rimosso dalla wishlist.", parse_mode="HTML"
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
    app.add_handler(CallbackQueryHandler(handle_callback))

    print("✅ Bot avviato...")
    app.run_polling()

if __name__ == "__main__":
    main()