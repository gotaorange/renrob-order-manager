#!/usr/bin/env python3
"""Build a static, synthetic-data-only interface review site for GitHub Pages."""
from pathlib import Path
import re
import shutil


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "preview-dist"


def replace_exact(text, old, new, count=1):
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f"Review patch anchor changed: {old[:80]!r} ({actual} matches, expected {count})")
    return text.replace(old, new)


def build():
    # Only these public interface assets are read. No server, data, orders, or
    # reference files are copied into the artifact.
    app = (ROOT / "web/app.js").read_text(encoding="utf-8")
    start = "async function api(path,body,method='POST'){"
    end = "function toast(text){"
    if app.count(start) != 1 or app.count(end) != 1:
        raise RuntimeError("Review API boundary changed; refusing to build")
    before, api_and_after = app.split(start, 1)
    _, after = api_and_after.split(end, 1)
    app = before + "async function api(path,body,method='POST'){return window.RENROB_REVIEW.api(path,body,method);}\n" + end + after
    patches = [
        ("public:location.pathname==='/factory'", "public:new URLSearchParams(location.search).get('view')==='factory'", 1),
        ("state.public?'/factory':'/'", "state.public?'./?view=factory':'./'", 1),
        ('href="/factory"', 'href="./?view=factory"', 3),
        ('href="/api/', 'href="#preview-api/', 3),
        ("state.local?'本機・內部管理':'內部管理'", "'介面預覽・虛構資料'", 1),
        ("資料儲存於本機工作空間", "介面預覽・所有資料均為虛構", 1),
        ("此頁提供製作進度與協作文件，僅供查看。資料由 Re:Nrob Lab 更新。", "此頁示範工廠可見範圍；所有訂單、進度與日期均為虛構。", 1),
        ("資料夾已建立，可以開始存入檔案。", "介面預覽沒有連接資料夾，也不儲存檔案。", 1),
        ("未連接 Excel 範本，可輸出可列印 PI", "介面預覽未連接範本，不會產生 PI", 1),
        ("function modal(title,body,footer=''){const d=$('#modal');", "function modal(title,body,footer=''){title+=' · 介面預覽';body='<div class=\"note\" style=\"margin-bottom:18px\">所有內容均為虛構示範。此頁不會儲存、上傳、下載或變更任何資料。</div>'+body;const d=$('#modal');", 1),
    ]
    for old, new, count in patches:
        app = replace_exact(app, old, new, count)
    # A source change must not silently reintroduce backend calls or root links.
    if re.search(r"\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(", app):
        raise RuntimeError("Network API found in the static review build")
    if re.search(r'href=[\"\']/[^/]', app):
        raise RuntimeError("Absolute root navigation found in the review build")
    if OUTPUT.is_symlink():
        raise RuntimeError("Refusing to write through a preview-dist symlink")
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    OUTPUT.mkdir()
    (OUTPUT / "app.js").write_text(app, encoding="utf-8")
    for source, target in [
        ("web/style.css", "style.css"),
        ("web/favicon.svg", "favicon.svg"),
        ("review/index.html", "index.html"),
        ("review/review.js", "review.js"),
    ]:
        shutil.copyfile(ROOT / source, OUTPUT / target)
    (OUTPUT / ".nojekyll").write_text("", encoding="utf-8")
    print("Static review built in preview-dist/ (synthetic fixtures only)")


if __name__ == "__main__":
    build()
