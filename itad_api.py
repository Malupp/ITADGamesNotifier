import logging
import requests
from config import ITAD_API_KEY, GGDEALS_API_KEY, TRACKED_SHOPS

logger = logging.getLogger(__name__)


# ─── ITAD ─────────────────────────────────────────────────────────────────────

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

def get_free_games() -> list:
    response = requests.get(
        "https://api.isthereanydeal.com/deals/v2",
        params={"key": ITAD_API_KEY, "country": "IT", "limit": 100, "sort": "price"}
    )
    response.raise_for_status()
    data = response.json()

    results = []
    for d in data.get("list", []):
        price = d.get("deal", {}).get("price", {}).get("amount")
        logger.debug(f"FREE_CHECK: {d.get('title')} → price={price!r} type={type(price).__name__}")
        if price == 0:
            results.append(d)

    logger.debug(f"FREE_GAMES trovati: {len(results)}")
    return results

def get_deals_under_price(max_price: float, min_cut: int = 0, min_score: int = 0,
                           limit: int = 10, fetch_limit: int = None,
                           shop_ids: set = None) -> list:
    params = {
        "key":     ITAD_API_KEY,
        "country": "IT",
        "limit":   fetch_limit if fetch_limit else max(50, min(limit * 10, 500)),
        "sort":    "rank",
    }
    if shop_ids:
        params["shops"] = ",".join(str(sid) for sid in shop_ids)

    response = requests.get("https://api.isthereanydeal.com/deals/v2", params=params)
    response.raise_for_status()
    data = response.json()

    results = []
    for deal in data.get("list", []):
        price = deal.get("deal", {}).get("price", {}).get("amount")
        cut   = deal.get("deal", {}).get("cut", 0)

        if price is None or price <= 0 or price > max_price:
            continue
        if cut < min_cut:
            continue

        reviews     = deal.get("reviews") or {}
        steam_score = (reviews.get("steam") or {}).get("score")

        if min_score > 0 and (steam_score is None or steam_score < min_score):
            continue

        deal["_steam_score"] = steam_score
        results.append(deal)

        if len(results) >= limit:
            break

    return results


# ─── HELPERS PARSING ──────────────────────────────────────────────────────────

def parse_shop_names(raw_values: list) -> set:
    if not raw_values:
        return set(TRACKED_SHOPS.keys())

    by_name = {name.lower(): sid for sid, name in TRACKED_SHOPS.items()}
    text    = " ".join(raw_values).replace(",", " ").strip().lower()
    if not text:
        return set(TRACKED_SHOPS.keys())

    resolved = set()
    for name in sorted(by_name.keys(), key=len, reverse=True):
        if name in text:
            resolved.add(by_name[name])
            text = text.replace(name, " ")

    return resolved

def parse_price_filter(value: str):
    """
    Supporta soglia massima ("10") o range ("5-20").
    Ritorna (min_price, max_price).
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
    return [
        d for d in deals
        if d.get("deal", {}).get("shop", {}).get("id") in shop_ids
    ]


# ─── GG.DEALS ─────────────────────────────────────────────────────────────────

def get_steam_appid(title: str) -> str | None:
    try:
        response = requests.get(
            "https://store.steampowered.com/api/storesearch/",
            params={"term": title, "l": "italian", "cc": "IT"},
            timeout=5
        )
        items = response.json().get("items", [])
        if items:
            return str(items[0]["id"])
    except Exception as e:
        logger.debug(f"get_steam_appid error: {e}")
    return None

def get_ggdeals_prices(steam_app_ids: list) -> dict:
    if not GGDEALS_API_KEY or not steam_app_ids:
        logger.debug("gg.deals: API key mancante o lista vuota")
        return {}
    try:
        response = requests.get(
            "https://api.gg.deals/v1/prices/",
            params={"key": GGDEALS_API_KEY, "ids": ",".join(steam_app_ids), "region": "it"},
            timeout=10
        )
        logger.debug(f"gg.deals status: {response.status_code} — {response.text[:200]}")
        response.raise_for_status()
        return response.json().get("data", {})
    except Exception as e:
        logger.debug(f"gg.deals errore: {e}")
        return {}