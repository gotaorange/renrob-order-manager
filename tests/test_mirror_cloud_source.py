import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'mirror_cloud_source.py'
SPEC = importlib.util.spec_from_file_location('mirror_cloud_source', SCRIPT)
mirror = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mirror)


class SourceMirrorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='renrob-source-test-')
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / 'source'
        self.source.mkdir()
        for name in mirror.ROOT_FILES | mirror.MIGRATION_FILES:
            self.add(name, 'public source fixture')

    def tearDown(self):
        self.temp.cleanup()

    def add(self, name, text):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def test_only_source_allowlist_is_copied(self):
        self.add('lib/api.ts', 'export const fixture = true;')
        for name in ['.env', '.dev.vars', '.npmrc', '.openai/hosting.json',
                     'node_modules/secret.js', 'dist/customer.js', 'data/secret.json',
                     '.wrangler/state/database.sqlite', '.sites-runtime/identity.json',
                     'tools/__pycache__/secret.py', 'tools/private/secret.py',
                     'public/orders.csv', 'public/private/data.js']:
            self.add(name, 'MUST_NOT_BE_COPIED')
        plan = mirror.source_plan(self.source)
        self.assertIn('lib/api.ts', plan)
        self.assertFalse(any(b'MUST_NOT_BE_COPIED' in body for body in plan.values()))
        self.assertEqual(json.loads(plan['.openai/hosting.json']), {'d1': 'DB', 'r2': 'BUCKET'})
        manifest = json.loads(plan['SOURCE_MANIFEST.json'])
        self.assertEqual(manifest['files']['lib/api.ts'], hashlib.sha256(plan['lib/api.ts']).hexdigest())

    def test_private_source_marker_stops_before_copy(self):
        self.add('lib/accident.ts', "const personal = '/Users/private-person/Desktop/orders';")
        with self.assertRaisesRegex(ValueError, 'Potential private material'):
            mirror.source_plan(self.source)

    def test_symlink_source_is_rejected(self):
        outside = self.base / 'private.txt'
        outside.write_text('DO_NOT_READ')
        path = self.source / 'lib' / 'api.ts'
        path.parent.mkdir()
        path.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'Refusing symlink'):
            mirror.source_plan(self.source)

    def test_existing_mirror_is_never_silently_replaced(self):
        destination = self.base / 'cloud'
        plan = mirror.source_plan(self.source)
        mirror.write_mirror(plan, destination)
        before = (destination / 'package.json').read_bytes()
        with self.assertRaisesRegex(ValueError, 'already exists'):
            mirror.write_mirror({'package.json': b'changed'}, destination)
        self.assertEqual((destination / 'package.json').read_bytes(), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
