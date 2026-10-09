import logging
import psycopg2
import psycopg2.extras
from config import DATABASE_URL

logger = logging.getLogger(__name__)


# ─── CONNESSIONE ──────────────────────────────────────────────────────────────

def get_db():
    return psycopg2.connect(DATABASE_URL, sslmode="require")


# ─── INIT ─────────────────────────────────────────────────────────────────────

def init_db():
    db = get_db()
    cursor = db.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS itad_wishlist (
            id                  SERIAL PRIMARY KEY,
            user_id             BIGINT NOT NULL,
            username            VARCHAR(255),
            game_slug           VARCHAR(255) NOT NULL,
            game_title          VARCHAR(255) NOT NULL,
            price_at_add        NUMERIC(10,2) DEFAULT NULL,
            last_notified_price NUMERIC(10,2) DEFAULT NULL,
            added_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, game_slug)
        )
    """)
    cursor.execute("""
        ALTER TABLE itad_wishlist
        ADD COLUMN IF NOT EXISTS last_notified_shop VARCHAR(255) DEFAULT NULL
    """)
    cursor.execute("""
        ALTER TABLE itad_wishlist
        ADD COLUMN IF NOT EXISTS last_notified_url TEXT DEFAULT NULL
    """)
    cursor.execute("""
        ALTER TABLE itad_wishlist
        ADD COLUMN IF NOT EXISTS min_discount_pct INTEGER DEFAULT NULL
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS itad_user_prefs (
            user_id           BIGINT PRIMARY KEY,
            username          VARCHAR(255),
            price_threshold   NUMERIC(10,2) DEFAULT 5.00,
            min_cut           INTEGER DEFAULT 0,
            min_score         INTEGER DEFAULT 0,
            min_discount_pct  INTEGER DEFAULT 10
        )
    """)
    db.commit()
    cursor.close()
    db.close()
    logger.debug("DB inizializzato")


# ─── WISHLIST ─────────────────────────────────────────────────────────────────

def wishlist_add(user_id: int, username: str, slug: str, title: str,
                 price: float = None, shop: str = None, url: str = None) -> bool:
    db = get_db()
    cursor = db.cursor()
    try:
        cursor.execute(
            """INSERT INTO itad_wishlist (
                   user_id, username, game_slug, game_title,
                   price_at_add, last_notified_price, last_notified_shop, last_notified_url
               ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (user_id, username, slug, title, price, price, shop, url)
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
        """SELECT game_slug, game_title, price_at_add, last_notified_price,
                  added_at, min_discount_pct
           FROM itad_wishlist
           WHERE user_id=%s
           ORDER BY added_at DESC""",
        (user_id,)
    )
    rows = cursor.fetchall()
    cursor.close()
    db.close()
    return rows

def wishlist_get_all() -> list:
    """Ritorna tutti i giochi in wishlist — usato da check_wishlist."""
    db = get_db()
    cursor = db.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cursor.execute("""
        SELECT user_id, username, game_slug, game_title,
               price_at_add, last_notified_price, last_notified_shop,
               last_notified_url, min_discount_pct
        FROM itad_wishlist
        WHERE game_slug IS NOT NULL
    """)
    rows = cursor.fetchall()
    cursor.close()
    db.close()
    return rows

def wishlist_update_notified(user_id: int, slug: str, price: float,
                              shop: str, url: str):
    db = get_db()
    cursor = db.cursor()
    cursor.execute(
        """UPDATE itad_wishlist
           SET last_notified_price=%s,
               last_notified_shop=%s,
               last_notified_url=%s
           WHERE user_id=%s AND game_slug=%s""",
        (price, shop, url, user_id, slug)
    )
    db.commit()
    cursor.close()
    db.close()

def wishlist_set_discount(user_id: int, slug: str, pct: int | None):
    db = get_db()
    cursor = db.cursor()
    cursor.execute(
        "UPDATE itad_wishlist SET min_discount_pct=%s WHERE user_id=%s AND game_slug=%s",
        (pct, user_id, slug)
    )
    db.commit()
    cursor.close()
    db.close()


# ─── USER PREFS ───────────────────────────────────────────────────────────────

def prefs_get(user_id: int) -> dict:
    db = get_db()
    cursor = db.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cursor.execute(
        "SELECT price_threshold, min_cut, min_score, min_discount_pct FROM itad_user_prefs WHERE user_id=%s",
        (user_id,)
    )
    row = cursor.fetchone()
    cursor.close()
    db.close()
    return {
        "threshold":       float(row["price_threshold"]) if row and row["price_threshold"] else 5.00,
        "min_cut":         int(row["min_cut"])           if row and row["min_cut"]          else 0,
        "min_score":       int(row["min_score"])         if row and row["min_score"]        else 0,
        "min_discount_pct": int(row["min_discount_pct"]) if row and row["min_discount_pct"] else 10,
    }

def prefs_set(user_id: int, username: str,
              threshold: float = None, min_cut: int = None,
              min_score: int = None, min_discount_pct: int = None):
    db = get_db()
    cursor = db.cursor()
    cursor.execute(
        """INSERT INTO itad_user_prefs (user_id, username, price_threshold, min_cut, min_score, min_discount_pct)
           VALUES (%s, %s, %s, %s, %s, %s)
           ON CONFLICT (user_id) DO UPDATE SET
               username          = EXCLUDED.username,
               price_threshold   = COALESCE(%s, itad_user_prefs.price_threshold),
               min_cut           = COALESCE(%s, itad_user_prefs.min_cut),
               min_score         = COALESCE(%s, itad_user_prefs.min_score),
               min_discount_pct  = COALESCE(%s, itad_user_prefs.min_discount_pct)""",
        (user_id, username,
         threshold or 5.00, min_cut or 0, min_score or 0, min_discount_pct or 10,
         threshold, min_cut, min_score, min_discount_pct)
    )
    db.commit()
    cursor.close()
    db.close()