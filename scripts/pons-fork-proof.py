"""LOCAL ONLY Pons proof. uv run --with requests --with eth-abi --with pycryptodome scripts/pons-fork-proof.py --anvil PATH [--block N]
No private keys. Upstream RPC is protected by a read-only allowlisting proxy.
"""
import argparse,json,time,socket,subprocess,threading,pathlib,hashlib,traceback
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
if not __debug__: raise RuntimeError('Proof requires enabled assertions; do not use python -O')
import requests
from eth_abi import encode,decode
from Crypto.Hash import keccak
RPC='https://rpc.mainnet.chain.robinhood.com'
FACTORY='0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'
ROUTER='0xe33E9E479dF8802cb0866d5d05258bEc4cF62948'
USER='0x4EAb299482FC2a4606626B56601718F2a346C49F'
ZERO='0x'+'00'*20
READ={'eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getCode','eth_getStorageAt','eth_getBalance','eth_getTransactionCount','eth_call','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getLogs','eth_gasPrice','eth_getProof','net_version','web3_clientVersion'}
E={'scope':'synthetic local fork only; artificial balance; no signatures or mainnet writes','upstream_methods':{},'status':'running'}
def kh(b): return keccak.new(digest_bits=256,data=b).digest()
def data(sig,types=(),args=()): return '0x'+(kh(sig.encode())[:4]+encode(types,args)).hex()
def upstream(payload):
    for p in payload if isinstance(payload,list) else [payload]:
        assert p['method'] in READ, 'UPSTREAM WRITE REFUSED'
        m=p['method'];E['upstream_methods'][m]=E['upstream_methods'].get(m,0)+1
    r=requests.post(RPC,json=payload,timeout=90);r.raise_for_status();return r.json()
def rpc(url,m,p=()):
    payload={'jsonrpc':'2.0','id':1,'method':m,'params':list(p)}
    j=upstream(payload) if url==RPC else requests.post(url,json=payload,timeout=120).json()
    if 'error' in j: raise RuntimeError(json.dumps(j['error']))
    return j['result']
def call(url,to,sig,types=(),args=(),out=('uint256',),block='latest'):
    return decode(out,bytes.fromhex(rpc(url,'eth_call',[{'to':to,'data':data(sig,types,args)},block])[2:]))
class Proxy(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            obj=upstream(json.loads(self.rfile.read(int(self.headers['Content-Length']))));b=json.dumps(obj).encode();self.send_response(200);self.end_headers();self.wfile.write(b)
        except Exception as e:
            self.send_response(502);self.end_headers();self.wfile.write(str(e).encode())
    def log_message(self,*a): pass
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--anvil',required=True);ap.add_argument('--block',type=int);args=ap.parse_args()
    output=pathlib.Path(__file__).resolve().parents[1]/'docs/evidence/pons-fork-proof.json'
    proc=None;proxy=None;log=None
    try:
        doc=requests.get('https://docs.ponsfamily.com/v2',timeout=40);doc.raise_for_status()
        assert 'launchAndBuy' in doc.text and FACTORY.lower() in doc.text.lower()
        E['docs']={'url':doc.url,'sha256':hashlib.sha256(doc.content).hexdigest()}
        E['anvil_binary_sha256']=hashlib.sha256(pathlib.Path(args.anvil).read_bytes()).hexdigest()
        E['anvil_version']=subprocess.check_output([args.anvil,'--version'],text=True)
        assert int(rpc(RPC,'eth_chainId'),16)==4663
        block=args.block or int(rpc(RPC,'eth_blockNumber'),16);tag=hex(block)
        E['pinned_block']=rpc(RPC,'eth_getBlockByNumber',[tag,False]);E['source_rpc']=RPC
        E['bytecode']={}
        for address in [FACTORY,ROUTER]:
            code=rpc(RPC,'eth_getCode',[address,tag]);assert len(code)>2
            E['bytecode'][address]={'bytes':len(bytes.fromhex(code[2:])),'keccak256':'0x'+kh(bytes.fromhex(code[2:])).hex()}
        E['canLaunch']=call(RPC,FACTORY,'canLaunch(address)',['address'],[USER],['bool'],tag)[0];assert E['canLaunch'],'No bypass of eligibility'
        count=call(RPC,FACTORY,'launchConfigCount()',block=tag)[0]
        configs=[call(RPC,FACTORY,'getLaunchConfig(uint256)',['uint256'],[i],['uint256','uint256','uint256','uint256','uint24','int24','bool'],tag) for i in range(count)]
        E['configs']=configs;cid=next(i for i,c in enumerate(configs) if c[-1]);E['config_id']=cid
        fee=call(RPC,FACTORY,'launchFee()',block=tag)[0]
        economics=call(RPC,FACTORY,'previewLaunchEconomics(uint256,address)',['uint256','address'],[cid,ZERO],['bytes32'],tag)[0]
        E['launch_fee_wei']=fee;E['economics']='0x'+economics.hex()
        proxy=ThreadingHTTPServer(('127.0.0.1',0),Proxy);threading.Thread(target=proxy.serve_forever,daemon=True).start()
        with socket.socket() as s: s.bind(('127.0.0.1',0));port=s.getsockname()[1]
        local=f'http://127.0.0.1:{port}';E['local_rpc']=local
        command=[args.anvil,'--host','127.0.0.1','--port',str(port),'--chain-id','31337','--fork-url',f'http://127.0.0.1:{proxy.server_port}','--fork-block-number',str(block),'--accounts','0','--hardfork','cancun','--no-storage-caching','--silent']
        log=open(pathlib.Path(args.anvil).parent/'pons-anvil.log','w');proc=subprocess.Popen(command,stdout=log,stderr=log);E['owned_anvil_pid']=proc.pid
        for _ in range(120):
            if proc.poll() is not None: raise RuntimeError('Anvil exited; see scratch pons-anvil.log')
            try:
                chain=rpc(local,'eth_chainId');version=rpc(local,'web3_clientVersion');break
            except requests.RequestException: time.sleep(.5)
        assert int(chain,16)==31337 and 'anvil' in version.lower()
        E['local_identity']={'chainId':chain,'clientVersion':version}
        def mutate(m,p):
            assert int(rpc(local,'eth_chainId'),16)==31337 and 'anvil' in rpc(local,'web3_clientVersion').lower()
            return rpc(local,m,p)
        mutate('evm_mine',[]);E['local_environment_note']='Mined empty local Cancun block to populate blob environment absent from Robinhood header; deployed code/storage unchanged.'
        mutate('anvil_impersonateAccount',[USER]);mutate('anvil_setBalance',[USER,hex(100*10**18)])
        assert int(rpc(local,'eth_getBalance',[USER,'latest']),16)==100*10**18
        typ='(string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32)'
        sig=f'launchAndBuy({typ},uint256,address,uint256,uint256,address,address[])'
        quote=10**15
        def tx(salt,minout):
            params=('LOCAL FORK PROOF ONLY','LOCALTEST','https://example.invalid/local-only.png','Synthetic isolated fork test. Not a real launch.',('','','','',''),USER,0,False,economics,salt)
            return {'from':USER,'to':ROUTER,'data':data(sig,[typ,'uint256','address','uint256','uint256','address','address[]'],[params,cid,ZERO,quote,minout,USER,[]]),'value':hex(fee+quote),'gas':hex(15000000)}
        salt=kh(f'local-pons-proof-{block}'.encode());good=tx(salt,1)
        returned=decode(['address','address','uint256'],bytes.fromhex(rpc(local,'eth_call',[good,'latest'])[2:]));token,curve,amount=returned
        E['simulation_return']={'token':token,'curve':curve,'tokensOut':amount};assert amount>0
        def send(t):
            h=mutate('eth_sendTransaction',[t])
            for _ in range(120):
                receipt=rpc(local,'eth_getTransactionReceipt',[h])
                if receipt: return receipt
                time.sleep(.25)
            raise RuntimeError('receipt timeout')
        E['success_transaction_request']=good
        receipt=send(good);E['success_receipt']=receipt;assert int(receipt['status'],16)==1
        launch_topic='0x'+kh(b'TokenLaunched(address,address,address,address,uint256,uint256)').hex()
        buy_topic='0x'+kh(b'CurveBuy(address,address,uint256,uint256,uint256,uint256)').hex()
        launches=[l for l in receipt['logs'] if l['topics'][0]==launch_topic];buys=[l for l in receipt['logs'] if l['topics'][0]==buy_topic]
        assert len(launches)==len(buys)==1
        assert launches[0]['topics'][1][-40:]==token[2:] and launches[0]['topics'][2][-40:]==curve[2:]
        assert launches[0]['topics'][3][-40:].lower()==USER[2:].lower()
        buy=decode(['uint256']*4,bytes.fromhex(buys[0]['data'][2:]));assert buy[1]==amount
        assert buys[0]['topics'][2][-40:].lower()==USER[2:].lower()
        supply=call(local,token,'totalSupply()')[0];balance=call(local,token,'balanceOf(address)',['address'],[USER])[0];cb=call(local,token,'balanceOf(address)',['address'],[curve])[0]
        assert supply==configs[cid][0] and balance==amount and cb+balance==supply
        recordtypes=['address']*5+['uint256','uint24','int24','uint16','bool','uint8','uint256','uint256','uint256','bool']
        record=call(local,FACTORY,'getLaunchedToken(address)',['address'],[token],recordtypes)
        assert record[2].lower()==USER.lower() and record[3].lower()==USER.lower() and record[-1]
        snipe=call(local,curve,'currentSnipeTaxBps(address)',['address'],[USER])[0];assert snipe==0
        assert buy[2]==quote*configs[cid][1]//10000 and buy[3]==0
        E['verified']={'supply':supply,'recipient_balance':balance,'curve_balance':cb,'factory_record':record,'buy_event':buy,'recipient_snipe_tax_bps':snipe,'single_recipient_atomic':True}
        badsalt=kh(salt+b'revert');baseline=tx(badsalt,1)
        bt,bc,_=decode(['address','address','uint256'],bytes.fromhex(rpc(local,'eth_call',[baseline,'latest'])[2:]))
        targets=[FACTORY,ROUTER,curve,bt,bc]
        before={a:rpc(local,'eth_getBalance',[a,'latest']) for a in targets}
        bad=tx(badsalt,2**256-1)
        try: rpc(local,'eth_call',[bad,'latest']);raise AssertionError('impossible minimum did not revert')
        except RuntimeError as exc: E['revert_simulation_error']=str(exc)
        E['revert_transaction_request']=bad
        user_before=int(rpc(local,'eth_getBalance',[USER,'latest']),16)
        failed=send(bad);E['revert_receipt']=failed;assert int(failed['status'],16)==0 and not failed['logs']
        user_after=int(rpc(local,'eth_getBalance',[USER,'latest']),16)
        assert user_before-user_after==int(failed['gasUsed'],16)*int(failed['effectiveGasPrice'],16)
        E['reverted_user_value_refunded']=True
        assert rpc(local,'eth_getCode',[bt,'latest'])=='0x' and rpc(local,'eth_getCode',[bc,'latest'])=='0x'
        absent=call(local,FACTORY,'getLaunchedToken(address)',['address'],[bt],recordtypes);assert not absent[-1]
        after={a:rpc(local,'eth_getBalance',[a,'latest']) for a in targets};assert before==after
        assert call(local,token,'balanceOf(address)',['address'],[USER])[0]==balance
        E['atomic_revert']={'predicted_token':bt,'predicted_curve':bc,'no_code':True,'no_registry_entry':True,'no_logs':True,'contract_balances_unchanged':True,'existing_token_balance_unchanged':True}
        E['multiwallet']='Not supported/proven by this single-recipient router call; exemption list is not a multiwallet purchase bundle. No gate bypass attempted.'
        E['status']='passed'
    except Exception as exc:
        E['status']='blocked_or_failed';E['error']=str(exc);E['traceback']=traceback.format_exc()
    finally:
        if proc is not None:
            proc.terminate();proc.wait(timeout=15);E['owned_anvil_stopped']=proc.poll() is not None
            with socket.socket() as probe: E['local_port_closed']=probe.connect_ex(('127.0.0.1',port))!=0
        if proxy is not None: proxy.shutdown();proxy.server_close()
        if log: log.close()
        output.write_text(json.dumps(E,indent=2),encoding='utf8')
        print(json.dumps({k:v for k,v in E.items() if k in ['status','error','simulation_return','atomic_revert','owned_anvil_stopped']},indent=2))
    return 0 if E['status']=='passed' else 1
if __name__=='__main__': raise SystemExit(main())
