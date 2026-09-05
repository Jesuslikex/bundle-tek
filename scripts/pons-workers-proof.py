"""Exercise built Workers routes with local D1, synthetic platform identities, and read-only RPC. No deployment."""
import concurrent.futures,json,os,pathlib,re,socket,sqlite3,subprocess,time,uuid
import requests,psutil
ROOT=pathlib.Path(__file__).resolve().parents[1]
NODE='C:/Program Files/nodejs/node.exe'
RUN=uuid.uuid4().hex
PERSIST=ROOT/'.wrangler'/('pons-proof-'+RUN)
OUT=ROOT/'docs/evidence/pons-workers-proof.json'
E={'scope':'local Workers runtime and real local D1; synthetic trusted-proxy identity headers; no signatures/broadcasts','runId':RUN,'checks':{},'persistDirectory':str(PERSIST)}
OWNED=[]
def start(enabled):
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    with socket.socket() as s:s.bind(('127.0.0.1',0));inspector=s.getsockname()[1]
    logpath=ROOT/'.wrangler'/f'pons-proof-{RUN}-{len(OWNED)}.log';logpath.parent.mkdir(exist_ok=True)
    log=logpath.open('w')
    cmd=[NODE,str(ROOT/'node_modules/wrangler/bin/wrangler.js'),'dev','--config',str(ROOT/'dist/server/wrangler.json'),'--local','--ip','127.0.0.1','--port',str(port),'--inspector-ip','127.0.0.1','--inspector-port',str(inspector),'--persist-to',str(PERSIST),'--show-interactive-dev-session=false','--var','PONS_BACKEND_ENABLED:'+('true' if enabled else 'false')]
    proc=subprocess.Popen(cmd,cwd=ROOT,stdout=log,stderr=log);item=(proc,port,log);OWNED.append(item)
    for _ in range(150):
        if proc.poll() is not None:raise RuntimeError('Owned Wrangler exited: '+logpath.read_text()[-3000:])
        try:
            r=requests.get(f'http://127.0.0.1:{port}/api/pons/jobs/not-a-job',timeout=2)
            if r.status_code==401:return item,f'http://127.0.0.1:{port}'
        except requests.RequestException:pass
        time.sleep(.2)
    raise RuntimeError('Owned Workers readiness failed: '+logpath.read_text()[-3000:])
def stop(item):
    proc,port,log=item
    try:children=psutil.Process(proc.pid).children(recursive=True)
    except psutil.NoSuchProcess:children=[]
    if proc.poll() is None:proc.terminate()
    try:proc.wait(timeout=8)
    except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=8)
    for child in children:
        try:child.terminate()
        except psutil.NoSuchProcess:pass
    _,alive=psutil.wait_procs(children,timeout=5)
    for child in alive:
        try:child.kill()
        except psutil.NoSuchProcess:pass
    psutil.wait_procs(alive,timeout=5);log.close()
    with socket.socket() as s:closed=s.connect_ex(('127.0.0.1',port))!=0
    if not closed:raise RuntimeError('Owned Workers listener was not closed')
    E.setdefault('closedPorts',[]).append(port);OWNED.remove(item)
def main():
    if not __debug__:raise RuntimeError('Assertions required for proof')
    docs=(ROOT/'docs/PONS_BACKEND.md').read_text();match=re.search(r'```json\s*(.*?)```',docs,re.S)
    if not match:raise RuntimeError('No documented intent JSON')
    intent=json.loads(match.group(1));intent['name']='LOCAL WORKERS PROOF';intent['symbol']='LOCALPF';intent['description']='Synthetic saved intent. Not an authorized launch.';intent['salt']='0x'+uuid.uuid4().hex+uuid.uuid4().hex
    owner={'oai-authenticated-user-id':'pons-local-qa-'+RUN,'oai-authenticated-user-email':'local-proof@example.invalid'}
    try:
        item,base=start(False)
        r=requests.post(base+'/api/pons/jobs',headers=owner,json=intent,timeout=10);assert r.status_code==423,r.text;E['checks']['defaultServerLock']=423;stop(item)
        item,base=start(True)
        key='proof-'+RUN
        headers={**owner,'Idempotency-Key':key}
        r=requests.post(base+'/api/pons/jobs',headers=headers,json=intent,timeout=15);assert r.status_code==201,r.text
        job=r.json()['job'];url=base+'/api/pons/jobs/'+job['id'];E['createdJobId']=job['id']
        got=requests.get(url,headers=owner,timeout=15);assert got.status_code==200 and got.json()['job']==job;assert len(got.json()['events'])==1
        E['checks']['createAndReadback']=True
        def repeat(_):return requests.post(base+'/api/pons/jobs',headers=headers,json=intent,timeout=20)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:dupes=list(pool.map(repeat,range(4)))
        assert all(x.status_code==201 and x.json()['job']['id']==job['id'] for x in dupes);assert len(requests.get(url,headers=owner,timeout=15).json()['events'])==1;E['checks']['concurrentIdempotency']=True
        r=requests.post(base+'/api/pons/jobs',headers=headers,json={**intent,'name':'different intent'},timeout=15);assert r.status_code==409,r.text;E['checks']['payloadCollision']=409
        r=requests.get(url,headers={**owner,'oai-authenticated-user-id':'different-owner'},timeout=15);assert r.status_code==404,r.text;E['checks']['ownerIsolation']=404
        r=requests.get(url,timeout=15);assert r.status_code==401,r.text;E['checks']['unauthenticated']=401
        r=requests.post(base+'/api/pons/jobs',headers={**headers,'Origin':'https://attacker.invalid'},json=intent,timeout=15);assert r.status_code==403,r.text;E['checks']['crossOrigin']=403
        r=requests.post(base+'/api/pons/jobs',headers=headers,json={**intent,'mode':'multi-wallet-atomic'},timeout=15);assert r.status_code==400,r.text;E['checks']['unsupportedMultiwalletRejected']=400
        r=requests.post(base+'/api/pons/jobs',headers={**headers,'content-type':'application/json'},data='x'*20000,timeout=15);assert r.status_code==413,r.text;E['checks']['oversizedBody']=413
        r=requests.post(url+'/simulate',headers=owner,json={'revision':job['revision']},timeout=110);assert r.status_code==200,r.text
        simulated=r.json()['job'];assert simulated['state'] in ['simulated','simulation_failed'];assert simulated['revision']==2
        read=requests.get(url,headers=owner,timeout=15).json();assert read['job']==simulated;assert [e['state'] for e in reversed(read['events'])]==['created','simulating',simulated['state']]
        E['checks']['realRpcSimulationAndAuditReadback']=True;E['liveSimulation']=simulated
        r=requests.post(url+'/simulate',headers=owner,json={'revision':0},timeout=15);assert r.status_code==409,r.text;E['checks']['staleRevisionRejected']=409
        if simulated['state']=='simulated':
            r=requests.post(url+'/handoff',headers=owner,json={'revision':2},timeout=110);assert r.status_code==200,r.text
            handed=r.json()['job'];assert handed['revision']==4;E['handoff']=handed
            latest=requests.get(url,headers=owner,timeout=15).json();assert latest['job']==handed
        else:latest=read
        E['savedJob']=latest['job'];E['savedEvents']=latest['events']
        stop(item)
        rows=[]
        for db in PERSIST.rglob('*.sqlite'):
            connection=sqlite3.connect('file:'+db.as_posix()+'?mode=ro',uri=True)
            try:
                if connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='pons_jobs'").fetchone():
                    row=connection.execute('SELECT id,state,revision,intent,result FROM pons_jobs WHERE id=?',(job['id'],)).fetchone()
                    if row:rows.append({'file':str(db),'id':row[0],'state':row[1],'revision':row[2],'intent':json.loads(row[3]),'result':json.loads(row[4]) if row[4] else None})
            finally:connection.close()
        assert len(rows)==1,rows;assert rows[0]['revision']==latest['job']['revision'];assert rows[0]['result']==latest['job']['result'];E['independentSqliteReadback']=rows[0]
        item,base=start(True);restored=requests.get(base+'/api/pons/jobs/'+job['id'],headers=owner,timeout=15);assert restored.status_code==200,restored.text
        restored=restored.json();assert restored['job']['intent']==latest['job']['intent'];assert restored['job']['result']==latest['job']['result'];assert restored['job']['revision']==latest['job']['revision'];assert restored['events']==latest['events'];E['checks']['restartPersistence']=True
        E['status']='passed'
    except Exception as exc:E['status']='failed';E['error']=str(exc);raise
    finally:
        for item in list(OWNED):stop(item)
        OUT.write_text(json.dumps(E,indent=2),encoding='utf-8');print(json.dumps({k:E.get(k) for k in ['status','error','checks','createdJobId','closedPorts']},indent=2))
if __name__=='__main__':main()
