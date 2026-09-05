import {it, expect, vi} from 'vitest';
import {PonsStore} from './store';
import {sample, sqliteD1, fakeClient} from './testing';
import {validateIntent} from './intent';
import {observeReceipt} from './receipt';
import {simulateIntent} from './simulation';
import {handlePons} from './api';
const hash=('0x'+'ab'.repeat(32)) as `0x${string}`;
const bh=('0x'+'cd'.repeat(32)) as `0x${string}`;
const unsigned={chainId:4663,from:sample.wallet,to:sample.wallet,value:'7',data:'0x1234',nonce:8};
const stored={ok:true,maxGasCostWei:'60000000',maxTotalValueWei:'7',unsignedTransaction:unsigned,expiresAt:Date.now()+120000,handoffValidatedAt:Date.now()};
function client(){return {getChainId:vi.fn(async()=>4663),getTransaction:vi.fn(async()=>({...unsigned,value:7n,input:unsigned.data,gas:600000n,gasPrice:100n,hash,blockHash:bh,blockNumber:100n})),getTransactionReceipt:vi.fn(async()=>({transactionHash:hash,from:unsigned.from,to:unsigned.to,blockHash:bh,blockNumber:100n,status:'success'})),getBlock:vi.fn(async()=>({hash:bh,number:112n}))};}
it('delayed claim is rejected after a newer worker takes over',async()=>{
 const raw=sqliteD1();const s=new PonsStore(raw);await s.ensure();const j=await s.create('a','race-review',validateIntent(sample));
 let release!:()=>void;let reached!:()=>void;const paused=new Promise<void>(r=>release=r);const hit=new Promise<void>(r=>reached=r);let intercept=true;
 const wrapped={prepare(query:string){const stmt=raw.prepare(query); if(query.includes("SET state='simulating'")&&intercept){intercept=false;const original=stmt.first.bind(stmt);stmt.first=(async()=>{const result=await original();reached();await paused;return result;}) as typeof stmt.first;}return stmt;},batch:raw.batch.bind(raw)};
 const a=new PonsStore(wrapped as never);const pending=a.claim('a',j.id,0,1000);await hit;
 const b=await s.claim('a',j.id,1,122000);release();
 await expect(pending).rejects.toMatchObject({code:'CLAIM_SUPERSEDED'});
 expect((await s.get('a',j.id)).lease_token).toBe(b.lease_token);
});
it('handoff unusable for all receipt lifecycle states and claim denied',async()=>{
 for(const state of ['submitted','confirming','confirmed','reverted','reorged'] as const){const s=new PonsStore(sqliteD1());await s.ensure();const j=await s.create('a','handoff-review',validateIntent(sample));const c=await s.claim('a',j.id,0);const done=await s.finish('a',j.id,c.revision,c.lease_token!,stored);const r=await s.recordReceipt('a',j.id,done.revision,state,stored);const resp=await handlePons(new Request('https://app.test'),'get',j.id,{owner:async()=> 'a',enabled:true,store:s,simulate:async()=>stored});expect((await resp.json() as {job:{handoff:{usable:boolean}}}).job.handoff.usable).toBe(false);await expect(s.claim('a',j.id,r.revision)).rejects.toMatchObject({status:409});}
});
it('EIP1559 maxFee ceiling enforced rather than low effective gasPrice',async()=>{const c=client();c.getTransaction.mockResolvedValueOnce({...await c.getTransaction(),maxFeePerGas:101n} as never);await expect(observeReceipt(stored,hash,c as never)).rejects.toMatchObject({code:'TRANSACTION_COST_CEILING_EXCEEDED'});});
it('same hash recovers after reorg but fee replacement hash permanently rejected',async()=>{const c=client();const prior=await observeReceipt(stored,hash,c as never);c.getBlock.mockResolvedValueOnce({hash:('0x'+'11'.repeat(32)) as `0x${string}`,number:100n});const reorg=await observeReceipt({...stored,receipt:prior.receipt},hash,c as never);expect(reorg.state).toBe('reorged');const recovered=await observeReceipt({...stored,receipt:reorg.receipt},hash,c as never);expect(recovered.state).toBe('confirmed');await expect(observeReceipt({...stored,receipt:reorg.receipt},('0x'+'12'.repeat(32)) as never,c as never)).rejects.toMatchObject({code:'TRANSACTION_ALREADY_BOUND'});});
it('stale head boundaries and gasPrice envelope fixes verified',async()=>{const now=Date.now();for(const offset of [-61,16]){const c=fakeClient(now);c.getBlock.mockResolvedValue({...await c.getBlock(),timestamp:BigInt(Math.floor(now/1000)+offset)});await expect(simulateIntent(validateIntent(sample),c as never,now)).rejects.toMatchObject({code:'RPC_BLOCK_STALE'});}const c=fakeClient(now);const result=await simulateIntent(validateIntent(sample),c as never,now);expect(result.unsignedTransaction.gasPrice).toBe('100');expect(BigInt(result.unsignedTransaction.gas)*BigInt(result.unsignedTransaction.gasPrice)<=BigInt(result.maxGasCostWei)).toBe(true);});
