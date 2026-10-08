#!/usr/bin/env python3
"""Private, resumable transfer of the existing workspace into an empty cloud app.
Configuration (source_data, origin, password, optional service_token) is read
from hidden stdin. Customer data and credentials never enter the source tree.
"""
import base64,hashlib,http.cookiejar,json,os,sqlite3,ssl,sys,termios,urllib.request
from pathlib import Path

def hidden_json():
    if sys.stdin.isatty():
        original=termios.tcgetattr(sys.stdin);hidden=original.copy();hidden[3]&=~termios.ECHO
        termios.tcsetattr(sys.stdin,termios.TCSANOW,hidden)
        try:
            print('Ready for private migration configuration on stdin.',flush=True)
            return json.loads(sys.stdin.readline())
        finally:termios.tcsetattr(sys.stdin,termios.TCSANOW,original)
    return json.load(sys.stdin)

def main():
    config=hidden_json();source=Path(config['source_data']).resolve();origin=config['origin'].rstrip('/')
    if not origin.startswith('https://'):raise ValueError('HTTPS required')
    local=json.loads((source/'config.json').read_text());root=Path(local['ordersRoot']).resolve()
    with sqlite3.connect('file:'+str(source/'orders.sqlite3')+'?mode=ro',uri=True) as db:
        orders=[json.loads(row[0]) for row in db.execute('SELECT body FROM orders ORDER BY number')]
    ctx=ssl.create_default_context(cafile='/etc/ssl/cert.pem') if sys.platform=='darwin' and Path('/etc/ssl/cert.pem').exists() else ssl.create_default_context()
    opener=urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def api(path,data=None):
        headers={'Origin':origin}
        if config.get('service_token'):headers['OAI-Sites-Authorization']='Bearer '+config['service_token']
        payload=None
        if data is not None:headers['Content-Type']='application/json';payload=json.dumps(data,ensure_ascii=False).encode()
        req=urllib.request.Request(origin+path,data=payload,headers=headers)
        try:
            with opener.open(req,timeout=90) as r:return json.load(r)
        except urllib.error.HTTPError as e:
            try:message=json.load(e).get('error','HTTP '+str(e.code))
            except Exception:message='HTTP '+str(e.code)
            raise RuntimeError(path+': '+message) from None
    api('/api/login',{'password':config['password']})
    existing=api('/api/orders')['orders']
    if not existing:
        initial=[dict(o,files=[]) for o in orders]
        api('/api/migrate/init',{'orders':initial,'config':{k:local.get(k,'') for k in ('seller','piTerms')}})
        existing=api('/api/orders')['orders']
    if {o['id'] for o in existing}!={o['id'] for o in orders}:raise ValueError('Cloud order set differs; refusing to overwrite')
    remote={o['id']:o for o in existing}
    print('Verified %d cloud orders.'%len(orders),flush=True)
    template=Path(config['template']).resolve()
    if not api('/api/settings')['templateAvailable']:
        api('/api/migrate/template',{'name':'pi-template.xlsx','base64':base64.b64encode(template.read_bytes()).decode()})
    print('Private PI template connected.',flush=True)
    planned=[]
    for order in orders:
        folder=root/(order['orderNo']+' '+order['code'])
        if folder.is_symlink() or folder.resolve().parent!=root:raise ValueError('Unsafe source folder')
        for path in sorted(folder.iterdir()):
            if path.name.startswith('.'):continue
            if path.is_symlink() or not path.is_file():raise ValueError('Unsupported source entry')
            match=next((f for f in order.get('files',[]) if f['stored']==path.name),None)
            file=dict(match) if match else {'id':hashlib.sha256((order['id']+'\0'+path.name).encode()).hexdigest()[:24],'stored':path.name,'name':path.name,'kind':'internal','createdAt':order.get('createdAt','')}
            planned.append((order,path,file))
    uploaded=0;skipped=0
    for index,(order,path,file) in enumerate(planned,1):
        raw=path.read_bytes();sha=hashlib.sha256(raw).hexdigest()
        same=next((f for f in remote[order['id']]['files'] if f['id']==file['id'] and f.get('sha256')==sha),None)
        if same:skipped+=1
        else:
            remote[order['id']]=api('/api/migrate/file',{'orderId':order['id'],'file':file,'base64':base64.b64encode(raw).decode()});uploaded+=1
        print('Files verified: %d/%d'%(index,len(planned)),flush=True)
    final=api('/api/orders')['orders']
    assert len(final)==len(orders)
    assert sum(len(o['files']) for o in final)==len(planned)
    print(json.dumps({'orders':len(final),'files':len(planned),'uploaded':uploaded,'already_verified':skipped,'templateAvailable':api('/api/settings')['templateAvailable']}),flush=True)
    api('/api/logout',{})
if __name__=='__main__':main()
