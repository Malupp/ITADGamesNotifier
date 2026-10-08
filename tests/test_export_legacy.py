import importlib.util
import json
from pathlib import Path
from datetime import datetime, timezone, timedelta
from decimal import Decimal
import tempfile
import unittest
from unittest.mock import patch
from io import StringIO
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'export_legacy.py'


class ExportTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('export_legacy', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_payload_preserves_private_decimal_null_and_utc_timestamps(self):
        row = {'user_id': 9223372036854775807, 'price_at_add': Decimal('5.10'),
               'last_notified_price': None, 'added_at': datetime(2024, 1, 2, 3, 4, 5)}
        payload = self.module.build_export([row], [], {'sent_deals': ['old', 'old']},
                                          datetime(2026, 10, 8, 12, tzinfo=timezone(timedelta(hours=2))))
        self.assertEqual(payload['version'], 1)
        self.assertEqual(payload['wishlist'][0]['user_id'], '9223372036854775807')
        self.assertEqual(payload['wishlist'][0]['price_at_add'], '5.10')
        self.assertIsNone(payload['wishlist'][0]['last_notified_price'])
        self.assertEqual(payload['wishlist'][0]['added_at'], '2024-01-02T03:04:05Z')
        self.assertEqual(payload['exported_at'], '2026-10-08T10:00:00Z')
        self.assertEqual(payload['legacy_timestamp_timezone'], 'UTC')
        self.assertEqual(payload['sent_deals'], ['old'])

    def test_atomic_export_refuses_overwriting_existing_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'migration-private' / 'export.json'
            self.module.write_private_json(output, {'version': 1})
            self.assertEqual(json.loads(output.read_text()), {'version': 1})
            with self.assertRaises(FileExistsError):
                self.module.write_private_json(output, {'version': 2})
            self.assertEqual(json.loads(output.read_text()), {'version': 1})

    def test_export_rejects_bad_state_and_nonfinite_decimal(self):
        for state in ({}, {'sent_deals': 'secret'}, {'sent_deals': [12]}):
            with self.assertRaises(ValueError):
                self.module.build_export([], [], state)
        with self.assertRaises(ValueError):
            self.module.build_export([{'price_at_add': Decimal('NaN')}], [], {'sent_deals': []})

    def test_permission_failure_cleans_up_reserved_and_temporary_files(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'migration-private' / 'export.json'
            with patch.object(self.module, 'restrict_permissions', side_effect=[None, None, RuntimeError('fixture permission failure')]):
                with self.assertRaises(RuntimeError):
                    self.module.write_private_json(output, {'version': 1})
            self.assertEqual(list(output.parent.iterdir()), [])

    def test_database_snapshot_is_readonly_repeatable_read_and_always_rolled_back(self):
        # PostgreSQL is external and unavailable in fixture tests; emulate only its
        # driver boundary to verify transaction setup and read-only SQL.
        events = []

        class Cursor:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def execute(self, sql): events.append(('sql', sql))
            def fetchall(self): return []

        class Connection:
            def set_session(self, **kwargs): events.append(('session', kwargs))
            def cursor(self, **kwargs): return Cursor()
            def rollback(self): events.append(('rollback',))
            def close(self): events.append(('close',))

        driver = SimpleNamespace(connect=lambda *args, **kwargs: Connection())
        extras = SimpleNamespace(RealDictCursor=object)
        with patch.dict('sys.modules', {'psycopg2': driver, 'psycopg2.extras': extras}):
            self.assertEqual(self.module.read_legacy('fixture-dsn'), ([], []))
        self.assertEqual(events[0], ('session', {'readonly': True, 'isolation_level': 'REPEATABLE READ', 'autocommit': False}))
        self.assertTrue(all(event[1].lstrip().startswith(('SELECT', 'SET LOCAL')) for event in events if event[0] == 'sql'))
        self.assertEqual(events[-2:], [('rollback',), ('close',)])

    def test_driver_exception_cannot_print_credentials_or_private_records(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state.json'
            state.write_text('{"sent_deals": []}', encoding='utf-8')
            output = Path(directory) / 'migration-private' / 'export.json'
            stderr = StringIO()
            with patch.dict('os.environ', {'DATABASE_URL': 'fixture-private-dsn'}), \
                    patch.object(self.module, 'read_legacy', side_effect=RuntimeError('fixture-private-dsn private-record')), \
                    patch('sys.stderr', stderr):
                code = self.module.main(['--state', str(state), '--output', str(output)])
            self.assertEqual(code, 1)
            self.assertNotIn('fixture-private-dsn', stderr.getvalue())
            self.assertNotIn('private-record', stderr.getvalue())
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
