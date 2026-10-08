"""Explicit import of existing order folders, never modifies their source files."""
import argparse, re
import server
import xlrd
parser=argparse.ArgumentParser();parser.add_argument('folders',nargs='+');args=parser.parse_args()
for name in args.folders:
    number,code=name.split(' ',1)
    if any(o['orderNo']==number for o in server.all_orders()):
        print(number,'already imported');continue
    folder=server.ROOT/name
    if not folder.is_dir(): raise SystemExit('Missing folder: '+name)
    paths=list(folder.glob('*.xls'))
    data={'orderNo':number,'code':code,'styleNo':'待確認','items':[{'color':'待確認','quantity':1,'unitPrice':0}], 'requirements':'進行中訂單；製作階段與交期待確認。'}
    if paths:
        # Only known invoice templates with the expected headers are accepted.
        path=paths[0];s=xlrd.open_workbook(str(path)).sheet_by_index(0)
        assert s.cell_value(9,2)=='Color' and str(s.cell_value(5,5)).strip()==number
        data['buyer']=s.cell_value(2,0)
        data['styleNo']=str(s.cell_value(10,0)).replace('ITEM:','').strip()
        data['specifications']=s.cell_value(11,1)
        data['printDetails']='\n'.join(str(s.cell_value(r,1)) for r in (17,18) if s.cell_value(r,1))
        data['items']=[{'color':s.cell_value(r,2),'quantity':int(s.cell_value(r,3)),'unitPrice':s.cell_value(r,4)} for r in range(11,17) if isinstance(s.cell_value(r,3),(float,int)) and s.cell_value(r,3)>0]
        data['sampleFee']=sum(s.cell_value(r,5) for r in range(11,17) if not s.cell_value(r,3) and isinstance(s.cell_value(r,5),(int,float)))
        tax=s.cell_value(20,5)
        data['invoiceRequired']=isinstance(tax,(int,float)) and tax>0
        data['taxMode']='excluded' if data['invoiceRequired'] else 'included'
        data['internalNotes']='已由 '+path.name+' 匯入。未有憑據的收款、發票及實際製作階段仍需確認。'
        if not data['invoiceRequired']: data['internalNotes']+=' 原單未列稅金，是否開發票待確認。'
        expected=s.cell_value(22,5)
    o=server.normalize(data)
    o['workflowConfirmed']=False
    if not paths:
        o['items']=[];o['styleNo']='';o['dataComplete']=False
        o['internalNotes']='現有資料夾沒有 PI；款號、顏色、數量、售價及製作階段待確認。'
    else:
        assert abs(server.totals(o)['total']-expected)<.01, (name,server.totals(o),expected)
    o['history']=[{'at':server.now(),'text':'從現有資料夾建立進行中訂單；製作階段待確認'}]
    server.save_order(o)
    print(number,code,'imported',len(o['items']),'lines')
