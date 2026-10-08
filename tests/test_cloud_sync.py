"""Cloud sync safety checks; every write is confined to a temporary directory."""

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "sync_cloud.py"
SPEC = importlib.util.spec_from_file_location("sync_cloud", MODULE_PATH)
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


class FakeCloud:
    def __init__(self):
        self.content = b"original cloud content"
        self.before_download = None
        self.download_count = 0
        self.order = {"id": "order-1", "orderNo": "TEST-001", "code": "SAMPLE",
                      "customerPrice": 123, "files": []}
        self.set_content(self.content)

    def set_content(self, content):
        self.content = content
        self.order["files"] = [{"id": "file-1", "name": "sample.pdf", "stored": "file-1.pdf",
                                "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}]

    def manifest(self):
        return {"schema": 1, "orders": [copy.deepcopy(self.order)]}

    def download(self, order_id, stored, output):
        self.download_count += 1
        if self.before_download:
            self.before_download()
        output.write(self.content)


class SyncSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="renrob-sync-test-")
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "orders"
        self.state = self.base / "private-state"
        self.cloud = FakeCloud()
        self.runner = sync.SyncRunner(self.cloud, self.root, self.state)
        self.target = self.root / "TEST-001 SAMPLE" / "sample.pdf"

    def tearDown(self):
        self.temp.cleanup()

    def versions(self):
        return list(self.target.parent.glob("*雲端版本*"))

    def test_first_sync_unchanged_then_safe_update(self):
        self.assertEqual(self.runner.run_once()["downloaded"], 1)
        self.assertEqual(self.target.read_bytes(), self.cloud.content)
        self.assertEqual(self.runner.run_once()["unchanged"], 1)
        self.assertEqual(self.cloud.download_count, 1)
        self.cloud.set_content(b"new remote version")
        self.assertEqual(self.runner.run_once()["downloaded"], 1)
        self.assertEqual(self.target.read_bytes(), b"new remote version")
        self.assertEqual(self.versions(), [])

    def test_preexisting_manual_file_preserved(self):
        self.target.parent.mkdir()
        self.target.write_bytes(b"manual document")
        result = self.runner.run_once()
        self.assertEqual(result["conflicts"], 1)
        self.assertEqual(self.target.read_bytes(), b"manual document")
        self.assertEqual(len(self.versions()), 1)
        self.assertEqual(self.versions()[0].read_bytes(), self.cloud.content)
        self.assertEqual(self.runner.run_once()["unchanged"], 1)

    def test_manual_edit_and_remote_update_preserved(self):
        self.runner.run_once()
        self.target.write_bytes(b"manual edit")
        self.assertEqual(self.runner.run_once()["preserved"], 1)
        self.cloud.set_content(b"remote update")
        self.assertEqual(self.runner.run_once()["conflicts"], 1)
        self.assertEqual(self.target.read_bytes(), b"manual edit")
        self.assertEqual(self.versions()[0].read_bytes(), b"remote update")

    def test_manual_deletion_never_recreated_under_original_name(self):
        self.runner.run_once()
        self.target.unlink()
        self.assertEqual(self.runner.run_once()["preserved"], 1)
        self.assertFalse(self.target.exists())
        # Reload the persisted metadata: deletion protection survives restarts.
        self.runner = sync.SyncRunner(self.cloud, self.root, self.state)
        self.cloud.set_content(b"remote update after local deletion")
        self.assertEqual(self.runner.run_once()["conflicts"], 1)
        self.assertFalse(self.target.exists())
        self.assertEqual(len(self.versions()), 1)

    def test_edit_during_download_preserved(self):
        self.runner.run_once()
        self.cloud.set_content(b"remote update")
        self.cloud.before_download = lambda: self.target.write_bytes(b"edit during download")
        self.assertEqual(self.runner.run_once()["conflicts"], 1)
        self.assertEqual(self.target.read_bytes(), b"edit during download")

    def test_file_created_during_download_preserved(self):
        self.cloud.before_download = lambda: self.target.write_bytes(b"created while waiting")
        self.assertEqual(self.runner.run_once()["conflicts"], 1)
        self.assertEqual(self.target.read_bytes(), b"created while waiting")

    def test_cloud_deletion_keeps_mac_copy(self):
        self.runner.run_once()
        self.cloud.order["files"] = []
        self.runner.run_once()
        self.assertTrue(self.target.exists())
        self.cloud.manifest = lambda: {"schema": 1, "orders": []}
        self.runner.run_once()
        self.assertTrue(self.target.exists())

    def test_corrupt_download_never_replaces_existing_file(self):
        self.runner.run_once()
        original = self.target.read_bytes()
        self.cloud.set_content(b"a valid remote update")
        self.cloud.content = b"corrupt bytes"
        self.assertEqual(self.runner.run_once()["errors"], 1)
        self.assertEqual(self.target.read_bytes(), original)
        self.assertEqual(list(self.target.parent.glob(".cloud-download-*")), [])

    def test_missing_checksum_is_not_marked_synced(self):
        del self.cloud.order["files"][0]["sha256"]
        self.assertEqual(self.runner.run_once()["errors"], 1)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.cloud.download_count, 0)
        self.assertEqual(self.runner.state["files"], {})

    def test_file_path_traversal_rejected(self):
        for unsafe in ["../escape.pdf", "/tmp/escape.pdf", "..", "a\\b.pdf", "x:y.pdf", "bad\x00.pdf"]:
            with self.subTest(unsafe=unsafe):
                self.cloud.order["files"][0]["name"] = unsafe
                self.assertEqual(self.runner.run_once()["errors"], 1)
        self.assertEqual(self.cloud.download_count, 0)
        self.assertFalse((self.root / "escape.pdf").exists())

    def test_folder_path_traversal_rejected(self):
        self.cloud.order["orderNo"] = "../escape"
        self.assertEqual(self.runner.run_once()["errors"], 1)
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(self.cloud.download_count, 0)

    def test_symlink_folder_cannot_escape(self):
        outside = self.base / "outside"
        outside.mkdir()
        self.target.parent.symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.runner.run_once()["errors"], 1)
        self.assertEqual(list(outside.iterdir()), [])

    def test_symlink_file_preserved_and_not_followed(self):
        outside = self.base / "outside.pdf"
        outside.write_bytes(b"external content")
        self.target.parent.mkdir()
        self.target.symlink_to(outside)
        self.assertEqual(self.runner.run_once()["errors"], 1)
        self.assertEqual(outside.read_bytes(), b"external content")
        self.assertTrue(self.target.is_symlink())

    def test_tampered_metadata_path_cannot_escape(self):
        self.runner.run_once()
        record = next(iter(self.runner.state["files"].values()))
        record["path"] = "../outside.pdf"
        self.cloud.set_content(b"remote update")
        self.assertEqual(self.runner.run_once()["errors"], 1)
        self.assertFalse((self.base / "outside.pdf").exists())

    def test_snapshot_and_metadata_are_private(self):
        self.runner.run_once()
        for name in ["orders.snapshot.json", "state.json", "sync.log"]:
            self.assertEqual(stat.S_IMODE((self.state / name).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)
        snapshot = json.loads((self.state / "orders.snapshot.json").read_text())
        self.assertEqual(snapshot["orders"][0]["customerPrice"], 123)
        self.assertNotIn("token", (self.state / "state.json").read_text())

    def test_changed_destination_requires_separate_state(self):
        self.runner.run_once()
        with self.assertRaises(sync.SyncError):
            sync.SyncRunner(self.cloud, self.base / "another-orders", self.state)

    def test_duplicate_watch_lock_rejected(self):
        with sync.sync_lock(self.state):
            with self.assertRaises(sync.SyncError):
                with sync.sync_lock(self.state):
                    self.fail("duplicate watcher started")

    def test_tls_and_origin_validation(self):
        for origin in ["http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com/?token=x"]:
            with self.subTest(origin=origin), self.assertRaises(sync.SyncError):
                sync.RemoteClient(origin, "test-token")
        client = sync.RemoteClient("https://example.com", "test-token")
        self.assertEqual(client.origin, "https://example.com")
        redirect = sync.NoRedirect()
        self.assertIsNone(redirect.redirect_request(None, None, 302, "redirect", {}, "https://elsewhere.example/"))

    def test_once_command_runs_with_private_config(self):
        config = self.base / "config.json"
        sync.atomic_json(config, {"cloud_url": "https://example.com", "orders_root": str(self.root),
                                  "token": "temporary-test-token"})
        # Exercise the real argument parsing / lock / one-shot loop without
        # contacting any service or touching the real repository's data folder.
        class TemporaryRunner(sync.SyncRunner):
            def __init__(inner_self, client, root):
                super().__init__(client, root, self.state)

        with mock.patch.object(sync, "RemoteClient", return_value=self.cloud), \
                mock.patch.object(sync, "SyncRunner", TemporaryRunner), \
                mock.patch.object(sync, "DEFAULT_STATE", self.state):
            self.assertEqual(sync.main(["--once", "--config", str(config)]), 0)
        self.assertTrue(self.target.exists())

    def test_mac_system_ca_bundle_keeps_tls_verification(self):
        context = sync.ssl.create_default_context()
        with mock.patch.object(sync.sys, "platform", "darwin"), \
                mock.patch.object(sync.Path, "is_file", return_value=True), \
                mock.patch.object(sync.ssl, "create_default_context", return_value=context) as create_context, \
                mock.patch.object(sync.urllib.request, "HTTPSHandler") as handler, \
                mock.patch.object(sync.urllib.request, "build_opener"):
            sync.RemoteClient("https://example.com", "test-token")
            create_context.assert_called_once_with(cafile="/etc/ssl/cert.pem")
            handler.assert_called_with(context=context)
            self.assertEqual(context.verify_mode, sync.ssl.CERT_REQUIRED)
            self.assertTrue(context.check_hostname)

    def test_other_platform_or_missing_bundle_uses_default_https(self):
        for platform, exists in [("linux", True), ("darwin", False)]:
            with self.subTest(platform=platform, exists=exists), \
                    mock.patch.object(sync.sys, "platform", platform), \
                    mock.patch.object(sync.Path, "is_file", return_value=exists), \
                    mock.patch.object(sync.ssl, "create_default_context") as create_context, \
                    mock.patch.object(sync.urllib.request, "HTTPSHandler") as handler, \
                    mock.patch.object(sync.urllib.request, "build_opener"):
                sync.RemoteClient("https://example.com", "test-token")
                create_context.assert_not_called()
                handler.assert_called_once_with()


if __name__ == "__main__":
    unittest.main(verbosity=2)
