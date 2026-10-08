import base64, copy, importlib.util, json, os, tempfile, threading, unittest, urllib.request, urllib.error
from pathlib import Path

TMP=tempfile.TemporaryDirectory()
os.environ['RENROB_DATA']=TMP.name
os.environ['RENROB_ORDERS']=str(Path(TMP.name)/'orders')
os.environ['ADMIN_PASSWORD']='test-password-2026-only'
BASE=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('renrob_server',BASE/'server.py')
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)

class OrderAppTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http=s.ThreadingHTTPServer(('127.0.0.1',0),s.Handler)
        s.PORT=cls.http.server_port
        cls.origin=f'http://127.0.0.1:{s.PORT}'
        threading.Thread(target=cls.http.serve_forever,daemon=True).start()
        code,body,headers=cls.req('/api/login',{'password':os.environ['ADMIN_PASSWORD']})
        cls.cookie=headers['Set-Cookie'].split(';')[0]
    @classmethod
    def tearDownClass(cls): cls.http.shutdown();cls.http.server_close();TMP.cleanup()
    @classmethod
    def req(cls,path,body=None,auth=False,method=None,origin=None):
        headers={'Origin':origin or cls.origin}
        if body is not None: headers['Content-Type']='application/json'
        if auth: headers['Cookie']=cls.cookie
        r=urllib.request.Request(cls.origin+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
        try: response=urllib.request.urlopen(r)
        except urllib.error.HTTPError as e: response=e
        raw=response.read()
        return response.status,json.loads(raw) if response.headers.get('Content-Type','').startswith('application/json') else raw,response.headers
    def new_order(self,suffix=''):
        import secrets
        return {'orderNo':'TEST-'+secrets.token_hex(3)+suffix,'code':'測試用','styleNo':'RNL001','items':[{'color':'BLUE','quantity':20,'unitPrice':300},{'color':'BLACK','quantity':30,'unitPrice':300}],'buyer':'測試買方','sampleFee':1000,'invoiceRequired':True,'taxMode':'excluded','deposit':5000,'internalNotes':'PRIVATE_SENTINEL'}
    def test_01_auth_public_redaction_and_creation(self):
        self.assertEqual(self.req('/api/orders')[0],401)
        self.assertEqual(self.req('/api/settings')[0],401)
        self.assertEqual(self.req('/api/backup')[0],401)
        data=self.new_order();self.assertEqual(self.req('/api/orders',data)[0],401)
        code,o,_=self.req('/api/orders',data,True)
        self.assertEqual(code,201);self.assertTrue((s.ROOT/(o['orderNo']+' '+o['code'])).is_dir())
        self.assertEqual(o['totals']['total'],16800);self.assertEqual(o['totals']['balance'],11800)
        raw=json.dumps(self.req('/api/public/orders')[1])
        for key in ('unitPrice','invoiceRequired','deposit','balance','buyer','internalNotes','PRIVATE_SENTINEL','folder','sampleFee','totals'):
            self.assertNotIn(key,raw)
    def test_startup_assets(self):
        for path in ('/', '/factory', '/startup.js?v=2', '/app.js?v=2', '/style.css?v=2'):
            code,body,headers=self.req(path)
            self.assertEqual(code,200)
            self.assertIn('charset=utf-8',headers['Content-Type'])
            self.assertTrue(body)
            self.assertEqual(headers['Cache-Control'],'no-store')
    def test_02_workflow_and_stale_write(self):
        o=self.req('/api/orders',self.new_order(),True)[1]
        self.assertEqual(self.req('/api/orders/'+o['id'],{'version':o['version'],'productionStatus':'producing'},True,'PUT')[0],400)
        code,new,_=self.req('/api/orders/'+o['id'],{'version':o['version'],'sampleRequired':False,'productionStatus':'producing'},True,'PUT')
        self.assertEqual(code,200);self.assertEqual(new['productionStatus'],'producing')
        self.assertEqual(self.req('/api/orders/'+o['id'],{'version':o['version'],'requirements':'stale'},True,'PUT')[0],409)
    def test_03_traversal_duplicate_and_validation(self):
        data=self.new_order();data['code']='../escape'
        self.assertEqual(self.req('/api/orders',data,True)[0],400)
        data=self.new_order();data['items'][0]['quantity']=-1
        self.assertEqual(self.req('/api/orders',data,True)[0],400)
        data=self.new_order();data['items'][0]['unitPrice']='NaN'
        self.assertEqual(self.req('/api/orders',data,True)[0],400)
        data=self.new_order();self.req('/api/orders',data,True)
        self.assertEqual(self.req('/api/orders',data,True)[0],409)
        self.assertEqual(self.req('/data/config.json')[0],404)
        self.assertEqual(self.req('/api/orders',self.new_order(),True,origin='https://attacker.example')[0],403)
    def test_04_files_visibility_and_download(self):
        o=self.req('/api/orders',self.new_order(),True)[1]
        body={'version':o['version'],'name':'secret.txt','kind':'deposit_invoice','base64':base64.b64encode(b'SECRET').decode()}
        o=self.req('/api/orders/'+o['id']+'/upload',body,True)[1]
        private=o['files'][0]
        self.assertEqual(self.req(f'/api/public/orders/{o["id"]}/file/{private["id"]}')[0],404)
        self.assertEqual(self.req(f'/api/orders/{o["id"]}/file/{private["stored"]}')[0],401)
        body.update(version=o['version'],name='design.txt',kind='design',base64=base64.b64encode(b'PUBLIC DESIGN').decode())
        o=self.req('/api/orders/'+o['id']+'/upload',body,True)[1]
        code,raw,_=self.req(f'/api/public/orders/{o["id"]}/file/{o["files"][1]["id"]}')
        self.assertEqual(code,200);self.assertEqual(raw,b'PUBLIC DESIGN')
        self.assertNotIn('secret.txt',json.dumps(self.req('/api/public/orders')[1]))
    def test_05_pi_template_and_preservation(self):
        if not (BASE/'data/config.json').exists(): self.skipTest('Private PI template is not part of the public repository')
        config=json.loads((BASE/'data/config.json').read_text())
        s.TEMPLATE=Path(config['piTemplate']);s.CONFIG.update({k:config[k] for k in ('piTerms','seller')})
        before=s.TEMPLATE.read_bytes()
        o=self.req('/api/orders',self.new_order(),True)[1]
        code,result,_=self.req('/api/orders/'+o['id']+'/pi',{'version':o['version']},True)
        self.assertEqual(code,200,result)
        paths=[s.order_dir(result)/f['stored'] for f in result['files']]
        self.assertEqual({p.suffix for p in paths},{'.xls','.html'})
        self.assertEqual(before,s.TEMPLATE.read_bytes())
        import xlrd
        original=xlrd.open_workbook(str(s.TEMPLATE),formatting_info=True)
        book=xlrd.open_workbook(str(next(p for p in paths if p.suffix=='.xls')),formatting_info=True)
        a,b=original.sheet_by_index(0),book.sheet_by_index(0)
        self.assertEqual(sorted(a.merged_cells),sorted(b.merged_cells))
        self.assertEqual(b.cell_value(5,5),o['orderNo']);self.assertEqual(b.cell_value(11,3),20)
        self.assertEqual(b.cell_value(18,5),1000);self.assertEqual(b.cell_value(29,0),a.cell_value(29,0))
        self.assertEqual(b.colinfo_map[1].width,a.colinfo_map[1].width)
        self.assertIn('16,800.00',next(p for p in paths if p.suffix=='.html').read_text())
    def test_06_incomplete_order_progress(self):
        o=s.normalize(self.new_order());o.update(items=[],styleNo='',dataComplete=False,deposit=0,sampleFee=0);s.save_order(o)
        code,result,_=self.req('/api/orders/'+o['id'],{'version':o['version'],'requirements':'確認中'},True,'PUT')
        self.assertEqual(code,200);self.assertFalse(result['dataComplete']);self.assertEqual(result['items'],[])
        self.assertEqual(self.req('/api/orders/'+o['id']+'/pi',{'version':result['version']},True)[0],400)

if __name__=='__main__': unittest.main(verbosity=2)
