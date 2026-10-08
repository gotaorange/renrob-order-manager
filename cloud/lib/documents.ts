import ExcelJS from "exceljs";
import { extractText, getDocumentProxy } from "unpdf";
import { AppError, now, totals as amounts } from "./domain";
import type { CloudEnv, FileRecord, Order } from "./types";

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const DEFAULT_TEMPLATE_KEY = "settings/pi-template.xlsx";
const PUBLIC_KINDS = new Set(["design", "sample_bill", "sample_invoice"]);
const FILE_KINDS = new Set([...PUBLIC_KINDS, "quote", "deposit_invoice", "balance_invoice", "pi", "internal"]);
const MIME: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  ai: "application/postscript", xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8", zip: "application/zip", html: "text/html; charset=utf-8",
};

export type DocumentMutation = { order: Order; createdKeys: string[] };
export type PiSettings = { seller: string; piTerms: string; templateKey?: string };
type Input = Record<string, unknown>;

function safeName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 240 ||
      /[\/\\\u0000-\u001f\u007f:*?"<>|\u202a-\u202e\u2066-\u2069]/u.test(value) || value.startsWith(".")) {
    throw new AppError("檔名格式不正確，請移除路徑與特殊字元");
  }
  return value.trim();
}

function id(): string { return crypto.randomUUID().replaceAll("-", ""); }
function taipeiDate(date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(date);
}
function extension(name: string): string { return name.split(".").pop()?.toLowerCase() || ""; }
function readBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || value.length % 4 !== 0) {
    throw new AppError("請提供 15 MB 以內的有效檔案資料");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  // A repeated capture/group per quartet overflows V8's stack on multi-MB files.
  // This character-class scan is linear and permits padding only at the end.
  if (/[^A-Za-z0-9+/]/.test(value.slice(0, contentLength))) throw new AppError("請提供有效的檔案資料");
  const byteLength = value.length / 4 * 3 - padding;
  if (!byteLength || byteLength > MAX_FILE_BYTES) throw new AppError("請選擇 15 MB 以內的非空白檔案");
  const decoded = new Uint8Array(byteLength);
  let position = 0;
  // Decode aligned 64 KiB chunks so a second full-size binary string is never
  // retained alongside the request's base64 and output bytes in Worker memory.
  for (let offset = 0; offset < value.length; offset += 65536) {
    const chunk = atob(value.slice(offset, offset + 65536));
    for (let index = 0; index < chunk.length; index++) decoded[position++] = chunk.charCodeAt(index);
  }
  return decoded;
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}
function objectKey(order: Order, file: FileRecord): string {
  const key = file.objectKey;
  if (!key || !key.startsWith(`orders/${order.id}/`) || key.includes("..") || key.includes("\\")) {
    throw new AppError("此檔案尚未完成雲端同步", 404);
  }
  return key;
}

/** API callers must authenticate before using private helpers and CAS the returned order. */
export async function rollbackFiles(env: CloudEnv, createdKeys: string[]): Promise<void> {
  if (createdKeys.length) await env.BUCKET.delete(createdKeys);
}

async function writeFile(env: CloudEnv, order: Order, metadata: FileRecord, bytes: Uint8Array): Promise<FileRecord> {
  const key = `orders/${order.id}/${id()}/${safeName(metadata.stored)}`;
  const contentType = MIME[extension(metadata.name)] || "application/octet-stream";
  const digest = await sha256(bytes);
  try {
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType, cacheControl: "private, no-store" } });
  } catch (error) {
    await rollbackFiles(env, [key]).catch(() => undefined);
    throw error;
  }
  return { ...metadata, objectKey: key, size: bytes.byteLength, contentType, sha256: digest };
}

function changed(order: Order, files: FileRecord[], text: string): Order {
  const stamp = now();
  return { ...order, files, version: order.version + 1, updatedAt: stamp,
    history: [...order.history, { at: stamp, text }].slice(-200) };
}

export async function listFiles(_env: CloudEnv, order: Order) {
  return { files: order.files.map(file => ({ id: file.id, name: file.stored, size: file.size || 0,
    kind: FILE_KINDS.has(file.kind) ? file.kind : "internal" })), folder: `${order.orderNo} ${order.code}` };
}

export async function uploadFile(env: CloudEnv, order: Order, data: Input): Promise<DocumentMutation> {
  const name = safeName(data.name);
  const kind = typeof data.kind === "string" ? data.kind : "internal";
  if (!FILE_KINDS.has(kind) || kind === "pi") throw new AppError("無效的檔案類別");
  if (!MIME[extension(name)] || extension(name) === "html") throw new AppError("不支援此檔案格式");
  const fid = id();
  const file = await writeFile(env, order, { id: fid, name, stored: `${fid.slice(0, 8)}_${name}`,
    kind, createdAt: now() } as FileRecord, readBase64(data.base64));
  return { order: changed(order, [...order.files, file], `新增檔案：${name}`), createdKeys: [file.objectKey!] };
}

export async function migrateFile(env: CloudEnv, order: Order, data: Input): Promise<DocumentMutation> {
  if (!data.file || typeof data.file !== "object") throw new AppError("缺少檔案紀錄");
  const source = data.file as Input;
  const name = safeName(source.name);
  const stored = safeName(source.stored || name);
  const kind = typeof source.kind === "string" ? source.kind : "internal";
  if (!FILE_KINDS.has(kind)) throw new AppError("無效的檔案類別");
  if (!MIME[extension(name)]) throw new AppError("不支援此檔案格式");
  const fid = typeof source.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(source.id) ? source.id : id();
  const createdAt = typeof source.createdAt === "string" && Number.isFinite(Date.parse(source.createdAt)) ? source.createdAt : now();
  const file = await writeFile(env, order, { id: fid, name, stored, kind, createdAt } as FileRecord, readBase64(data.base64));
  const previous = order.files.filter(entry => entry.id !== fid);
  return { order: changed(order, [...previous, file], `同步既有檔案：${name}`), createdKeys: [file.objectKey!] };
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function downloadFile(env: CloudEnv, order: Order, key: string, isPublic: boolean): Promise<Response> {
  // Public requests use only an opaque file id. Neither a filename nor an R2 key grants access.
  const file = isPublic ? order.files.find(entry => entry.id === key && PUBLIC_KINDS.has(entry.kind)) :
    order.files.find(entry => entry.id === key || entry.stored === key);
  if (!file) throw new AppError("找不到檔案", 404);
  const object = await env.BUCKET.get(objectKey(order, file));
  if (!object) throw new AppError("找不到檔案", 404);
  return new Response(object.body, { headers: {
    "Content-Type": MIME[extension(file.name)] || "application/octet-stream",
    "Content-Length": String(object.size), "Content-Disposition": contentDisposition(safeName(file.name)),
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'", "Referrer-Policy": "no-referrer",
  } });
}

export async function readQuoteText(env: CloudEnv, order: Order) {
  const quotes: { name: string; text: string }[] = [];
  for (const file of order.files.filter(entry => extension(entry.name) === "pdf" &&
    (entry.kind === "quote" || entry.name.includes("報價")))) {
    try {
      const object = await env.BUCKET.get(objectKey(order, file));
      if (!object || object.size > MAX_FILE_BYTES) throw new Error("Missing or oversized PDF");
      const document = await getDocumentProxy(new Uint8Array(await object.arrayBuffer()));
      try {
        if (document.numPages > 100) throw new Error("PDF exceeds page limit");
        const result = await extractText(document, { mergePages: true });
        const text = result.text;
        quotes.push({ name: file.name, text: text.trim() ? text.slice(0, 30000) : "未擷取到文字，請下載原檔查看；掃描檔需要人工輸入。" });
      } finally { await document.cleanup(); }
    } catch {
      quotes.push({ name: file.name, text: "無法擷取文字；請下載原檔查看，掃描檔需要人工輸入。" });
    }
  }
  return { quotes };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!).replaceAll("\n", "<br>");
}

export function piHtml(order: Order, settings: PiSettings, date = new Date()): string {
  const total = amounts(order);
  const money = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rows = order.items.map(item => `<tr><td>${escapeHtml(item.color)}</td><td>${item.quantity} PCS</td><td>NTD ${money(item.unitPrice)}</td><td>NTD ${money(Math.round(item.quantity * item.unitPrice * 100) / 100)}</td></tr>`).join("");
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${escapeHtml(order.orderNo)} PI</title><style>
  @page{size:A4;margin:18mm}body{font:12px/1.6 Arial,"PingFang TC",sans-serif;color:#111;max-width:780px;margin:40px auto}header{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid;padding-bottom:15px}h1{font-size:34px;font-weight:300;margin:0}table{width:100%;border-collapse:collapse;margin-top:22px}th{background:#ddd;text-align:left}th,td{padding:8px;border-bottom:1px solid #ddd}.spec{padding:18px 0}.total{text-align:right;border-top:2px solid;padding-top:12px}.sign{display:flex;justify-content:space-between;min-height:95px;margin-top:20px}.terms{font-size:9px;line-height:1.65}tr{break-inside:avoid}@media print{body{margin:0}}</style></head><body>
  <header><div>${escapeHtml(order.buyer)}</div><div><h1>INVOICE</h1>合約書 / 報價單<br>DATE: ${taipeiDate(date)}<br>S/No. ${escapeHtml(order.orderNo)}</div></header><p>ITEM: ${escapeHtml(order.styleNo)}　訂製包款</p>
  <table><thead><tr><th>Color</th><th>Qty</th><th>Unit Price</th><th>Total (NTD)</th></tr></thead><tbody>${rows}</tbody></table><div class="spec">${escapeHtml(order.specifications)}<br>${escapeHtml(order.printDetails)}<br>${escapeHtml(order.packaging)}</div>
  <div class="total">客戶打樣費 NTD ${money(order.sampleFee)}<br>TOTAL: ${total.quantity} PCS / NTD ${money(total.subtotal)}<br>運費 NTD ${money(order.shipping)}<br>外加稅額 NTD ${money(total.tax)}<br><strong>GRAND TOTAL: NTD ${money(total.total)}</strong></div>
  <div class="sign"><div>賣方（乙方）資訊<br>${escapeHtml(settings.seller)}</div><div>賣方簽章</div><div>買方（甲方）確認簽章</div></div><div class="terms">${escapeHtml(settings.piTerms)}</div></body></html>`;
}

export async function fillPiWorkbook(template: Uint8Array, order: Order, settings: PiSettings, date = new Date()): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(template as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0];
  if (!sheet || order.items.length > 6) throw new AppError("Excel PI 範本最多容納 6 筆顏色明細");
  const total = amounts(order);
  const put = (address: string, value: ExcelJS.CellValue) => { sheet.getCell(address).value = value; };
  put("A3", order.buyer); put("F5", new Date(`${taipeiDate(date)}T00:00:00Z`)); put("F6", order.orderNo);
  put("A11", `ITEM: ${order.styleNo}`); put("B12", order.specifications);
  put("B18", order.printDetails); put("B19", order.packaging); put("B26", settings.seller);
  const [firstTerms, ...remainingTerms] = settings.piTerms.split("\n\n");
  put("A28", firstTerms); put("A30", remainingTerms.join("\n\n"));
  for (let row = 12; row <= 17; row++) for (const column of ["C", "D", "E", "F"]) put(`${column}${row}`, null);
  order.items.forEach((item, index) => {
    const row = index + 12;
    put(`C${row}`, item.color); put(`D${row}`, item.quantity); put(`E${row}`, item.unitPrice);
    put(`F${row}`, { formula: `D${row}*E${row}`, result: Math.round(item.quantity * item.unitPrice * 100) / 100 });
  });
  put("E19", "客戶打樣費"); put("F19", order.sampleFee);
  put("D20", { formula: "SUM(D12:D17)", result: total.quantity });
  put("F20", { formula: "SUM(F12:F17)+F19", result: total.subtotal });
  put("E21", "外加稅額");
  put("F21", order.invoiceRequired && order.taxMode === "excluded" ? { formula: "ROUND((F20+F22)*0.05,0)", result: total.tax } : 0);
  put("F22", order.shipping); put("F23", { formula: "SUM(F20:F22)", result: total.total });
  // Old templates mix integer NTD formats with another currency in unused rows.
  // Display the stored cents faithfully when those rows become real line items.
  for (let row = 12; row <= 17; row++) for (const column of ["E", "F"]) {
    sheet.getCell(`${column}${row}`).numFmt = '"NTD "#,##0.00';
  }
  for (const address of ["F19", "F20", "F21", "F22", "F23"]) sheet.getCell(address).numFmt = '"NTD "#,##0.00';
  // The source tax row can be a 5-point spacer; make its now-populated text visible.
  sheet.getRow(21).height = Math.max(sheet.getRow(21).height || 0, (sheet.getCell("F21").font?.size || 12) + 4);
  workbook.calcProperties.fullCalcOnLoad = true;
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export async function generatePi(env: CloudEnv, order: Order, _data: Input, settings: PiSettings): Promise<DocumentMutation> {
  if (order.dataComplete === false || !order.items.length || !order.styleNo) throw new AppError("請先補齊款號、顏色、數量與單價");
  if (!order.buyer) throw new AppError("請先在 PI 資料中填寫買方資訊");
  const stamp = new Date();
  const stem = `${safeName(order.code)} ${safeName(order.orderNo)} PI ${taipeiDate(stamp).replaceAll("-", "")}-${id().slice(0, 12)}`;
  const outputs: { name: string; bytes: Uint8Array }[] = [];
  if (order.items.length <= 6) {
    const template = await env.BUCKET.get(settings.templateKey || DEFAULT_TEMPLATE_KEY);
    if (template) {
      if (template.size > MAX_FILE_BYTES) throw new AppError("PI 範本超過大小限制");
      outputs.push({ name: `${stem}.xlsx`, bytes: await fillPiWorkbook(new Uint8Array(await template.arrayBuffer()), order, settings, stamp) });
    }
  }
  outputs.push({ name: `${stem}.html`, bytes: new TextEncoder().encode(piHtml(order, settings, stamp)) });
  const files: FileRecord[] = [];
  try {
    for (const output of outputs) {
      files.push(await writeFile(env, order, { id: id(), name: output.name, stored: output.name, kind: "pi", createdAt: now() } as FileRecord, output.bytes));
    }
  } catch (error) {
    await rollbackFiles(env, files.map(file => file.objectKey!));
    throw error;
  }
  return { order: changed(order, [...order.files, ...files], `製作 PI：${files.map(file => file.name).join("、")}`), createdKeys: files.map(file => file.objectKey!) };
}

export async function putPrivateTemplate(env: CloudEnv, data: Input): Promise<{ templateKey: string; createdKeys: string[] }> {
  const name = safeName(data.name);
  if (extension(name) !== "xlsx") throw new AppError("請先將原始 XLS 範本轉為 XLSX");
  const bytes = readBase64(data.base64);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]); }
  catch { throw new AppError("無法讀取 XLSX 範本"); }
  if (!workbook.worksheets.length) throw new AppError("PI 範本沒有工作表");
  const templateKey = `settings/pi-template/${id()}.xlsx`;
  try { await env.BUCKET.put(templateKey, bytes, { httpMetadata: { contentType: MIME.xlsx, cacheControl: "private, no-store" } }); }
  catch (error) { await rollbackFiles(env, [templateKey]).catch(() => undefined); throw error; }
  return { templateKey, createdKeys: [templateKey] };
}
