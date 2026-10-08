#!/usr/bin/env python3
"""Safely copy cloud orders to a Mac. Python standard library only.

Configuration and all sync records stay in the repository's ignored data/ tree.
No file, deletion, or edit is ever uploaded to the cloud.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import ssl
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


REPO = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = REPO / "data" / "cloud-sync.json"
DEFAULT_STATE = REPO / "data" / "cloud-sync"
SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
MAX_MANIFEST_BYTES = 32 * 1024 * 1024
CHUNK_SIZE = 1024 * 1024


class SyncError(Exception):
    """An error safe to show without exposing the bearer token."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def safe_component(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SyncError(f"{label}不可空白")
    if value in {".", ".."} or value != value.strip():
        raise SyncError(f"{label}包含不安全的路徑")
    if any(c in value for c in '/\\:') or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise SyncError(f"{label}包含不安全的路徑字元")
    if value.endswith(".") or len(value.encode("utf-8")) > 255:
        raise SyncError(f"{label}過長或結尾不合法")
    return value


def identifier(value: object, label: str) -> str:
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        raise SyncError(f"{label}不合法")
    return safe_component(str(value), label)


def ensure_directory(path: Path, private: bool = False) -> None:
    """Reject symlinks, including intermediate directories."""
    path = path.absolute()
    for item in [*reversed(path.parents), path]:
        try:
            info = item.lstat()
        except FileNotFoundError:
            item.mkdir(mode=0o700 if private else 0o755)
            info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise SyncError("同步路徑包含符號連結或不是資料夾")
    if private:
        os.chmod(path, 0o700)


def regular_file(path: Path) -> os.stat_result | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise SyncError("目的地已存在符號連結或非一般檔案；已保留")
    return info


def checksum(path: Path) -> str | None:
    if regular_file(path) is None:
        return None
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    digest = hashlib.sha256()
    with os.fdopen(fd, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise SyncError("目的地不是一般檔案")
        for chunk in iter(lambda: handle.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: object) -> None:
    ensure_directory(path.parent, private=True)
    regular_file(path)
    fd, temp_name = tempfile.mkstemp(prefix=".cloud-sync-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp_name)


def read_private_json(path: Path) -> dict:
    info = regular_file(path)
    if info is None:
        raise SyncError("找不到私有同步設定檔；請先完成設定")
    if info.st_mode & 0o077:
        raise SyncError("私有同步設定或紀錄的權限必須為 600（僅自己可讀寫）")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (ValueError, UnicodeError) as exc:
        raise SyncError("私有同步設定或紀錄不是有效 JSON") from exc
    if not isinstance(value, dict):
        raise SyncError("私有同步設定或紀錄必須為 JSON 物件")
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A redirect must never forward the sync token to another origin.
        return None


class RemoteClient:
    def __init__(self, cloud_url: str, token: str, timeout: int = 60):
        parsed = urllib.parse.urlsplit(cloud_url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in {"", "/"}):
            raise SyncError("cloud_url 必須為 HTTPS 網站根網址，不可含帳密、路徑或查詢")
        if not isinstance(token, str) or not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise SyncError("缺少有效的 MAC_SYNC_TOKEN 或私有 token 設定")
        self.origin = cloud_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        # macOS's system Python can miss its default CA bundle. Use the system
        # bundle when available, keeping certificate and hostname checks enabled.
        https_handler = urllib.request.HTTPSHandler()
        if sys.platform == "darwin" and Path("/etc/ssl/cert.pem").is_file():
            context = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
            https_handler = urllib.request.HTTPSHandler(context=context)
        self.opener = urllib.request.build_opener(NoRedirect(), https_handler)

    def get(self, path: str):
        request = urllib.request.Request(
            self.origin + path,
            headers={"Authorization": "Bearer " + self.token,
                     "Accept": "application/json, application/octet-stream",
                     "User-Agent": "RenrobMacSync/1"},
        )
        try:
            return self.opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            raise SyncError(f"雲端回應 HTTP {exc.code}；請確認同步權限與網址") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise SyncError("無法連線至雲端；未變更既有檔案") from None

    def manifest(self) -> dict:
        try:
            with self.get("/api/sync/manifest") as response:
                raw = response.read(MAX_MANIFEST_BYTES + 1)
        except (http.client.HTTPException, TimeoutError, OSError):
            raise SyncError("訂單清單下載中斷；下次同步會重試") from None
        if len(raw) > MAX_MANIFEST_BYTES:
            raise SyncError("雲端訂單清單超過安全大小限制")
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError):
            raise SyncError("雲端訂單清單不是有效 JSON") from None
        if not isinstance(value, dict) or not isinstance(value.get("orders"), list):
            raise SyncError("雲端訂單清單格式不符")
        return value

    def download(self, order_id: str, stored: str, output) -> None:
        path = "/api/orders/{}/file/{}".format(
            urllib.parse.quote(order_id, safe=""), urllib.parse.quote(stored, safe="")
        )
        try:
            with self.get(path) as response:
                for chunk in iter(lambda: response.read(CHUNK_SIZE), b""):
                    output.write(chunk)
        except (http.client.HTTPException, TimeoutError, OSError):
            raise SyncError("附件下載中斷；下次同步會重試") from None


class VerifiedOutput:
    def __init__(self, handle, expected_size: int):
        self.handle = handle
        self.expected_size = expected_size
        self.size = 0
        self.digest = hashlib.sha256()

    def write(self, chunk: bytes) -> None:
        self.size += len(chunk)
        if self.size > self.expected_size:
            raise SyncError("下載內容超過清單大小；未保存不完整附件")
        self.digest.update(chunk)
        self.handle.write(chunk)


class SyncRunner:
    def __init__(self, client, orders_root: Path, state_dir: Path = DEFAULT_STATE):
        if not orders_root.is_absolute():
            raise SyncError("orders_root 必須是完整絕對路徑")
        self.client = client
        self.orders_root = orders_root
        self.state_dir = state_dir.absolute()
        ensure_directory(self.state_dir, private=True)
        ensure_directory(self.orders_root)
        self.state_path = self.state_dir / "state.json"
        self.log_path = self.state_dir / "sync.log"
        self.state = {"schema": 1, "files": {}}
        if regular_file(self.state_path):
            self.state = read_private_json(self.state_path)
            if self.state.get("schema") != 1 or not isinstance(self.state.get("files"), dict):
                raise SyncError("同步紀錄版本或內容不符；為保護檔案已停止")
        previous_root = self.state.get("ordersRoot")
        if previous_root and previous_root != str(self.orders_root):
            raise SyncError("同步目的地與上次不同；請使用獨立同步紀錄，避免誤覆寫")
        self.state["ordersRoot"] = str(self.orders_root)
        self.counts = {}

    def log(self, message: str) -> None:
        regular_file(self.log_path)
        fd = os.open(self.log_path, os.O_CREAT | os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(f"{utc_now()} {message}\n")

    def path_for_record(self, record: dict) -> Path:
        parts = record.get("path", "").split("/")
        if len(parts) != 2:
            raise SyncError("同步紀錄包含不安全的檔案路徑")
        for part in parts:
            safe_component(part, "同步紀錄路徑")
        if not SHA256.fullmatch(str(record.get("sha256", ""))):
            raise SyncError("同步紀錄缺少有效校驗碼")
        ensure_directory(self.orders_root / parts[0])
        return self.orders_root / parts[0] / parts[1]

    def new_version_path(self, folder: Path, name: str, sha: str) -> Path:
        timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        original = Path(name)
        suffix = original.suffix
        stem = name[:-len(suffix)] if suffix else name
        # Reserve room for the version marker, counter, and UTF-8 extension.
        if len(suffix.encode("utf-8")) > 50:
            suffix = ""
        while len(stem.encode("utf-8")) > 140:
            stem = stem[:-1]
        for number in range(1, 10000):
            counter = "" if number == 1 else f"-{number}"
            candidate = folder / f"{stem} [雲端版本 {timestamp}-{sha[:10]}{counter}]{suffix}"
            if not candidate.exists() and not candidate.is_symlink():
                return candidate
        raise SyncError("無法建立唯一的雲端版本檔名")

    def remember(self, key: str, target: Path, sha: str, size: int, stored: str) -> None:
        self.state["files"][key] = {
            "path": str(target.relative_to(self.orders_root)), "sha256": sha,
            "size": size, "stored": stored, "syncedAt": utc_now(),
        }
        self.state["updatedAt"] = utc_now()
        # Save after every file, so an interrupted later download loses no history.
        atomic_json(self.state_path, self.state)

    def sync_file(self, order_id: str, folder: Path, item: dict) -> None:
        if not isinstance(item, dict):
            raise SyncError("附件格式不符")
        stored = safe_component(item.get("stored"), "雲端附件位置")
        name = safe_component(item.get("name"), "附件名稱")
        file_id = identifier(item.get("id", stored), "附件識別碼")
        sha = str(item.get("sha256", "")).lower()
        if not SHA256.fullmatch(sha):
            raise SyncError("附件缺少 SHA256；已跳過，等待雲端完成校驗資料")
        size = item.get("size")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise SyncError("附件缺少有效大小；已跳過")
        key = json.dumps([order_id, file_id], ensure_ascii=False, separators=(",", ":"))
        record = self.state["files"].get(key)
        target = folder / name
        conflict = False
        expected_local = None

        if record:
            target = self.path_for_record(record)
            if target.parent != folder:
                raise SyncError("訂單資料夾名稱與上次同步不同；已保留舊資料夾")
            current = checksum(target)
            if current is None and sha == record["sha256"]:
                self.counts["preserved"] += 1
                self.log(f"保留本機刪除：{target.relative_to(self.orders_root)}")
                return
            if current == sha:
                if record["sha256"] != sha:
                    self.remember(key, target, sha, size, stored)
                self.counts["unchanged"] += 1
                return
            if current != record["sha256"]:
                if sha == record["sha256"]:
                    self.counts["preserved"] += 1
                    self.log(f"保留本機修改：{target.relative_to(self.orders_root)}")
                    return
                conflict = True
            else:
                expected_local = current
        else:
            current = checksum(target)
            if current == sha:
                self.remember(key, target, sha, size, stored)
                self.counts["unchanged"] += 1
                return
            conflict = current is not None

        if conflict:
            target = self.new_version_path(folder, name, sha)
            expected_local = None

        fd, temp_name = tempfile.mkstemp(prefix=".cloud-download-", dir=folder)
        temp = Path(temp_name)
        try:
            with os.fdopen(fd, "wb") as handle:
                os.fchmod(handle.fileno(), 0o600)
                output = VerifiedOutput(handle, size)
                self.client.download(order_id, stored, output)
                if output.size != size or output.digest.hexdigest() != sha:
                    raise SyncError("附件大小或 SHA256 不符；未保存不完整附件")
                handle.flush()
                os.fsync(handle.fileno())

            ensure_directory(folder)
            # Recheck after network I/O to preserve changes made during download.
            if checksum(target) != expected_local:
                target = self.new_version_path(folder, name, sha)
                expected_local = None
                conflict = True
            if expected_local is None:
                # Atomic no-clobber publication: a concurrent local file is never
                # replaced. Hard-link the complete tempfile, then remove temp.
                while True:
                    try:
                        os.link(temp, target, follow_symlinks=False)
                        break
                    except FileExistsError:
                        target = self.new_version_path(folder, name, sha)
                        conflict = True
                temp.unlink()
            else:
                # Only a previously synced, still-unmodified file is replaced.
                os.replace(temp, target)
            self.remember(key, target, sha, size, stored)
            self.counts["downloaded"] += 1
            if conflict:
                self.counts["conflicts"] += 1
                self.log(f"衝突，已保留原檔並另存：{target.relative_to(self.orders_root)}")
            else:
                self.log(f"已同步：{target.relative_to(self.orders_root)}")
        finally:
            with contextlib.suppress(FileNotFoundError):
                temp.unlink()

    def run_once(self) -> dict:
        self.counts = {"downloaded": 0, "unchanged": 0, "preserved": 0, "conflicts": 0, "errors": 0}
        manifest = self.client.manifest()
        if not isinstance(manifest, dict) or not isinstance(manifest.get("orders"), list):
            raise SyncError("雲端訂單清單格式不符")
        if manifest.get("schema", 1) != 1:
            raise SyncError("雲端訂單清單版本不支援")
        # Snapshot contains internal order and finance fields; keep it private.
        atomic_json(self.state_dir / "orders.snapshot.json", manifest)
        order_ids = set()
        folders = set()
        for order in manifest["orders"]:
            label = "未識別訂單"
            try:
                if not isinstance(order, dict):
                    raise SyncError("訂單格式不符")
                order_id = identifier(order.get("id"), "訂單識別碼")
                number = safe_component(order.get("orderNo"), "訂單號")
                code = safe_component(order.get("code"), "代號")
                folder_name = safe_component(f"{number} {code}", "訂單資料夾")
                label = folder_name
                if order_id in order_ids or folder_name in folders:
                    raise SyncError("清單包含重複訂單或資料夾；已跳過")
                order_ids.add(order_id)
                folders.add(folder_name)
                folder = self.orders_root / folder_name
                ensure_directory(folder)
                files = order.get("files", [])
                if not isinstance(files, list):
                    raise SyncError("訂單附件清單格式不符")
                file_ids = set()
                for item in files:
                    try:
                        if not isinstance(item, dict):
                            raise SyncError("附件格式不符")
                        file_id = identifier(item.get("id", item.get("stored")), "附件識別碼")
                        if file_id in file_ids:
                            raise SyncError("清單包含重複附件識別碼；已跳過")
                        file_ids.add(file_id)
                        self.sync_file(order_id, folder, item)
                    except (SyncError, OSError) as exc:
                        self.counts["errors"] += 1
                        self.log(f"略過附件（{label}）：{type(exc).__name__}: {exc}")
            except (SyncError, OSError) as exc:
                self.counts["errors"] += 1
                self.log(f"略過訂單（{label}）：{type(exc).__name__}: {exc}")
        self.state["lastSyncAt"] = utc_now()
        self.state["lastResult"] = self.counts
        atomic_json(self.state_path, self.state)
        self.log("本次完成 " + json.dumps(self.counts, ensure_ascii=False))
        return self.counts.copy()


@contextlib.contextmanager
def sync_lock(state_dir: Path):
    ensure_directory(state_dir, private=True)
    path = state_dir / "sync.lock"
    regular_file(path)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SyncError("已有同步程式執行中；不會重複啟動") from None
        yield
    finally:
        os.close(fd)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="將雲端訂單安全同步到 Mac（單向、不刪除原檔）")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG, help="私有設定檔")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="同步一次後結束（預設）")
    mode.add_argument("--watch", action="store_true", help="每 60 秒同步一次；Ctrl+C 結束")
    args = parser.parse_args(argv)
    try:
        config = read_private_json(args.config)
        token = os.environ.get("MAC_SYNC_TOKEN") or config.get("token") or config.get("MAC_SYNC_TOKEN")
        cloud_url = config.get("cloud_url")
        root = config.get("orders_root")
        if not isinstance(cloud_url, str) or not isinstance(root, str):
            raise SyncError("私有設定需包含 cloud_url、orders_root 與 token")
        client = RemoteClient(cloud_url, token)
        with sync_lock(DEFAULT_STATE):
            runner = SyncRunner(client, Path(root).expanduser())
            while True:
                try:
                    result = runner.run_once()
                    print(f"{utc_now()} 同步完成：下載 {result['downloaded']}，未變更 {result['unchanged']}，"
                          f"保留本機變更 {result['preserved']}，衝突另存 {result['conflicts']}，略過錯誤 {result['errors']}", flush=True)
                    status = 2 if result["errors"] else 0
                except (SyncError, OSError) as exc:
                    runner.log(f"同步未完成：{type(exc).__name__}: {exc}")
                    print(f"同步未完成：{exc}", file=sys.stderr, flush=True)
                    status = 2
                if not args.watch:
                    return status
                time.sleep(60)
    except KeyboardInterrupt:
        print("\n同步已停止；已保存的檔案與紀錄保留。", flush=True)
        return 0
    except (SyncError, OSError) as exc:
        print(f"同步未啟動：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
