import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('unpack_release', Path(__file__).resolve().parents[1] / 'deploy/unpack-release.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def bundle(extra=None):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w:gz') as archive:
        for name in ['package.json', 'src/main.mjs', 'src/server.mjs', 'public/index.html', 'scripts/lib/qq-api.mjs']:
            item = tarfile.TarInfo(name)
            item.size = 2
            item.mode = 0o777
            archive.addfile(item, io.BytesIO(b'{}'))
        if extra is not None:
            archive.addfile(extra, io.BytesIO(b'x' * extra.size))
    data.seek(0)
    return data


class ReleaseTests(unittest.TestCase):
    def test_valid_release_uses_safe_modes(self):
        with tempfile.TemporaryDirectory() as folder:
            module.unpack(bundle(), folder)
            self.assertEqual((Path(folder) / 'src/main.mjs').read_text(), '{}')
            self.assertEqual((Path(folder) / 'src/main.mjs').stat().st_mode & 0o777, 0o644)

    def test_rejects_private_paths_traversal_links_and_duplicates_before_writing(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/tmp/escape', tarfile.REGTYPE),
                           ('.env.local', tarfile.REGTYPE), ('.local/app/secrets.json', tarfile.REGTYPE),
                           ('src/main.mjs', tarfile.REGTYPE), ('src/link', tarfile.SYMTYPE),
                           ('src/link', tarfile.LNKTYPE), ('src/.secret', tarfile.REGTYPE)]:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as folder:
                extra = tarfile.TarInfo(name)
                extra.type = kind
                extra.linkname = '/etc/passwd'
                with self.assertRaises(ValueError):
                    module.unpack(bundle(extra), folder)
                self.assertEqual(list(Path(folder).iterdir()), [])

    def test_rejects_oversized_and_incomplete_releases(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                module.unpack(io.BytesIO(b'x' * (8 * 1024 * 1024 + 1)), folder)
            empty = io.BytesIO()
            with tarfile.open(fileobj=empty, mode='w:gz'):
                pass
            empty.seek(0)
            with self.assertRaises(ValueError):
                module.unpack(empty, folder)
