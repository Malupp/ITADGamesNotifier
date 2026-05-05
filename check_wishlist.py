import os
import requests
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN    = os.getenv("TELEGRAM_BOT_TOKEN")
ITAD_API_KEY = os.getenv("ITAD_API_KEY")
DATABASE_URL = os.getenv("DATABASE_URL")


def get_db():
    return psycopg2.connect(DATABASE_URL, sslmode="require")


def get_all_wishlist_items() -> list:
    """Ritorna tutti i giochi in wishlist con user_id e prezzi salvati."""
    db = get_db()
    cursor = db.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cursor.execute("""
        SELECT user_id, username, game_slug, game_title, 
               price_at_add, last_notified_price
        FROM itad_wishlist
        WHERE game_slug IS NOT NULL
    """)
    rows = cursor.fetchall()
    cursor.close()
    db.close()
    return rows


def get_prices_batch(game_ids: list) -> dict:
    """Recupera prezzi per una lista di game UUID."""
    response = requests.post(
        "https://api.isthereanydeal.com/games/prices/v3",
        params={"key": ITAD_API_KEY, "country": "IT"},
        json=game_ids
    )
    response.raise_for_status()
    return {item["id"]: item for item in response.json()}


def update_last_notified_price(user_id: int, slug: str, price: float):
    db = get_db()
    cursor = db.cursor()
    cursor.execute(
        """UPDATE itad_wishlist 
           SET last_notified_price=%s 
           WHERE user_id=%s AND game_slug=%s""",
        (price, user_id, slug)
    )
    db.commit()
    cursor.close()
    db.close()


def send_telegram_message(chat_id: int, text: str):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    requests.post(url, json={
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True
    }).raise_for_status()


def main():
    items = get_all_wishlist_items()
    if not items:
        print("Wishlist vuota, nulla da controllare.")
        return

    # Raggruppa per game_slug per fare una sola chiamata API per gioco
    games_map = {}  # slug -> lista di item
    for item in items:
        slug = item["game_slug"]
        if slug not in games_map:
            games_map[slug] = []
        games_map[slug].append(item)

    print(f"Controllo prezzi per {len(games_map)} giochi unici...")

    # Recupera prezzi in batch (max 100 per chiamata)
    slugs = list(games_map.keys())
    prices_data = get_prices_batch(slugs)

    notified = 0
    for slug, game_items in games_map.items():
        game_data = prices_data.get(slug)
        if not game_data or not game_data.get("deals"):
            continue

        # Prezzo minimo attuale
        best_deal = min(game_data["deals"], key=lambda x: x["price"]["amount"])
        current_price = best_deal["price"]["amount"]
        shop          = best_deal.get("shop", {}).get("name", "?")
        deal_url      = best_deal.get("url", "")

        for item in game_items:
            last_price = item["last_notified_price"]
            title = item["game_title"]
            user_id = item["user_id"]

            should_notify = last_price is None or current_price < float(last_price)

            if should_notify:
                drop_str = ""  # inizializzato qui prima di tutto
                if last_price is not None:
                    drop = round(float(last_price) - current_price, 2)
                    drop_pct = round((drop / float(last_price)) * 100)
                    drop_str = f"\n📉 Era €{last_price} → risparmi €{drop} ({drop_pct}%)"

                message = (
                    f"🔔 <b>Calo prezzo wishlist!</b>\n\n"
                    f"🎮 <b>{title}</b>\n"
                    f"🏪 {shop}\n"
                    f"💰 Ora a <b>€{current_price}</b>"
                    f"{drop_str}\n"
                    f"🔗 {deal_url}"
                )

                send_telegram_message(user_id, message)
                notified += 1
                print(f"  → Notificato {item['username']}: {title} ora €{current_price}")

            # Aggiorna SEMPRE se il prezzo è cambiato
            if last_price is None or current_price != float(last_price):
                update_last_notified_price(user_id, slug, current_price)
                print(f"  → DB aggiornato: {title} €{last_price} → €{current_price}")

                message = (
                    f"🔔 <b>Calo prezzo wishlist!</b>\n\n"
                    f"🎮 <b>{title}</b>\n"
                    f"🏪 {shop}\n"
                    f"💰 Ora a <b>€{current_price}</b>"
                    f"{drop_str}\n"
                    f"🔗 {deal_url}"
                )

                send_telegram_message(user_id, message)
                update_last_notified_price(user_id, slug, current_price)
                notified += 1
                print(f"  → Notificato {item['username']}: {title} ora €{current_price}")

    print(f"Inviate {notified} notifiche.")


if __name__ == "__main__":
    main()