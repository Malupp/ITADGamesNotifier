import requests
import json
import os

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
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
        "filter": "free"
    }

    response = requests.get(url, params=params)
    response.raise_for_status()

    data = response.json()
    return data.get("list", [])

def send_telegram_message(text):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": False
    }

    requests.post(url, json=payload).raise_for_status()

def main():
    state = load_state()
    sent = set(state["sent_deals"])

    deals = get_free_games()

    for deal in deals:
        deal_id = deal["id"]

        if deal_id in sent:
            continue

        title = deal["title"]
        shop = deal.get("shop", {}).get("name", "Unknown Store")
        url = deal.get("url", "")

        message = (
            f"🎮 <b>GRATIS ORA</b>\n"
            f"{title}\n"
            f"🏪 {shop}\n"
            f"🔗 {url}"
        )

        send_telegram_message(message)

        sent.add(deal_id)

    state["sent_deals"] = list(sent)
    save_state(state)

if __name__ == "__main__":
    main()