#!/usr/bin/env python3
"""Re:Nrob Lab order workspace. Public responses are explicitly allowlisted."""
from __future__ import annotations
import base64, copy, datetime as dt, hashlib, hmac, html, json, mimetypes, os, re, secrets, sqlite3, sys, threading, time
from decimal import Decimal, ROUND_HALF_UP
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE / '.vendor'))
DATA = Path(os.environ.get('RENROB_DATA', BASE / 'data')).resolve()
DATA.mkdir(parents=True, exist_ok=True)
CONFIG_FILE = DATA / 'config.json'
CONFIG = json.loads(CONFIG_FILE.read_text()) if CONFIG_FILE.exists() else {}
ROOT = Path(os.environ.get('RENROB_ORDERS', CONFIG.get('ordersRoot', str(DATA / 'orders')))).expanduser().resolve()
TEMPLATE = Path(os.environ.get('RENROB_PI_TEMPLATE', CONFIG.get('piTemplate', str(DATA / 'pi-template.xls'))))
HOST = os.environ.get('HOST', '127.0.0.1')
PORT = int(os.environ.get('PORT', '8765'))
LOCAL = HOST in ('127.0.0.1', 'localhost')
SESSIONS, ATTEMPTS = {}, {}
LOCK = threading.RLock()
PUBLIC_FILES = {'design', 'sample_bill', 'sample_invoice'}
FILE_KINDS = PUBLIC_FILES | {'quote', 'deposit_invoice', 'balance_invoice', 'pi', 'internal'}
STAGES = ['requirements', 'design_confirmed', 'sampling', 'sample_review', 'sample_confirmed']
PRODUCTION = ['waiting', 'producing', 'completed']

class AppError(Exception):
    def __init__(self, message, status=400): self.message, self.status = message, status

def now(): return dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec='seconds')
def db():
    c = sqlite3.connect(DATA / 'orders.sqlite3', timeout=15)
    c.execute('PRAGMA journal_mode=WAL')
    return c
with db() as c:
    c.execute('CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, number TEXT UNIQUE NOT NULL, body TEXT NOT NULL)')

def read_order(oid):
    with db() as c: row = c.execute('SELECT body FROM orders WHERE id=?', (oid,)).fetchone()
    if not row: raise AppError('找不到這筆訂單', 404)
    return json.loads(row[0])

def all_orders():
    with db() as c: rows = c.execute('SELECT body FROM orders ORDER BY number DESC').fetchall()
    return [json.loads(x[0]) for x in rows]

def save_order(o):
    with db() as c:
        try: c.execute('INSERT INTO orders VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', (o['id'], o['orderNo'], json.dumps(o, ensure_ascii=False)))
        except sqlite3.IntegrityError: raise AppError('訂單號已存在，請使用不同的訂單號', 409)

def safe_name(value, field='名稱'):
    if not isinstance(value, str) or not value.strip() or len(value) > 100 or re.search(r'[/\\\x00-\x1f:*?"<>|]', value) or value.strip() in ('.', '..') or value.startswith('.'):
        raise AppError(f'{field}不可包含路徑或特殊字元，長度需為 1–100 字')
    return value.strip()

def order_dir(o):
    name = safe_name(o['orderNo']) + ' ' + safe_name(o['code'])
    p = ROOT / name
    if p.is_symlink() or p.resolve().parent != ROOT: raise AppError('資料夾路徑無效', 403)
    return p

def amount(v, name):
    try:
        d = Decimal(str(v))
        if not d.is_finite() or d < 0 or d > 100000000: raise ValueError()
        return float(d.quantize(Decimal('.01'), rounding=ROUND_HALF_UP))
    except Exception: raise AppError(name + '必須是有效的非負數字')

def short(v, name, limit=4000):
    if not isinstance(v, str) or len(v) > limit: raise AppError(name + '格式或長度不正確')
    return v.strip()

def normalize(data, previous=None):
    o = copy.deepcopy(previous) if previous else {
        'id': secrets.token_hex(12), 'createdAt': now(), 'version': 0, 'files': [], 'history': [],
        'workflowConfirmed': True, 'sampleRequired': True, 'sampleStage': 'requirements', 'productionStatus': 'waiting',
        'sampleDue': '', 'productionDue': '', 'requirements': '', 'specifications': '', 'printDetails': '', 'packaging': '',
        'sampleBill': '', 'sampleInvoice': '', 'samplePaid': False, 'samplePaidDate': '',
        'invoiceRequired': False, 'taxMode': 'included', 'shipping': 0, 'sampleFee': 0, 'deposit': 0, 'depositReceived': False,
        'depositInvoice': '', 'balanceReceived': False, 'balanceInvoice': '', 'buyer': '', 'internalNotes': ''}
    if not isinstance(data, dict): raise AppError('訂單格式不正確')
    for k in ('orderNo', 'code'):
        o[k] = safe_name(data.get(k, o.get(k, '')), k)
        if previous and o[k] != previous[k]: raise AppError('訂單號與代號建立後不可修改，以保持資料夾連結')
    for k in ('styleNo', 'requirements', 'specifications', 'printDetails', 'packaging', 'sampleBill', 'sampleInvoice', 'depositInvoice', 'balanceInvoice', 'buyer', 'internalNotes'):
        o[k] = short(data.get(k, o.get(k, '')), k)
    if not o['styleNo'] and not (previous and previous.get('dataComplete') is False): raise AppError('請填寫款號')
    for k in ('sampleRequired', 'samplePaid', 'invoiceRequired', 'depositReceived', 'balanceReceived'):
        v = data.get(k, o[k])
        if not isinstance(v, bool): raise AppError(k + '格式不正確')
        o[k] = v
    for k in ('sampleDue', 'productionDue', 'samplePaidDate'):
        v = data.get(k, o[k])
        if v:
            try: dt.date.fromisoformat(v)
            except (ValueError, TypeError): raise AppError('請輸入有效日期')
        o[k] = v or ''
    for k, choices in [('sampleStage', STAGES), ('productionStatus', PRODUCTION), ('taxMode', ['included', 'excluded'])]:
        o[k] = data.get(k, o[k])
        if o[k] not in choices: raise AppError('無效的流程或計價選項')
    if o['sampleRequired'] and o['sampleStage'] != 'sample_confirmed' and o['productionStatus'] != 'waiting':
        raise AppError('請先確認樣品，或選擇無須打樣，再開始生產大貨')
    items = data.get('items', o.get('items', []))
    if not isinstance(items, list) or len(items)>30 or (not items and not (previous and previous.get('dataComplete') is False)): raise AppError('請填寫 1–30 筆顏色數量')
    o['items'] = []
    for i in items:
        color = short(i.get('color', ''), '顏色', 80)
        qty = i.get('quantity')
        if not color or isinstance(qty, bool) or not isinstance(qty, (int, float)) or qty != int(qty) or not 1 <= qty <= 1000000:
            raise AppError('每筆需填寫顏色與正整數數量')
        o['items'].append({'color': color, 'quantity': int(qty), 'unitPrice': amount(i.get('unitPrice'), '單價')})
    for k in ('shipping', 'sampleFee', 'deposit'): o[k] = amount(data.get(k, o.get(k, 0)), k)
    o['dataComplete'] = bool(o['styleNo'] and o['items'])
    if o['deposit'] > totals(o)['total']: raise AppError('定金不可超過訂單總額')
    if any(k in data for k in ('sampleStage', 'productionStatus')): o['workflowConfirmed'] = True
    o['updatedAt'], o['version'] = now(), o['version'] + 1
    return o

def totals(o):
    subtotal = sum(Decimal(str(x['unitPrice'])) * x['quantity'] for x in o['items']) + Decimal(str(o.get('sampleFee', 0)))
    shipping = Decimal(str(o.get('shipping', 0)))
    tax = ((subtotal + shipping) * Decimal('.05')).quantize(Decimal('1'), rounding=ROUND_HALF_UP) if o.get('invoiceRequired') and o.get('taxMode') == 'excluded' else Decimal(0)
    total = subtotal + shipping + tax
    deposit = Decimal(str(o.get('deposit', 0)))
    return {'subtotal': float(subtotal), 'tax': float(tax), 'total': float(total), 'balance': float(total - deposit), 'quantity': sum(x['quantity'] for x in o['items'])}

def public_order(o):
    fields = ('id', 'orderNo', 'code', 'styleNo', 'sampleRequired', 'sampleStage', 'productionStatus', 'sampleDue', 'productionDue', 'requirements', 'specifications', 'printDetails', 'packaging', 'sampleBill', 'sampleInvoice', 'samplePaid', 'samplePaidDate', 'updatedAt')
    result = {k: o.get(k) for k in fields}
    result['workflowConfirmed'] = o.get('workflowConfirmed', True)
    result['dataComplete'] = o.get('dataComplete', True)
    result['items'] = [{k: x[k] for k in ('color', 'quantity')} for x in o['items']]
    result['files'] = [{k: f[k] for k in ('id', 'name', 'kind')} for f in o['files'] if f['kind'] in PUBLIC_FILES]
    return result

def private_order(o): return {**o, 'totals': totals(o), 'folder': str(order_dir(o))}

def file_path(o, name):
    folder = order_dir(o)
    p = folder / safe_name(name, '檔名')
    if p.is_symlink() or p.resolve().parent != folder.resolve(): raise AppError('檔案路徑無效', 403)
    if not p.is_file(): raise AppError('檔案不存在', 404)
    return p

def pi_html(o):
    esc = lambda x: html.escape(str(x)).replace('\n', '<br>')
    t = totals(o)
    terms = CONFIG.get('piTerms', '')
    seller = CONFIG.get('seller', '')
    rows = ''.join(f'<tr><td>{esc(x["color"])}</td><td>{x["quantity"]} PCS</td><td>NTD {x["unitPrice"]:,.2f}</td><td>NTD {x["quantity"]*x["unitPrice"]:,.2f}</td></tr>' for x in o['items'])
    return f'''<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>{esc(o['orderNo'])} PI</title><style>
    @page{{size:A4;margin:18mm}}body{{font:12px/1.6 Arial,"PingFang TC",sans-serif;color:#111;max-width:780px;margin:40px auto}}header{{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid;padding-bottom:15px}}h1{{font-size:34px;font-weight:300;margin:0}}table{{width:100%;border-collapse:collapse;margin-top:22px}}th{{background:#ddd;text-align:left}}th,td{{padding:8px;border-bottom:1px solid #ddd}}.spec{{padding:18px 0;white-space:normal}}.total{{text-align:right;border-top:2px solid;padding-top:12px}}.sign{{display:flex;justify-content:space-between;min-height:95px;margin-top:20px}}.terms{{font-size:9px;line-height:1.65;white-space:pre-line}}.print{{position:fixed;top:10px;right:20px}}@media print{{body{{margin:0}}.print{{display:none}}}}</style>
    <button class="print" onclick="window.print()">列印 / 另存 PDF</button><header><div>{esc(o['buyer'])}</div><div><h1>INVOICE</h1>合約書 / 報價單<br>DATE: {now()[:10]}<br>S/No. {esc(o['orderNo'])}</div></header>
    <p>ITEM: {esc(o['styleNo'])}　訂製包款</p><table><thead><tr><th>Color</th><th>Qty</th><th>Unit Price</th><th>Total (NTD)</th></tr></thead><tbody>{rows}</tbody></table>
    <div class="spec">{esc(o['specifications'])}<br>{esc(o['printDetails'])}<br>{esc(o['packaging'])}</div><div class="total">客戶打樣費 NTD {o.get('sampleFee',0):,.2f}<br>TOTAL: {t['quantity']} PCS / NTD {t['subtotal']:,.2f}<br>運費 NTD {o['shipping']:,.2f}<br>外加稅額 NTD {t['tax']:,.2f}<br><strong>GRAND TOTAL: NTD {t['total']:,.2f}</strong></div>
    <div class="sign"><div>賣方（乙方）資訊<br>{esc(seller)}</div><div>賣方簽章</div><div>買方（甲方）確認簽章</div></div><div class="terms">{esc(terms)}</div></html>'''

def generate_pi(o):
    if not o.get('dataComplete', True): raise AppError('請先補齊款號、顏色、數量與單價')
    if not o['buyer']: raise AppError('請先在 PI 資料中填寫買方資訊')
    folder = order_dir(o)
    folder.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(2)
    stem = f'{o["code"]} {o["orderNo"]} PI {stamp}'
    outputs = []
    # BIFF .xls is not supported by modern xlsx importers. xlutils preserves its native layout.
    if TEMPLATE.is_file() and len(o['items']) <= 6:
        import xlrd, xlwt
        from xlutils.filter import process, XLRDReader, XLWTWriter
        original = xlrd.open_workbook(str(TEMPLATE), formatting_info=True)
        source = original.sheet_by_index(0)
        writer = XLWTWriter()
        process(XLRDReader(original, 'template.xls'), writer)
        book = writer.output[0][1]
        sheet = book.get_sheet(0)
        styles = writer.style_list
        def put(r, c, value): sheet.write(r, c, value, styles[source.cell(r, c).xf_index])
        put(2, 0, o['buyer']); put(4, 5, dt.datetime.now()); put(5, 5, o['orderNo'])
        put(10, 0, 'ITEM: ' + o['styleNo']); put(11, 1, o['specifications'])
        put(17, 1, o['printDetails']); put(18, 1, o['packaging'])
        for r in range(11,17):
            for c in range(2,6): put(r,c,'')
        for j, x in enumerate(o['items'], 11):
            for col, value in enumerate([x['color'],x['quantity'],x['unitPrice'],xlwt.Formula(f'D{j+1}*E{j+1}')],2): put(j,col,value)
        put(18,4,'客戶打樣費'); put(18,5,o.get('sampleFee',0))
        put(19,3,xlwt.Formula('SUM(D12:D17)')); put(19,5,xlwt.Formula('SUM(F12:F17)+F19'))
        put(20,4,'外加稅額'); put(20,5,xlwt.Formula('ROUND((F20+F22)*0.05,0)') if o['invoiceRequired'] and o['taxMode']=='excluded' else 0); put(21,5,o['shipping'])
        put(22,5,xlwt.Formula('SUM(F20:F22)'))
        path = folder / (stem + '.xls')
        book.save(str(path)); outputs.append(path)
    path = folder / (stem + '.html')
    path.write_text(pi_html(o), encoding='utf-8'); outputs.append(path)
    for path in outputs:
        o['files'].append({'id': secrets.token_hex(12), 'name': path.name, 'stored': path.name, 'kind': 'pi', 'createdAt': now()})
    return [p.name for p in outputs]

class Handler(BaseHTTPRequestHandler):
    server_version = 'Renrob'
    def log_message(self, fmt, *args): pass
    def headers_common(self):
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('X-Frame-Options','DENY')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
    def respond(self, body, status=200, content_type='application/json; charset=utf-8', extra=None):
        raw = json.dumps(body, ensure_ascii=False).encode() if content_type.startswith('application/json') else body if isinstance(body, bytes) else body.encode()
        self.send_response(status); self.headers_common()
        self.send_header('Content-Type', content_type); self.send_header('Content-Length',str(len(raw)))
        for k,v in (extra or {}).items(): self.send_header(k,v)
        self.end_headers(); self.wfile.write(raw)
    def session(self):
        c=SimpleCookie()
        try: c.load(self.headers.get('Cookie',''))
        except Exception: return None
        token = c['renrob_session'].value if 'renrob_session' in c else ''
        s = SESSIONS.get(token)
        if s and s['expires'] > time.time(): return s
        return None
    def require_admin(self):
        if not self.session(): raise AppError('請先登入內部管理',401)
    def body(self):
        try: size = int(self.headers.get('Content-Length','0'))
        except ValueError: raise AppError('無效的請求')
        if size < 0 or size > 22000000: raise AppError('檔案上限為 15 MB',413)
        try: data = json.loads(self.rfile.read(size))
        except Exception: raise AppError('無效的資料格式')
        if not isinstance(data,dict): raise AppError('無效的資料格式')
        return data
    def guard(self, mutation=False):
        host = self.headers.get('Host','')
        if LOCAL and host not in (f'127.0.0.1:{PORT}',f'localhost:{PORT}'): raise AppError('不允許的存取來源',403)
        if mutation:
            if self.headers.get('Content-Type','').split(';')[0] != 'application/json': raise AppError('僅接受 JSON 請求',415)
            origin = self.headers.get('Origin')
            allowed = os.environ.get('PUBLIC_ORIGIN', f'http://{host}')
            if origin and origin != allowed: raise AppError('不允許的請求來源',403)
            if self.headers.get('Sec-Fetch-Site') == 'cross-site': raise AppError('不允許的跨站請求',403)
    def do_GET(self): self.dispatch(False)
    def do_POST(self): self.dispatch(True)
    def do_PUT(self): self.dispatch(True)
    def dispatch(self, mutation):
        try:
            self.guard(mutation)
            path = unquote(urlsplit(self.path).path)
            if mutation:
                with LOCK: return self.write_api(path, self.body())
            return self.read_api(path)
        except AppError as e: self.respond({'error':e.message},e.status)
        except PermissionError: self.respond({'error':'無法寫入指定資料夾，請檢查本機資料夾權限'},403)
        except Exception as e:
            print(f'{type(e).__name__}: {e}',file=sys.stderr)
            self.respond({'error':'操作未完成，請重試或檢查伺服器記錄'},500)
    def read_api(self,path):
        if path == '/api/session': return self.respond({'admin':bool(self.session()),'local':LOCAL})
        if path == '/api/public/orders': return self.respond({'orders':[public_order(o) for o in all_orders()]})
        if path == '/api/orders':
            self.require_admin(); return self.respond({'orders':[private_order(o) for o in all_orders()]})
        if path == '/api/settings':
            self.require_admin(); return self.respond({'ordersRoot':str(ROOT),'piTemplate':str(TEMPLATE),'templateAvailable':TEMPLATE.is_file(),'seller':CONFIG.get('seller',''),'piTerms':CONFIG.get('piTerms','')})
        if path == '/api/backup':
            self.require_admin(); return self.respond({'schema':1,'exportedAt':now(),'orders':all_orders()},extra={'Content-Disposition':'attachment; filename="renrob-backup.json"'})
        m=re.fullmatch(r'/api/orders/([a-f0-9]+)/files',path)
        if m:
            self.require_admin(); o=read_order(m[1]); folder=order_dir(o)
            files=[]
            if folder.exists():
                for p in sorted(folder.iterdir()):
                    if p.is_file() and not p.is_symlink() and not p.name.startswith('.'):
                        match=next((f for f in o['files'] if f['stored']==p.name),None)
                        files.append({'name':p.name,'size':p.stat().st_size,'kind':match['kind'] if match else 'internal','id':match['id'] if match else None})
            return self.respond({'files':files,'folder':str(folder)})
        m=re.fullmatch(r'/api/orders/([a-f0-9]+)/quote-text',path)
        if m:
            self.require_admin(); o=read_order(m[1]); folder=order_dir(o); blocks=[]
            from pypdf import PdfReader
            for p in folder.glob('*.pdf'):
                if ('報價' in p.name or any(f['stored']==p.name and f['kind']=='quote' for f in o['files'])) and not p.is_symlink():
                    try: blocks.append({'name':p.name,'text':'\n'.join(page.extract_text() for page in PdfReader(p).pages)[:30000]})
                    except Exception: blocks.append({'name':p.name,'text':'無法擷取文字；請下載原檔查看，掃描檔需要人工輸入。'})
            return self.respond({'quotes':blocks})
        m=re.fullmatch(r'/api/(public/)?orders/([a-f0-9]+)/file/(.+)',path)
        if m:
            public, oid, key = m.groups(); o=read_order(oid)
            if public:
                f=next((f for f in o['files'] if f['id']==key and f['kind'] in PUBLIC_FILES),None)
                if not f: raise AppError('找不到檔案',404)
                p=file_path(o,f['stored'])
            else:
                self.require_admin(); p=file_path(o,key)
            from urllib.parse import quote
            return self.respond(p.read_bytes(),content_type=mimetypes.guess_type(p.name)[0] or 'application/octet-stream',extra={'Content-Disposition':"attachment; filename*=UTF-8''"+quote(p.name)})
        if path in ('/', '/factory', '/login'): path='/index.html'
        if path not in ('/index.html','/app.js','/startup.js','/style.css','/favicon.svg'): raise AppError('找不到頁面',404)
        p=BASE/'web'/path[1:]
        content_types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'}
        return self.respond(p.read_bytes(),content_type=content_types[p.suffix])
    def write_api(self,path,data):
        if path == '/api/login':
            key=self.client_address[0]; recent=[t for t in ATTEMPTS.get(key,[]) if t>time.time()-900]
            if len(recent)>=10: raise AppError('嘗試次數過多，請 15 分鐘後再試',429)
            ATTEMPTS[key]=recent+[time.time()]
            config=CONFIG.get('auth',{})
            password=short(data.get('password',''),'密碼',500)
            digest=hashlib.scrypt(password.encode(),salt=bytes.fromhex(config.get('salt','00')),n=16384,r=8,p=1).hex()
            env_password=os.environ.get('ADMIN_PASSWORD')
            valid=hmac.compare_digest(password,env_password) if env_password else hmac.compare_digest(digest,config.get('hash',''))
            if not valid: raise AppError('密碼不正確',401)
            token=secrets.token_urlsafe(48); SESSIONS[token]={'expires':time.time()+8*3600}; ATTEMPTS[key]=[]
            secure='; Secure' if not LOCAL else ''
            return self.respond({'ok':True},extra={'Set-Cookie':f'renrob_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800{secure}'})
        self.require_admin()
        if path == '/api/logout':
            c=SimpleCookie(); c.load(self.headers.get('Cookie',''))
            if 'renrob_session' in c: SESSIONS.pop(c['renrob_session'].value,None)
            return self.respond({'ok':True},extra={'Set-Cookie':'renrob_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'})
        if path == '/api/password':
            value=short(data.get('password',''),'密碼',500)
            if len(value)<12: raise AppError('新密碼至少需要 12 個字元')
            if os.environ.get('ADMIN_PASSWORD'): raise AppError('線上密碼請在主機環境設定中更新')
            salt=secrets.token_bytes(16); CONFIG['auth']={'salt':salt.hex(),'hash':hashlib.scrypt(value.encode(),salt=salt,n=16384,r=8,p=1).hex()}
            CONFIG_FILE.write_text(json.dumps(CONFIG,ensure_ascii=False,indent=2)); CONFIG_FILE.chmod(0o600)
            return self.respond({'ok':True})
        if path == '/api/orders' and self.command=='POST':
            o=normalize(data)
            if any(x['orderNo']==o['orderNo'] for x in all_orders()): raise AppError('訂單號已存在',409)
            folder=order_dir(o)
            # Preexisting folders belong to real orders and must never be silently claimed.
            if folder.exists(): raise AppError('同名資料夾已存在，請先確認既有訂單，避免混用資料',409)
            folder.mkdir(parents=True)
            o['history']=[{'at':now(),'text':'建立訂單'}]; save_order(o)
            return self.respond(private_order(o),201)
        m=re.fullmatch(r'/api/orders/([a-f0-9]+)(?:/(upload|pi))?',path)
        if m:
            o=read_order(m[1]); action=m[2]
            if data.get('version') != o['version']: raise AppError('這筆訂單已更新，請重新整理後再修改',409)
            if not action:
                o=normalize(data,o); o['history'].append({'at':now(),'text':'更新訂單與工作進度'})
            elif action=='pi':
                names=generate_pi(o); o['version']+=1; o['updatedAt']=now(); o['history'].append({'at':now(),'text':'製作 PI：'+', '.join(names)})
            elif action=='upload':
                kind=data.get('kind'); name=safe_name(data.get('name',''),'檔名')
                if kind not in FILE_KINDS or kind=='pi': raise AppError('無效的檔案類別')
                try: raw=base64.b64decode(data.get('base64',''),validate=True)
                except Exception: raise AppError('檔案資料無效')
                if len(raw)>15*1024*1024 or not raw: raise AppError('請選擇 15 MB 以內的非空白檔案')
                if Path(name).suffix.lower() not in {'.pdf','.jpg','.jpeg','.png','.ai','.xls','.xlsx','.docx','.txt','.zip'}: raise AppError('不支援此檔案格式')
                fid=secrets.token_hex(12); stored=f'{fid[:8]}_{name}'; folder=order_dir(o); folder.mkdir(parents=True,exist_ok=True)
                with (folder/stored).open('xb') as f: f.write(raw)
                o['files'].append({'id':fid,'name':name,'stored':stored,'kind':kind,'createdAt':now()}); o['version']+=1; o['updatedAt']=now()
                o['history'].append({'at':now(),'text':'新增檔案：'+name})
            o['history']=o['history'][-200:]; save_order(o); return self.respond(private_order(o))
        raise AppError('找不到操作',404)

def main():
    if not CONFIG.get('auth') and not os.environ.get('ADMIN_PASSWORD'):
        raise SystemExit('請先執行 setup_local.py，或設定 ADMIN_PASSWORD（至少 12 字元）。')
    if os.environ.get('ADMIN_PASSWORD') and len(os.environ['ADMIN_PASSWORD'])<12: raise SystemExit('ADMIN_PASSWORD 至少需要 12 字元。')
    if not LOCAL and not os.environ.get('PUBLIC_ORIGIN','').startswith('https://'): raise SystemExit('線上部署需設定 https:// 開頭的 PUBLIC_ORIGIN。')
    print(f'Re:Nrob Lab: http://{HOST}:{PORT}',flush=True)
    ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
if __name__=='__main__': main()
