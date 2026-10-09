import json
import logging
from config import STATE_FILE
from itad_api import get_free_games
from telegram_utils import broadcast, format_expiry

logger = logging.getLogger(__name__)


def load_state() -> dict:
    try:
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {"sent_deals": []}

def save_state(state: dict):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


def main():
    state = load_state()
    sent  = set(state["sent_deals"])

    deals = get_free_games()
    print(f"Trovati {len(deals)} giochi gratuiti")

    new_count = 0
    for deal in deals:
        deal_id = deal["slug"]
        if deal_id in sent:
            continue

        title   = deal.get("title", "Titolo sconosciuto")
        shop    = deal.get("deal", {}).get("shop", {}).get("name", "Store sconosciuto")
        url     = deal.get("deal", {}).get("url", "")
        regular = deal.get("deal", {}).get("regular", {}).get("amount")
        expiry  = format_expiry(deal.get("deal", {}).get("expiry"))

        price_line  = f"<s>€{regular}</s> → <b>GRATIS</b>" if regular else "<b>GRATIS</b>"
        expiry_line = f"\n⏳ Scade il {expiry}" if expiry else ""

        message = (
            f"🎮 <b>{title}</b>\n"
            f"🏪 {shop}\n"
            f"💰 {price_line}"
            f"{expiry_line}\n"
            f"🔗 {url}"
        )

        broadcast(message)
        sent.add(deal_id)
        new_count += 1
        print(f"  → Inviato: {title} ({shop})")

    print(f"Inviati {new_count} nuovi giochi")
    state["sent_deals"] = list(sent)
    save_state(state)


if __name__ == "__main__":
    main()