import requests
import json
import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
CHAT_ID_GROUP = os.getenv("TELEGRAM_CHAT_GROUP")  # opzionale
ITAD_API_KEY = os.getenv("ITAD_API_KEY")

STATE_FILE = "state.json"


def load_state():
    try:
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    except:
        return {"sent_deals": []}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


def get_free_games():
    url = "https://api.isthereanydeal.com/deals/v2"
    params = {
        "key": ITAD_API_KEY,
        "country": "IT",
        "limit": 50,
        "sort": "price",
    }

    response = requests.get(url, params=params)
    response.raise_for_status()

    data = response.json()

    return [
        deal for deal in data.get("list", [])
        if deal.get("deal", {}).get("price", {}).get("amount") == 0
    ]


def format_expiry(expiry_str):
    if not expiry_str:
        return None
    try:
        from datetime import datetime
        dt = datetime.fromisoformat(expiry_str)
        return dt.strftime("%d/%m/%Y alle %H:%M")
    except:
        return None

def send_telegram_message(text):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"

    targets = [c for c in [CHAT_ID, CHAT_ID_GROUP] if c]  # ignora se non impostato

    for chat_id in targets:
        payload = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": False
        }
        requests.post(url, json=payload).raise_for_status()


def main():
    state = load_state()
    sent = set(state["sent_deals"])

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

        send_telegram_message(message)
        sent.add(deal_id)
        new_count += 1
        print(f"  → Inviato: {title} ({shop})")

    print(f"Inviati {new_count} nuovi giochi")

    state["sent_deals"] = list(sent)
    save_state(state)


if __name__ == "__main__":
    main()