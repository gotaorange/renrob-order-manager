import {AppError, migrationOrder, normalize, now, privateOrder, publicOrder, randomHex, text} from './domain';
import type {CloudEnv, DocumentMutation, Order} from './types';
import {downloadFile, generatePi, listFiles, migrateFile, putPrivateTemplate, readQuoteText, rollbackFiles, uploadFile} from './documents';

type Auth = {salt: string; hash: string; iterations: number; version: string};
const encoder = new TextEncoder();
const SESSION_SECONDS = 8 * 3600;
const BODY_LIMIT = 22000000;
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
async function digest(value: string) {return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));}
function equal(a: string, b: string) {let diff = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return diff === 0;}
async function passwordHash(password: string, salt: string, iterations: number) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const saltBytes = Uint8Array.from(salt.match(/../g) || [], byte => parseInt(byte, 16));
  return hex(await crypto.subtle.deriveBits({name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256'}, key, 256));
}
async function newAuth(password: string): Promise<Auth> {
  if (password.length < 12 || password.length > 500) throw new AppError('管理密碼需為 12–500 個字元');
  const salt = randomHex(16), iterations = 100000;
  return {salt, iterations, hash: await passwordHash(password, salt, iterations), version: randomHex(16)};
}
async function getSetting(env: CloudEnv, key: string) {return (await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first<{value: string}>())?.value;}
async function safeSettings(env: CloudEnv) {
  const rows = await env.DB.prepare("SELECT key,value FROM settings WHERE key IN ('seller','piTerms','templateKey')").all<{key: string; value: string}>();
  const values = Object.fromEntries(rows.results.map(row => [row.key, row.value]));
  return {seller: values.seller || '', piTerms: values.piTerms || '', templateKey: values.templateKey || ''};
}
async function authSetting(env: CloudEnv, initialize = false) {
  let value = await getSetting(env, 'auth');
  if (!value && initialize) {
    if (!env.INITIAL_ADMIN_PASSWORD) throw new AppError('管理登入尚未初始化，請設定初始管理密碼', 503);
    const auth = await newAuth(env.INITIAL_ADMIN_PASSWORD);
    await env.DB.prepare("INSERT INTO settings(key,value) VALUES('auth',?) ON CONFLICT(key) DO NOTHING").bind(JSON.stringify(auth)).run();
    value = await getSetting(env, 'auth');
  }
  return value ? JSON.parse(value) as Auth : null;
}
function cookieToken(request: Request) {
  const match = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)renrob_session=([a-f0-9]{96})(?:;|$)/);
  return match?.[1] || '';
}
function cookie(request: Request, token: string, maxAge = SESSION_SECONDS) {
  const url = new URL(request.url), local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  return `renrob_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${local ? '' : '; Secure'}`;
}
async function session(request: Request, env: CloudEnv) {
  const token = cookieToken(request); if (!token) return null;
  const tokenHash = await digest(token);
  const found = await env.DB.prepare("SELECT s.token_hash,s.auth_version FROM sessions s JOIN settings a ON a.key='auth' WHERE s.token_hash=? AND s.expires>? AND s.auth_version=json_extract(a.value,'$.version')").bind(tokenHash, Date.now()).first<{token_hash: string; auth_version: string}>();
  return found;
}
async function requireAdmin(request: Request, env: CloudEnv) {const current = await session(request, env); if (!current) throw new AppError('請先登入內部管理', 401); return current;}
async function canSync(request: Request, env: CloudEnv) {
  const header = request.headers.get('Authorization') || '';
  if (!env.MAC_SYNC_TOKEN || env.MAC_SYNC_TOKEN.length < 32 || !header.startsWith('Bearer ')) return false;
  return equal(await digest(header.slice(7)), await digest(env.MAC_SYNC_TOKEN));
}
function guard(request: Request) {
  if (!['POST', 'PUT'].includes(request.method)) return;
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') throw new AppError('僅接受 JSON 請求', 415);
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) throw new AppError('不允許的請求來源', 403);
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new AppError('不允許的跨站請求', 403);
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('Content-Length') || 0) > BODY_LIMIT) throw new AppError('檔案上限為 15 MB', 413);
  const reader = request.body?.getReader(); if (!reader) throw new AppError('無效的資料格式');
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const result = await reader.read(); if (result.done) break;
    length += result.value.length;
    if (length > BODY_LIMIT) {await reader.cancel(); throw new AppError('檔案上限為 15 MB', 413);}
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
  try {const data = JSON.parse(new TextDecoder().decode(bytes)); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data;}
  catch {throw new AppError('無效的資料格式');}
}
async function allOrders(env: CloudEnv) {const rows = await env.DB.prepare('SELECT body FROM orders ORDER BY number DESC').all<{body: string}>(); return rows.results.map(row => JSON.parse(row.body) as Order);}
async function readOrder(env: CloudEnv, id: string) {
  const row = await env.DB.prepare('SELECT body,version FROM orders WHERE id=?').bind(id).first<{body: string; version: number}>();
  if (!row) throw new AppError('找不到這筆訂單', 404);
  const order = JSON.parse(row.body) as Order; order.version = row.version; return order;
}
async function compareAndSave(env: CloudEnv, order: Order, previousVersion: number) {
  order.history = order.history.slice(-200);
  const result = await env.DB.prepare('UPDATE orders SET body=?,version=? WHERE id=? AND version=?').bind(JSON.stringify(order), order.version, order.id, previousVersion).run();
  if (result.meta.changes !== 1) throw new AppError('這筆訂單已更新，請重新整理後再修改', 409);
}
async function saveDocument(env: CloudEnv, original: Order, mutation: DocumentMutation) {
  try {await compareAndSave(env, mutation.order, original.version);}
  catch (error) {await rollbackFiles(env, mutation.createdKeys); throw error;}
  return privateOrder(mutation.order);
}
function json(body: unknown, status = 200, headers?: HeadersInit) {return Response.json(body, {status, headers});}
async function login(request: Request, env: CloudEnv, data: Record<string, unknown>) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unidentified-client';
  const key = await digest(ip), timestamp = Date.now(), windowStart = timestamp - 15 * 60000;
  const attempts = await env.DB.prepare('INSERT INTO login_attempts(key,window_start,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END,count=CASE WHEN window_start<? THEN 1 ELSE count+1 END RETURNING count').bind(key, timestamp, windowStart, windowStart).first<{count: number}>();
  if (!attempts || attempts.count > 10) throw new AppError('嘗試次數過多，請 15 分鐘後再試', 429);
  const password = text(data.password, '密碼', 500), auth = await authSetting(env, true);
  if (!auth || !equal(await passwordHash(password, auth.salt, auth.iterations), auth.hash)) throw new AppError('密碼不正確', 401);
  const token = randomHex(48), tokenHash = await digest(token);
  const inserted = await env.DB.prepare("INSERT INTO sessions(token_hash,expires,auth_version) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM settings WHERE key='auth' AND json_extract(value,'$.version')=?)").bind(tokenHash, timestamp + SESSION_SECONDS * 1000, auth.version, auth.version).run();
  if (inserted.meta.changes !== 1) throw new AppError('管理密碼已更新，請重新登入', 401);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_attempts WHERE key=? OR window_start<?').bind(key, timestamp - 86400000),
    env.DB.prepare('DELETE FROM sessions WHERE expires<=?').bind(timestamp),
  ]);
  return json({ok: true}, 200, {'Set-Cookie': cookie(request, token)});
}
async function initializeMigration(env: CloudEnv, data: Record<string, unknown>) {
  if (!Array.isArray(data.orders) || !data.orders.length || data.orders.length > 100) throw new AppError('每次初始匯入需有 1–100 筆訂單');
  const imported = data.orders.map(raw => migrationOrder(raw));
  if (new Set(imported.map(order => order.id)).size !== imported.length || new Set(imported.map(order => order.orderNo)).size !== imported.length) throw new AppError('匯入資料有重複訂單');
  const config = data.config && typeof data.config === 'object' && !Array.isArray(data.config) ? data.config as Record<string, unknown> : {};
  const marker = randomHex(16);
  const statements = [env.DB.prepare("INSERT INTO settings(key,value) SELECT 'migration',? WHERE NOT EXISTS(SELECT 1 FROM orders) AND NOT EXISTS(SELECT 1 FROM settings WHERE key='migration')").bind(marker)];
  for (const order of imported) statements.push(env.DB.prepare("INSERT INTO orders(id,number,body,version) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM settings WHERE key='migration' AND value=?)").bind(order.id, order.orderNo, JSON.stringify(order), order.version, marker));
  for (const key of ['seller', 'piTerms']) statements.push(env.DB.prepare("INSERT INTO settings(key,value) SELECT ?,? WHERE EXISTS(SELECT 1 FROM settings WHERE key='migration' AND value=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, text(config[key] ?? '', key, 20000), marker));
  const results = await env.DB.batch(statements);
  if (results[0].meta.changes !== 1) throw new AppError('初始匯入僅允許空白資料庫執行一次', 409);
  return json({ok: true, imported: imported.length, orders: imported.map(order => ({id: order.id, orderNo: order.orderNo, version: order.version}))}, 201);
}
async function dispatch(request: Request, env: CloudEnv): Promise<Response> {
  if (!env.DB || !env.BUCKET) throw new AppError('雲端資料庫或檔案儲存尚未連接', 503);
  guard(request);
  const pathname = new URL(request.url).pathname;
  let path: string; try {path = decodeURIComponent(pathname);} catch {throw new AppError('無效的網址');}
  if (request.method === 'GET') {
    if (path === '/api/session') return json({admin: Boolean(await session(request, env)), local: false});
    if (path === '/api/public/orders') return json({orders: (await allOrders(env)).map(publicOrder)});
    const file = path.match(/^\/api\/(public\/)?orders\/([a-f0-9]{24})\/file\/(.+)$/);
    if (file) {
      const isPublic = Boolean(file[1]);
      if (!isPublic && !(await canSync(request, env))) await requireAdmin(request, env);
      return downloadFile(env, await readOrder(env, file[2]), file[3], isPublic);
    }
    if (path === '/api/sync/manifest') {
      if (!(await canSync(request, env))) await requireAdmin(request, env);
      const orders = await allOrders(env);
      return json({schema: 1, exportedAt: now(), orders: orders.map(order => ({...order, files: order.files.map(({objectKey: _objectKey, ...file}) => file)}))});
    }
    await requireAdmin(request, env);
    if (path === '/api/orders') return json({orders: (await allOrders(env)).map(privateOrder)});
    if (path === '/api/settings') {
      const config = await safeSettings(env), templateAvailable = Boolean(config.templateKey && await env.BUCKET.head(config.templateKey));
      return json({ordersRoot: '雲端共用訂單資料夾（由 Mac 單向下載備份）', piTemplate: templateAvailable ? '已連接私有 PI 範本' : '尚未連接 PI 範本', templateAvailable, seller: config.seller, piTerms: config.piTerms});
    }
    if (path === '/api/backup') return json({schema: 1, exportedAt: now(), orders: await allOrders(env)}, 200, {'Content-Disposition': 'attachment; filename="renrob-backup.json"'});
    const documents = path.match(/^\/api\/orders\/([a-f0-9]{24})\/(files|quote-text)$/);
    if (documents) return json(await (documents[2] === 'files' ? listFiles(env, await readOrder(env, documents[1])) : readQuoteText(env, await readOrder(env, documents[1]))));
    throw new AppError('找不到頁面', 404);
  }
  if (!['POST', 'PUT'].includes(request.method)) throw new AppError('不支援此操作方式', 405);
  // Authenticate before reading potentially large upload bodies.
  const currentSession = path === '/api/login' && request.method === 'POST' ? null : await requireAdmin(request, env);
  const data = await readBody(request);
  if (path === '/api/login' && request.method === 'POST') return login(request, env, data);
  if (path === '/api/logout' && request.method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(currentSession!.token_hash).run();
    return json({ok: true}, 200, {'Set-Cookie': cookie(request, '', 0)});
  }
  if (path === '/api/password' && request.method === 'POST') {
    const auth = await newAuth(text(data.password, '密碼', 500));
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE settings SET value=? WHERE key='auth' AND json_extract(value,'$.version')=?").bind(JSON.stringify(auth), currentSession!.auth_version),
      env.DB.prepare('DELETE FROM sessions WHERE auth_version=?').bind(currentSession!.auth_version),
    ]);
    if (results[0].meta.changes !== 1) throw new AppError('管理密碼已更新，請重新登入', 409);
    return json({ok: true}, 200, {'Set-Cookie': cookie(request, '', 0)});
  }
  if (path === '/api/migrate/init' && request.method === 'POST') return initializeMigration(env, data);
  if (path === '/api/migrate/template' && request.method === 'POST') {
    const template = await putPrivateTemplate(env, data);
    try {await env.DB.prepare("INSERT INTO settings(key,value) VALUES('templateKey',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(template.templateKey).run();}
    catch (error) {await rollbackFiles(env, template.createdKeys); throw error;}
    return json({ok: true, templateAvailable: true});
  }
  if (path === '/api/migrate/file' && request.method === 'POST') {
    const order = await readOrder(env, text(data.orderId, 'orderId', 24));
    return json(await saveDocument(env, order, await migrateFile(env, order, data)));
  }
  if (path === '/api/orders' && request.method === 'POST') {
    const order = normalize(data); order.history = [{at: now(), text: '建立訂單'}];
    await env.DB.prepare('INSERT INTO orders(id,number,body,version) VALUES(?,?,?,?)').bind(order.id, order.orderNo, JSON.stringify(order), order.version).run();
    return json(privateOrder(order), 201);
  }
  const match = path.match(/^\/api\/orders\/([a-f0-9]{24})(?:\/(upload|pi))?$/);
  if (match) {
    const order = await readOrder(env, match[1]);
    if (data.version !== order.version) throw new AppError('這筆訂單已更新，請重新整理後再修改', 409);
    if (!match[2] && request.method === 'PUT') {
      const updated = normalize(data, order); updated.history.push({at: now(), text: '更新訂單與工作進度'});
      await compareAndSave(env, updated, order.version); return json(privateOrder(updated));
    }
    if (match[2] && request.method === 'POST') {
      const result = match[2] === 'upload' ? await uploadFile(env, order, data) : await generatePi(env, order, data, await safeSettings(env));
      return json(await saveDocument(env, order, result));
    }
  }
  throw new AppError('找不到操作', 404);
}
export async function handleApi(request: Request, env: CloudEnv): Promise<Response> {
  let response: Response;
  try {response = await dispatch(request, env);}
  catch (error) {
    if (error instanceof AppError) response = json({error: error.message}, error.status);
    else if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) response = json({error: '訂單號或匯入資料已存在'}, 409);
    else {console.error('Order API error', error instanceof Error ? error.name : 'unknown'); response = json({error: '操作未完成，請重試或聯絡管理者'}, 500);}
  }
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store'); headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'no-referrer'); headers.set('X-Frame-Options', 'DENY');
  return new Response(response.body, {status: response.status, headers});
}
