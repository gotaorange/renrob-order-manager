import type {FileKind, FileRecord, Order, OrderItem} from './types';

export class AppError extends Error {
  constructor(message: string, public status = 400) {super(message); this.name = 'AppError';}
}
export const PUBLIC_FILES = new Set<FileKind>(['design', 'sample_bill', 'sample_invoice']);
export const FILE_KINDS = new Set<FileKind>([...PUBLIC_FILES, 'quote', 'deposit_invoice', 'balance_invoice', 'pi', 'internal']);
export const STAGES = ['requirements', 'design_confirmed', 'sampling', 'sample_review', 'sample_confirmed'];
export function now() {return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19) + '+08:00';}
export function randomHex(bytes = 12) {return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');}
export function safeName(value: unknown, field = '名稱') {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[/\\\x00-\x1f:*?"<>|]/.test(value) || value.trim().startsWith('.')) throw new AppError(`${field}不可包含路徑或特殊字元，長度需為 1–100 字`);
  return value.trim();
}
export function text(value: unknown, field: string, limit = 4000) {
  if (typeof value !== 'string' || value.length > limit) throw new AppError(`${field}格式或長度不正確`);
  return value.trim();
}
export function amount(value: unknown, field: string) {
  if (!['number', 'string'].includes(typeof value) || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100000000) throw new AppError(`${field}必須是有效的非負數字`);
  // Shift the decimal exponent before rounding, matching Decimal ROUND_HALF_UP
  // without binary multiplication errors such as 10.075 * 100.
  const [mantissa, exponent = '0'] = String(Number(value)).toLowerCase().split('e');
  return Math.round(Number(`${mantissa}e${Number(exponent) + 2}`)) / 100;
}
export function totals(order: Pick<Order, 'items' | 'sampleFee' | 'shipping' | 'invoiceRequired' | 'taxMode' | 'deposit'>) {
  const subtotalCents = order.items.reduce((sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity, 0) + Math.round(order.sampleFee * 100);
  const shippingCents = Math.round(order.shipping * 100);
  const tax = order.invoiceRequired && order.taxMode === 'excluded' ? Math.round((subtotalCents + shippingCents) * 5 / 10000) : 0;
  const totalCents = subtotalCents + shippingCents + tax * 100;
  if (!Number.isSafeInteger(totalCents)) throw new AppError('訂單金額超過可處理範圍');
  return {subtotal: subtotalCents / 100, tax, total: totalCents / 100, balance: (totalCents - Math.round(order.deposit * 100)) / 100, quantity: order.items.reduce((sum, item) => sum + item.quantity, 0)};
}
function date(value: unknown) {
  if (!value) return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new AppError('請輸入有效日期');
  return value;
}
export function normalize(data: Record<string, unknown>, previous?: Order): Order {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError('訂單格式不正確');
  const order: Order = previous ? structuredClone(previous) : {
    id: randomHex(), orderNo: '', code: '', styleNo: '', createdAt: now(), updatedAt: now(), version: 0,
    files: [], history: [], workflowConfirmed: true, dataComplete: true, sampleRequired: true,
    sampleStage: 'requirements', productionStatus: 'waiting', sampleDue: '', productionDue: '',
    requirements: '', specifications: '', printDetails: '', packaging: '', sampleBill: '', sampleInvoice: '',
    samplePaid: false, samplePaidDate: '', invoiceRequired: false, taxMode: 'included', shipping: 0,
    sampleFee: 0, deposit: 0, depositReceived: false, depositInvoice: '', balanceReceived: false,
    balanceInvoice: '', buyer: '', internalNotes: '', items: [],
  };
  for (const key of ['orderNo', 'code'] as const) {
    order[key] = safeName(data[key] ?? order[key], key);
    if (previous && order[key] !== previous[key]) throw new AppError('訂單號與代號建立後不可修改，以保持資料夾連結');
  }
  for (const key of ['styleNo', 'requirements', 'specifications', 'printDetails', 'packaging', 'sampleBill', 'sampleInvoice', 'depositInvoice', 'balanceInvoice', 'buyer', 'internalNotes'] as const) order[key] = text(data[key] ?? order[key], key);
  if (!order.styleNo && previous?.dataComplete !== false) throw new AppError('請填寫款號');
  for (const key of ['sampleRequired', 'samplePaid', 'invoiceRequired', 'depositReceived', 'balanceReceived'] as const) {
    const value = data[key] ?? order[key];
    if (typeof value !== 'boolean') throw new AppError(`${key}格式不正確`);
    order[key] = value;
  }
  for (const key of ['sampleDue', 'productionDue', 'samplePaidDate'] as const) order[key] = date(data[key] ?? order[key]);
  for (const [key, choices] of [['sampleStage', STAGES], ['productionStatus', ['waiting', 'producing', 'completed']], ['taxMode', ['included', 'excluded']]] as const) {
    const value = data[key] ?? order[key];
    if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) throw new AppError('無效的流程或計價選項');
    order[key] = value;
  }
  if (order.sampleRequired && order.sampleStage !== 'sample_confirmed' && order.productionStatus !== 'waiting') throw new AppError('請先確認樣品，或選擇無須打樣，再開始生產大貨');
  const items = data.items ?? order.items;
  if (!Array.isArray(items) || items.length > 30 || (!items.length && previous?.dataComplete !== false)) throw new AppError('請填寫 1–30 筆顏色數量');
  order.items = items.map((item: unknown): OrderItem => {
    if (!item || typeof item !== 'object') throw new AppError('顏色數量格式不正確');
    const row = item as Record<string, unknown>, color = text(row.color, '顏色', 80), quantity = row.quantity;
    if (!color || typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000000) throw new AppError('每筆需填寫顏色與正整數數量');
    return {color, quantity, unitPrice: amount(row.unitPrice, '單價')};
  });
  for (const key of ['shipping', 'sampleFee', 'deposit'] as const) order[key] = amount(data[key] ?? order[key], key);
  order.dataComplete = Boolean(order.styleNo && order.items.length);
  if (order.deposit > totals(order).total) throw new AppError('定金不可超過訂單總額');
  if ('sampleStage' in data || 'productionStatus' in data) order.workflowConfirmed = true;
  order.updatedAt = now(); order.version++;
  return order;
}
export function publicOrder(order: Order) {
  const fields = ['id', 'orderNo', 'code', 'styleNo', 'sampleRequired', 'sampleStage', 'productionStatus', 'sampleDue', 'productionDue', 'requirements', 'specifications', 'printDetails', 'packaging', 'sampleBill', 'sampleInvoice', 'samplePaid', 'samplePaidDate', 'updatedAt', 'workflowConfirmed', 'dataComplete'] as const;
  return {...Object.fromEntries(fields.map(key => [key, order[key]])), items: order.items.map(({color, quantity}) => ({color, quantity})), files: order.files.filter(file => PUBLIC_FILES.has(file.kind)).map(({id, name, kind}) => ({id, name, kind}))};
}
export function privateOrder(order: Order) {return {...order, totals: totals(order), folder: `雲端訂單資料夾 / ${order.orderNo} ${order.code}`};}
export function migrationOrder(raw: Record<string, unknown>): Order {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[a-f0-9]{24}$/.test(raw.id)) throw new AppError('匯入訂單 ID 無效');
  const incomplete = raw.dataComplete === false;
  const base = normalize({...raw, styleNo: raw.styleNo || '匯入待確認', items: Array.isArray(raw.items) && raw.items.length ? raw.items : [{color: '待確認', quantity: 1, unitPrice: 0}], deposit: 0});
  const order = normalize(raw, {...base, id: raw.id, dataComplete: !incomplete, items: incomplete ? [] : base.items});
  order.id = raw.id;
  order.version = Number.isInteger(raw.version) && Number(raw.version) > 0 ? Number(raw.version) : 1;
  order.workflowConfirmed = raw.workflowConfirmed !== false;
  order.createdAt = text(raw.createdAt ?? now(), 'createdAt', 50);
  order.updatedAt = text(raw.updatedAt ?? now(), 'updatedAt', 50);
  order.history = Array.isArray(raw.history) ? raw.history.slice(-200).map(row => ({at: text(row.at, 'at', 50), text: text(row.text, 'history', 4000)})) : [];
  order.files = Array.isArray(raw.files) ? raw.files.map((file): FileRecord => {
    if (!file || typeof file !== 'object' || !/^[a-f0-9]{24}$/.test(file.id) || !FILE_KINDS.has(file.kind)) throw new AppError('匯入檔案資訊無效');
    return {id: file.id, name: safeName(file.name, '檔名'), stored: safeName(file.stored, '儲存檔名'), kind: file.kind, createdAt: text(file.createdAt ?? now(), 'createdAt', 50)};
  }) : [];
  return order;
}
