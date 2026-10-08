"""Read-only legacy backup. TIMESTAMP WITHOUT TIME ZONE is interpreted as UTC.

The JSON contains personal data. Output must be under an ignored migration-private
directory; files are exclusive, atomically completed, and restricted to this user.
Never imports legacy config.py, which may log credentials at import time.
"""
import argparse
from datetime import datetime, timezone
from decimal import Decimal
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def utc_timestamp(value):
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def build_export(wishlist, user_prefs, state, exported_at=None):
    if (not isinstance(state, dict) or not isinstance(state.get('sent_deals'), list)
            or any(not isinstance(slug, str) or not slug or '\0' in slug
                   for slug in state['sent_deals'])):
        raise ValueError('Invalid legacy state')

    def normalize(row):
        result = {}
        for key, value in row.items():
            if key == 'user_id':
                if isinstance(value, bool) or not isinstance(value, int):
                    raise ValueError('Invalid legacy user ID')
                value = str(value)
            elif isinstance(value, Decimal):
                if not value.is_finite():
                    raise ValueError('Invalid legacy price')
                value = format(value, 'f')
            elif isinstance(value, datetime):
                value = utc_timestamp(value)
            result[key] = value
        return result

    return {'version': 1, 'exported_at': utc_timestamp(exported_at or datetime.now(timezone.utc)),
            'legacy_timestamp_timezone': 'UTC',
            'wishlist': [normalize(row) for row in wishlist],
            'user_prefs': [normalize(row) for row in user_prefs],
            'sent_deals': sorted(set(state['sent_deals']))}


def restrict_permissions(path):
    if os.name == 'nt':
        user = os.environ.get('USERNAME')
        domain = os.environ.get('USERDOMAIN')
        if not user:
            raise RuntimeError('Cannot secure private file')
        principal = f'{domain}\\{user}' if domain else user
        subprocess.run(['icacls.exe', str(path), '/inheritance:r', '/grant:r', f'{principal}:F'],
                       check=True, capture_output=True)
    else:
        os.chmod(path, 0o700 if path.is_dir() else 0o600)


def write_private_json(output, payload):
    output = Path(output).resolve()
    if 'migration-private' not in output.parent.parts:
        raise ValueError('Output must be in migration-private')
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    restrict_permissions(output.parent)
    # Reserve the destination exclusively before replacing it with a fully synced
    # temporary file, so a rerun cannot erase an earlier backup.
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    temporary = None
    try:
        restrict_permissions(output)
        fd, temporary = tempfile.mkstemp(prefix='.export-', suffix='.tmp', dir=output.parent)
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            restrict_permissions(Path(temporary))
            json.dump(payload, stream, ensure_ascii=False, allow_nan=False)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)
        temporary = None
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)


def read_legacy(database_url):
    # Lazy imports allow fixture tests without database dependencies or access.
    import psycopg2
    from psycopg2.extras import RealDictCursor

    connection = psycopg2.connect(database_url, sslmode='require', connect_timeout=15)
    try:
        connection.set_session(readonly=True, isolation_level='REPEATABLE READ', autocommit=False)
        with connection.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute("SET LOCAL TIME ZONE 'UTC'")
            cursor.execute('''SELECT user_id, username, game_slug, game_title, price_at_add,
                last_notified_price, last_notified_shop, last_notified_url,
                min_discount_pct, added_at FROM itad_wishlist ORDER BY user_id, game_slug''')
            wishlist = cursor.fetchall()
            cursor.execute('''SELECT user_id, username, price_threshold, min_cut,
                min_score, min_discount_pct FROM itad_user_prefs ORDER BY user_id''')
            prefs = cursor.fetchall()
        # No production writes or schema initialization; even success rolls back.
        return wishlist, prefs
    finally:
        try:
            connection.rollback()
        finally:
            connection.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Private, read-only legacy export')
    parser.add_argument('--env-file', type=Path, help='Explicit legacy dotenv file (optional)')
    parser.add_argument('--state', required=True, type=Path, help='Legacy ROOT state.json')
    parser.add_argument('--output', required=True, type=Path, help='New migration-private JSON file')
    args = parser.parse_args(argv)
    try:
        # Never discover a dotenv file implicitly in a worktree or import config.py.
        database_url = os.environ.get('DATABASE_URL')
        if args.env_file:
            from dotenv import dotenv_values
            database_url = database_url or dotenv_values(args.env_file).get('DATABASE_URL')
        if not database_url:
            raise ValueError('Missing database configuration')
        with args.state.open(encoding='utf-8') as stream:
            state = json.load(stream)
        # Validate state/output before opening PostgreSQL.
        build_export([], [], state)
        output = args.output.resolve()
        if 'migration-private' not in output.parent.parts or output.exists():
            raise ValueError('Invalid output')
        wishlist, prefs = read_legacy(database_url)
        payload = build_export(wishlist, prefs, state)
        write_private_json(output, payload)
        print(f"Export complete: wishlist={len(wishlist)} preferences={len(prefs)} legacy_slugs={len(payload['sent_deals'])}")
        return 0
    except Exception:
        # Driver errors can contain credentials/DSNs and records. Never print them.
        print('Export failed; check configuration, legacy connectivity and private output permissions.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
