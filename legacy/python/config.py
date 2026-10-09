import os
import logging
from dotenv import load_dotenv

load_dotenv()

# ─── CREDENZIALI ──────────────────────────────────────────────────────────────

BOT_TOKEN       = os.getenv("TELEGRAM_BOT_TOKEN")
CHAT_ID         = os.getenv("TELEGRAM_CHAT_ID")
CHAT_ID_GROUP   = os.getenv("TELEGRAM_CHAT_GROUP")
ITAD_API_KEY    = os.getenv("ITAD_API_KEY")
DATABASE_URL    = os.getenv("DATABASE_URL")
GGDEALS_API_KEY = os.getenv("GGDEALS_API_KEY")

# ─── COSTANTI ─────────────────────────────────────────────────────────────────

STATE_FILE = "state.json"

TRACKED_SHOPS = {
    6:  "Fanatical",
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

# ─── LOGGING ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
file_handler = logging.FileHandler("bot.log")
file_handler.setLevel(logging.DEBUG)
logging.getLogger().addHandler(file_handler)