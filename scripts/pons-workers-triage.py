import importlib.util,pathlib,json,re,requests,sys
r=pathlib.Path(__file__).resolve().parents[1];spec=importlib.util.spec_from_file_location('proof',r/'scripts/pons-workers-proof.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
intent=json.loads(re.search(r'```json\s*(.*?)```',(r/'docs/PONS_BACKEND.md').read_text(),re.S).group(1));owner={'oai-authenticated-user-id':'triage-local-only','oai-authenticated-user-email':'triage@example.invalid','Idempotency-Key':'triage-case'}
if not __debug__:raise RuntimeError('Assertions required for triage')
item=None
try:
 item,base=p.start(True);url=base+'/api/pons/jobs'
 cases=[('badmode',dict(headers=owner,json={**intent,'mode':'multi-wallet-atomic'})),('crossorigin',dict(headers={**owner,'Origin':'https://attacker.invalid'},json=intent)),('badmode-after-cross',dict(headers=owner,json={**intent,'mode':'multi-wallet-atomic'})),('oversize',dict(headers={**owner,'content-type':'application/json'},data='x'*20000)),('badmode-after-large',dict(headers=owner,json={**intent,'mode':'multi-wallet-atomic'})),('invalidjson',dict(headers={**owner,'content-type':'application/json'},data='{')),('valid',dict(headers=owner,json=intent))]
 # Opt-in regression: a 100 KiB rejected upload must be fully discarded so
 # the immediate next service.fetch remains healthy. Do not hide with retries.
 if '--over-budget' in sys.argv:
  cases.append(('over-cleanup-budget',dict(headers={**owner,'content-type':'application/json'},data='x'*100000)))
 for label,args in cases:
  response=requests.post(url,timeout=20,**args);print(label,response.status_code,response.text[:250],flush=True)
  expected={'badmode':400,'crossorigin':403,'badmode-after-cross':400,'oversize':413,'badmode-after-large':400,'invalidjson':400,'valid':201,'over-cleanup-budget':413}[label]
  assert response.status_code==expected,(label,response.status_code,response.text)
  health=requests.get(base+'/api/pons/jobs/not-a-job',timeout=10);print('health',health.status_code,health.text[:100],flush=True)
  assert health.status_code==401,(label,health.status_code,health.text)
  assert health.json()=={'error':'AUTH_REQUIRED'},(label,health.text)
 print('PASS: every rejection and immediate follow-up response; no retries',flush=True)
finally:
 if item:p.stop(item)
