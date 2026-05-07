import logging
from itad_api import get_game_prices
from telegram_utils import send_message
from db import wishlist_get_all, wishlist_update_notified, prefs_get

logger = logging.getLogger(__name__)


def main():
    items = wishlist_get_all()
    if not items:
        print("Wishlist vuota, nulla da controllare.")
        return

    # Raggruppa per game_slug
    games_map: dict = {}
    for item in items:
        slug = item["game_slug"]
        if slug not in games_map:
            games_map[slug] = []
        games_map[slug].append(item)

    print(f"Controllo prezzi per {len(games_map)} giochi unici...")

    prices_data = get_game_prices(list(games_map.keys()))

    notified = 0
    for slug, game_items in games_map.items():
        game_data = prices_data.get(slug)
        if not game_data or not game_data.get("deals"):
            continue

        best_deal     = min(game_data["deals"], key=lambda x: x["price"]["amount"])
        current_price = best_deal["price"]["amount"]
        current_shop  = best_deal.get("shop", {}).get("name", "?")
        current_url   = best_deal.get("url", "")

        for item in game_items:
            last_price   = item["last_notified_price"]
            last_shop    = item.get("last_notified_shop")
            title        = item["game_title"]
            user_id      = item["user_id"]
            price_at_add = item.get("price_at_add")

            # Soglia sconto: per gioco se impostata, altrimenti globale utente
            item_pct      = item.get("min_discount_pct")
            global_pct    = prefs_get(user_id)["min_discount_pct"]
            effective_pct = item_pct if item_pct is not None else global_pct

            # Calcola % sconto rispetto al prezzo all'aggiunta
            if price_at_add and float(price_at_add) > 0 and current_price < float(price_at_add):
                discount_pct = round((float(price_at_add) - current_price) / float(price_at_add) * 100)
            else:
                discount_pct = 0

            price_dropped   = last_price is None or current_price < float(last_price)
            discount_enough = discount_pct >= effective_pct
            should_notify   = price_dropped and discount_enough

            if should_notify:
                drop_str = ""
                if last_price is not None:
                    drop     = round(float(last_price) - current_price, 2)
                    drop_pct = round((drop / float(last_price)) * 100)
                    drop_str = f"\n📉 Era €{last_price} → risparmi €{drop} ({drop_pct}%)"
                    if last_shop and last_shop != current_shop:
                        drop_str += f"\n🏪 Miglior prezzo ora su {current_shop} (prima: {last_shop})"

                message = (
                    f"🔔 <b>Calo prezzo wishlist!</b>\n\n"
                    f"🎮 <b>{title}</b>\n"
                    f"🏪 {current_shop}\n"
                    f"💰 Ora a <b>€{current_price}</b>"
                    f"{drop_str}\n"
                    f"🔗 {current_url}"
                )

                send_message(user_id, message)
                notified += 1
                print(f"  → Notificato {item['username']}: {title} ora €{current_price}")

            # Aggiorna DB se prezzo o shop sono cambiati
            price_changed = last_price is None or current_price != float(last_price)
            shop_changed  = last_shop != current_shop
            if price_changed or shop_changed:
                wishlist_update_notified(user_id, slug, current_price, current_shop, current_url)
                print(f"  → DB aggiornato: {title} €{last_price} ({last_shop}) → €{current_price} ({current_shop})")

    print(f"Inviate {notified} notifiche.")


if __name__ == "__main__":
    main()