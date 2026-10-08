"""One-time local configuration; all private values stay in ignored data/."""
import argparse, hashlib, json, secrets, sys
from pathlib import Path
BASE=Path(__file__).resolve().parent
sys.path.insert(0,str(BASE/'.vendor'))
parser=argparse.ArgumentParser()
parser.add_argument('--orders-root',required=True)
parser.add_argument('--template',required=True)
args=parser.parse_args()
data=BASE/'data';data.mkdir(exist_ok=True)
config_path=data/'config.json'
config=json.loads(config_path.read_text()) if config_path.exists() else {}
config['ordersRoot']=str(Path(args.orders_root).resolve())
config['piTemplate']=str(Path(args.template).resolve())
import xlrd
s=xlrd.open_workbook(args.template).sheet_by_index(0)
config['seller']=s.cell_value(25,1)
config['piTerms']=s.cell_value(27,0)+'\n\n'+s.cell_value(29,0)
if 'auth' not in config:
    password=secrets.token_urlsafe(15);salt=secrets.token_bytes(16)
    config['auth']={'salt':salt.hex(),'hash':hashlib.scrypt(password.encode(),salt=salt,n=16384,r=8,p=1).hex()}
    access=data/'本機登入資訊.txt'
    access.write_text(f'Re:Nrob Lab 本機內部管理\n\n網址：http://127.0.0.1:8765\n初始管理密碼：{password}\n\n公開進度：http://127.0.0.1:8765/factory\n登入後可在工作空間設定中變更密碼。\n',encoding='utf-8');access.chmod(0o600)
config_path.write_text(json.dumps(config,ensure_ascii=False,indent=2));config_path.chmod(0o600)
print('Local configuration is ready. Login details are in data/本機登入資訊.txt.')
