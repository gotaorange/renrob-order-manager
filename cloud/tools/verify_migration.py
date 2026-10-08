#!/usr/bin/env python3
"""Read-only verification of migrated records, private objects and public boundary."""
import concurrent.futures, hashlib, http.cookiejar, json, sqlite3, ssl, sys, urllib.error, urllib.parse, urllib.request
from pathlib import Path
from migrate_local import hidden_json

def main():
    config=hidden_json(); origin=config['origin'].rstrip('/'); source=Path(config['source_data'])
    if not origin.startswith('https://'):raise ValueError('HTTPS required')
    ctx=ssl.create_default_context(cafile='/etc/ssl/cert.pem') if sys.platform=='darwin' else ssl.create_default_context()
    jar=http.cookiejar.CookieJar()
    opener=urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx),urllib.request.HTTPCookieProcessor(jar))
    service={'OAI-Sites-Authorization':'Bearer '+config['service_token']} if config.get('service_token') else {}
    def request(path,data=None,authenticated=True):
        headers={**service,'Origin':origin}
        if data is not None:headers['Content-Type']='application/json'
        req=urllib.request.Request(origin+path,headers=headers,data=None if data is None else json.dumps(data).encode())
        client=opener if authenticated else urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))
        with client.open(req,timeout=90) as response:return response.status,response.headers,response.read()
    def api(path,data=None,authenticated=True):return json.loads(request(path,data,authenticated)[2])
    api('/api/login',{'password':config['password']})
    cloud=api('/api/orders')['orders']
    with sqlite3.connect('file:'+str(source/'orders.sqlite3')+'?mode=ro',uri=True) as db:local=[json.loads(row[0]) for row in db.execute('SELECT body FROM orders')]
    actual={o['id']:o for o in cloud}; assert set(actual)=={o['id'] for o in local},'Order set differs'
    ignored={'files','history','version','updatedAt','folder','totals'}
    for order in local:
        for key,value in order.items():
            if key not in ignored:assert actual[order['id']].get(key)==value,f'Migrated field differs: {key}'
    public=api('/api/public/orders',authenticated=False)['orders']
    allowed={'id','orderNo','code','styleNo','sampleRequired','sampleStage','productionStatus','sampleDue','productionDue','requirements','specifications','printDetails','packaging','sampleBill','sampleInvoice','samplePaid','samplePaidDate','updatedAt','workflowConfirmed','dataComplete','items','files'}
    assert len(public)==len(cloud)
    for order in public:
        assert set(order)<=allowed
        assert all(set(item)=={'color','quantity'} for item in order['items'])
        assert all(f['kind'] in {'design','sample_bill','sample_invoice'} and set(f)<= {'id','name','kind'} for f in order['files'])
    for endpoint in ('/api/orders','/api/settings','/api/backup','/api/sync/manifest'):
        try:request(endpoint,authenticated=False)
        except urllib.error.HTTPError as error:assert error.code==401
        else:raise AssertionError('Anonymous internal endpoint allowed')
    files=[(o['id'],f) for o in cloud for f in o['files']]
    def check_file(record):
        oid,file=record; path='/api/orders/'+oid+'/file/'+urllib.parse.quote(file['id'],safe='')
        status,headers,raw=request(path)
        assert status==200 and hashlib.sha256(raw).hexdigest()==file['sha256'] and len(raw)==file['size'],'File bytes differ'
        assert 'attachment' in headers.get('Content-Disposition','')
        return len(raw)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:total=sum(pool.map(check_file,files))
    if files:
        oid,file=files[0]
        try:request('/api/public/orders/'+oid+'/file/'+file['id'],authenticated=False)
        except urllib.error.HTTPError as error:assert error.code==404
        else:assert file['kind'] in {'design','sample_bill','sample_invoice'}
    assert api('/api/settings')['templateAvailable']
    api('/api/logout',{})
    print(json.dumps({'orders_exactly_preserved':len(cloud),'files_downloaded_and_sha256_verified':len(files),'verified_bytes':total,'public_privacy':'passed','private_template':'connected'}),flush=True)
if __name__=='__main__':main()
