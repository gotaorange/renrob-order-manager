# Re:Nrob Lab 雲端訂單系統

管理新單、打樣、大貨製作與內部帳務。雲端是共用的主要資料來源；Mac 同步程式另存本機副本。

## 架構與權限

- `app/` 與 `public/`：Next.js / Vinext 介面，內部管理 `/`，工廠唯讀 `/factory`。
- `lib/api.ts`：登入、訂單新增與更新、版本衝突檢查、設定、備份與同步清單。
- Sites D1 `DB`：訂單、設定、管理密碼雜湊、工作階段與登入頻率限制。
- Sites R2 `BUCKET`：附件與私有 PI Excel 範本。
- `lib/documents.ts`：上傳、授權下載、工廠報價 PDF 文字、PI XLSX / HTML 產生。

工廠 API 以白名單提供訂單進度、製作規格、顏色數量，以及設計圖稿、打樣請款單、打樣進項發票。客戶售價、PI、收款、報價及內部資料需管理登入。Mac 專用金鑰只可讀同步清單及內部附件，無法新增、修改或管理帳號。

## 設定與開發

使用 Node.js 22.13 或更新版本，先執行 `npm ci`，再執行 `npm run dev`。`npm run build` 產生 Sites 部署檔案。

`.openai/hosting.json` 宣告 D1 `DB` 與 R2 `BUCKET` 綁定。GitHub 中的整理版只保留這兩項公開綁定名稱；不含正式部署身份。正式發布使用 Sites 的專案設定、版本上傳及部署流程。

主機端以秘密變數提供：

| 名稱 | 用途 |
| --- | --- |
| `INITIAL_ADMIN_PASSWORD` | 首次登入時初始化管理密碼；之後可在網站更換，密碼以雜湊保存在 D1 |
| `MAC_SYNC_TOKEN` | 至少 32 字元的 Mac 單向同步專用金鑰 |

秘密不可提交 Git。本機開發可使用已忽略的 `.dev.vars`；正式部署由主機秘密設定提供。私有範本、資料與執行紀錄亦不可加入原始碼。

D1 結構定義位於 `db/schema.ts`，遷移檔位於 `drizzle/`。在本機建立預覽資料庫前，先 build 產生 Worker 設定，再套用尚未執行的遷移：

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_lean_supreme_intelligence.sql
```

此命令只處理本機預覽資料庫。正式資料庫由 Sites 部署流程套用遷移。

## PI 與資料搬移

PI 會產生新的版本檔案，保留舊版。已配置私有範本且最多 6 色時產生 XLSX；所有訂單另產生可列印 HTML。範本不放在公開程式庫。

`tools/convert_pi_template.py` 將支援的六色 `.xls` 版型轉成私有 `.xlsx` 範本，需要 Python 的 `xlrd`、`openpyxl`。`tools/migrate_local.py` 是一次性、可續傳的私有搬移工具；設定由標準輸入提供，不放入程式碼。搬移前應備份，且不應在已有不同訂單的資料庫上執行。

## 驗證

```sh
node --experimental-vm-modules --test tests/api-contract.test.mjs
node --test tests/test_documents.mjs
python3 tests/test_convert_pi_template.py
```

Python 範本測試另需 `xlwt`。測試使用虛構資料；部署後仍需驗證登入、公開欄位、實際附件下載、PI 與 Mac 同步全流程。

整理版原始碼的 `SOURCE_MANIFEST.json` 記錄逐檔 SHA256。它不包含客戶資料、金額、附件、私有範本、金鑰或 Mac 路徑。
