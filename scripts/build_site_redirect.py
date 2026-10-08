#!/usr/bin/env python3
"""Build the GitHub Pages handoff to the production site; no customer data."""

import argparse
from html import escape
import json
from pathlib import Path
import shutil
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
SITE_URL = "https://renrob-lab-orders.kelly360753.chatgpt.site"


def render(site_url: str, factory: bool = False) -> str:
    parsed = urlsplit(site_url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise ValueError("Use an HTTPS production origin without credentials, path, query, or fragment")
    origin = site_url.rstrip("/")
    target = origin + ("/factory" if factory else "/")
    script_origin = json.dumps(origin).replace("<", "\\u003c")
    return f'''<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Re:Nrob Lab · 開啟訂單系統</title>
<style>body{{font-family:system-ui,sans-serif;margin:12vh auto;padding:24px;max-width:560px;color:#111;background:#fff}}a{{color:inherit}}p{{line-height:1.7}}</style>
</head><body><h1>Re:Nrob Lab</h1><p>正在開啟正式訂單系統…</p>
<p><a id="continue" href="{escape(target, quote=True)}">若沒有自動開啟，請按這裡</a></p>
<script>
(() => {{
  const factory = new URLSearchParams(location.search).get('view') === 'factory' || /\\/factory\\/?$/.test(location.pathname);
  const destination = {script_origin} + (factory ? '/factory' : '/');
  document.getElementById('continue').href = destination;
  location.replace(destination);
}})();
</script><noscript><p>請點選上方連結開啟網站。</p></noscript></body></html>
'''


def build(output: Path, site_url: str = SITE_URL) -> None:
    html = render(site_url)
    if output.is_symlink():
        raise ValueError("Refusing output symlink")
    if output.exists():
        shutil.rmtree(output)
    (output / "factory").mkdir(parents=True)
    (output / "index.html").write_text(html, encoding="utf-8")
    (output / "404.html").write_text(html, encoding="utf-8")
    (output / "factory" / "index.html").write_text(render(site_url, factory=True), encoding="utf-8")
    (output / ".nojekyll").write_text("", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-url", default=SITE_URL)
    args = parser.parse_args()
    build(ROOT / "pages-redirect-dist", args.site_url)
    print("Built production redirect only; no deployment performed.")
