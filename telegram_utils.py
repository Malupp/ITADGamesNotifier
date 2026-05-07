import logging
import requests
from config import BOT_TOKEN, CHAT_ID, CHAT_ID_GROUP

logger = logging.getLogger(__name__)


def send_message(chat_id: int | str, text: str, disable_preview: bool = True):
    """Invia un messaggio a un singolo chat_id."""
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    requests.post(url, json={
        "chat_id":                  chat_id,
        "text":                     text,
        "parse_mode":               "HTML",
        "disable_web_page_preview": disable_preview,
    }).raise_for_status()


def broadcast(text: str, disable_preview: bool = False):
    """Invia un messaggio a tutti i target configurati (canale + gruppo opzionale)."""
    targets = list(dict.fromkeys(
        c.strip() for c in [CHAT_ID, CHAT_ID_GROUP] if c and c.strip()
    ))
    for chat_id in targets:
        send_message(chat_id, text, disable_preview=disable_preview)


def format_expiry(expiry_str: str | None) -> str | None:
    if not expiry_str:
        return None
    try:
        from datetime import datetime
        dt = datetime.fromisoformat(expiry_str)
        return dt.strftime("%d/%m/%Y alle %H:%M")
    except Exception:
        return None