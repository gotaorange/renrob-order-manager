#!/usr/bin/env python3
"""Preview or install the Re:Nrob Lab per-user Mac cloud sync LaunchAgent.

Default: print the plist without changing anything. --install explicitly writes
and loads it; RunAtLoad then starts one sync. Tokens remain in the existing private
cloud-sync.json and are never included in the plist or installer output.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import plistlib
import stat
import subprocess
import sys
import tempfile


REPO = Path(__file__).resolve().parents[1]
LABEL = 'com.renroblab.orders.cloud-sync'
SCRIPT = REPO / 'scripts' / 'sync_cloud.py'
CONFIG = REPO / 'data' / 'cloud-sync.json'
LOG_DIR = REPO / 'data' / 'cloud-sync'
PLIST = Path.home() / 'Library' / 'LaunchAgents' / (LABEL + '.plist')


def python_executable() -> Path:
    bundled = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'
    for candidate in (bundled, Path(sys.executable)):
        executable = candidate.expanduser().resolve()
        if executable.is_file() and os.access(executable, os.X_OK):
            return executable
    raise RuntimeError('找不到可執行的 Python，請使用 Codex 內建 Python 執行本工具')


def build_plist(executable: Path, config: Path) -> dict:
    return {
        'Label': LABEL,
        'ProgramArguments': [str(executable), str(SCRIPT), '--config', str(config), '--once'],
        'WorkingDirectory': str(REPO),
        'RunAtLoad': True,
        'StartInterval': 60,
        'ProcessType': 'Background',
        'LowPriorityIO': True,
        'Nice': 10,
        'Umask': 0o077,
        'StandardOutPath': str(LOG_DIR / 'launchagent.stdout.log'),
        'StandardErrorPath': str(LOG_DIR / 'launchagent.stderr.log'),
    }


def regular_file(path: Path) -> os.stat_result | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError(f'路徑已存在且不是一般檔案，已保留：{path}')
    return info


def ensure_directory(path: Path, private: bool = False) -> None:
    # Do not follow symlinked destination directories during installation.
    for part in [*reversed(path.parents), path]:
        try:
            info = part.lstat()
        except FileNotFoundError:
            part.mkdir(mode=0o700 if private else 0o755)
            info = part.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise RuntimeError(f'路徑不是一般資料夾，已保留：{part}')
    if private:
        path.chmod(0o700)


def validate_existing_agent() -> None:
    if regular_file(PLIST) is None:
        return
    try:
        existing = plistlib.loads(PLIST.read_bytes())
    except (ValueError, plistlib.InvalidFileException) as exc:
        raise RuntimeError('同名 LaunchAgent 格式不明，為保留既有設定已停止安裝') from exc
    arguments = existing.get('ProgramArguments', [])
    if (existing.get('Label') != LABEL or not isinstance(arguments, list) or
            len(arguments) < 2 or arguments[1] != str(SCRIPT)):
        raise RuntimeError('同名 LaunchAgent 屬於其他程式或專案路徑，已保留且停止安裝')


def atomic_write(path: Path, payload: bytes) -> None:
    regular_file(path)
    descriptor, temporary = tempfile.mkstemp(prefix='.renrob-launchagent-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def install(payload: bytes, config: Path) -> None:
    if sys.platform != 'darwin':
        raise RuntimeError('自動啟動安裝只支援 macOS')
    if os.geteuid() == 0:
        raise RuntimeError('請以目前登入的 Mac 使用者執行，不要使用 sudo')
    config_info = regular_file(config)
    if config_info is None:
        raise RuntimeError('找不到私有同步設定，請先建立 data/cloud-sync.json')
    if config_info.st_mode & 0o077:
        raise RuntimeError('私有同步設定檔權限需為 600，僅目前使用者可讀寫')
    if not SCRIPT.is_file():
        raise RuntimeError('找不到 scripts/sync_cloud.py')
    validate_existing_agent()
    ensure_directory(PLIST.parent)
    ensure_directory(LOG_DIR, private=True)
    for name in ('launchagent.stdout.log', 'launchagent.stderr.log'):
        target = LOG_DIR / name
        regular_file(target)
        descriptor = os.open(target, os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        os.fchmod(descriptor, 0o600)
        os.close(descriptor)
    # Validate before replacing the current managed plist or changing launchd.
    if plistlib.loads(payload).get('Label') != LABEL:
        raise RuntimeError('LaunchAgent 設定驗證失敗')
    atomic_write(PLIST, payload)
    domain = f'gui/{os.getuid()}'
    service = f'{domain}/{LABEL}'
    loaded = subprocess.run(['/bin/launchctl', 'print', service], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if loaded.returncode == 0:
        subprocess.run(['/bin/launchctl', 'bootout', service], check=True)
    subprocess.run(['/bin/launchctl', 'enable', service], check=True)
    subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(PLIST)], check=True)
    subprocess.run(['/bin/launchctl', 'print', service], check=True, stdout=subprocess.DEVNULL)
    print(f'已安裝：{PLIST}')
    print('每次登入 Mac 後自動啟動，每 60 秒同步一次；雲端 token 不在 plist 中。')
    print(f'同步執行結果請查看：{LOG_DIR}')


def main() -> int:
    parser = argparse.ArgumentParser(description='預覽或安裝 Re:Nrob Lab 的 Mac 雲端同步自動啟動')
    parser.add_argument('--install', action='store_true', help='安裝並啟用 LaunchAgent；會立即開始一次同步')
    parser.add_argument('--config', type=Path, default=CONFIG, help='既有私有同步設定檔（預設 data/cloud-sync.json）')
    args = parser.parse_args()
    try:
        config = args.config.expanduser().absolute()
        payload = plistlib.dumps(build_plist(python_executable(), config), fmt=plistlib.FMT_XML, sort_keys=False)
        if args.install:
            install(payload, config)
        else:
            sys.stdout.buffer.write(payload)
        return 0
    except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        print(f'自動啟動未完成：{exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
