"""Verify production TS planner using a guarded local Anvil fork. No mainnet write path."""
import argparse,importlib.util,json,os,pathlib,socket,subprocess,threading,time,hashlib
if not __debug__: raise RuntimeError('Proof requires enabled assertions')
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('protocol_proof',ROOT/'scripts/pons-fork-proof.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--anvil',default='C:/Users/Julian/AppData/Local/Temp/pons-fork-tools/anvil.exe');ap.add_argument('--block',type=int);a=ap.parse_args()
    if a.block is None:a.block=int(p.rpc(p.RPC,'eth_blockNumber'),16)
    expected=json.loads((ROOT/'docs/evidence/pons-fork-proof-install.json').read_text())['anvil_binary_sha256']
    if hashlib.sha256(pathlib.Path(a.anvil).read_bytes()).hexdigest()!=expected: raise RuntimeError('Unverified Anvil binary')
    proxy=p.ThreadingHTTPServer(('127.0.0.1',0),p.Proxy);threading.Thread(target=proxy.serve_forever,daemon=True).start()
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    local=f'http://127.0.0.1:{port}';proc=None
    evidence={'scope':'local fork only, read-allowlisted upstream proxy','sourceBlock':a.block,'localRpc':local}
    try:
        logpath=pathlib.Path(a.anvil).parent/'pons-backend-anvil.log'
        with logpath.open('w') as log:
            proc=subprocess.Popen([a.anvil,'--host','127.0.0.1','--port',str(port),'--chain-id','4663','--fork-url',f'http://127.0.0.1:{proxy.server_port}','--fork-block-number',str(a.block),'--accounts','0','--hardfork','cancun','--no-storage-caching','--silent'],stdout=log,stderr=log)
            for _ in range(120):
                if proc.poll() is not None:raise RuntimeError('Anvil exited; inspect scratch log')
                try:
                    chain=p.rpc(local,'eth_chainId');version=p.rpc(local,'web3_clientVersion');break
                except p.requests.RequestException:time.sleep(.5)
            def mutate(m,args):
                if int(p.rpc(local,'eth_chainId'),16)!=4663 or 'anvil' not in p.rpc(local,'web3_clientVersion').lower():raise RuntimeError('Not local Anvil')
                if m not in {'evm_mine','anvil_impersonateAccount','anvil_setBalance'}:raise RuntimeError('Unsupported proof mutation')
                return p.rpc(local,m,args)
            mutate('evm_mine',[]);mutate('anvil_impersonateAccount',[p.USER]);mutate('anvil_setBalance',[p.USER,hex(100*10**18)])
            env=os.environ.copy();env['PONS_PROOF_LOCAL_RPC']=local;env['PONS_PROOF_BLOCK']=str(a.block)
            result=subprocess.run(['C:/Program Files/nodejs/node.exe',str(ROOT/'node_modules/vitest/vitest.mjs'),'run','--config','scripts/pons-fork-vitest.config.mjs'],cwd=ROOT,env=env,text=True,capture_output=True,timeout=250)
            print(result.stdout);print(result.stderr);evidence['exitCode']=result.returncode
            return result.returncode
    except Exception as exc:
        evidence['error']=str(exc);evidence['exitCode']=1;raise
    finally:
        if proc is not None:
            proc.terminate();proc.wait(timeout=15);evidence['ownedAnvilStopped']=proc.poll() is not None
            with socket.socket() as s:evidence['localPortClosed']=s.connect_ex(('127.0.0.1',port))!=0
        proxy.shutdown();proxy.server_close();evidence['upstreamMethods']=p.E['upstream_methods']
        (ROOT/'docs/evidence/pons-backend-fork-supervisor.json').write_text(json.dumps(evidence,indent=2))
if __name__=='__main__':raise SystemExit(main())
