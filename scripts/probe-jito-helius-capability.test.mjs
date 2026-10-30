import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Runs the real recorder with a closed fake transport; never loads .env files.
for (const scenario of [
  'default',
  'discover',
  'bank-missing',
  '429',
  'slot-mismatch',
  'over-window',
]) {
  test(`Helius recorder: ${scenario}`, async () => {
    const folder = await mkdtemp(resolve('work/helius-recorder-test-'));
    const mock = resolve(folder, 'mock.mjs');
    await writeFile(
      mock,
      `
      import assert from 'node:assert/strict';
      let calls=0;
      globalThis.fetch=async(endpoint, init)=>{
        assert.equal(endpoint,'https://mainnet.helius-rpc.com/?api-key=synthetic');
        assert.equal(init.redirect,'error');
        const q=JSON.parse(init.body); calls++;
        let result;
        if(q.method==='getGenesisHash') result='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
        else if(q.method==='getLatestBlockhash') result={context:{slot:100},value:{blockhash:'11111111111111111111111111111111',lastValidBlockHeight:999}};
        else if(q.method==='simulateBundle') {
          assert.equal(q.params[1].replaceRecentBlockhash,false);
          assert.equal(q.params[1].skipSigVerify,true);
          for(const p of q.params[0].encodedTransactions) assert.ok(Buffer.from(p,'base64').subarray(1,65).every(x=>x===0));
          if(${JSON.stringify(scenario)}==='default') assert.deepEqual(q.params[1].simulationBank,{slot:100});
          else if(calls===3) assert.deepEqual(q.params[1].simulationBank,{commitment:{commitment:'confirmed'}});
          else assert.deepEqual(q.params[1].simulationBank,{slot:101});
          if(${JSON.stringify(scenario)}==='429') return new Response('',{status:429});
          if(${JSON.stringify(scenario)}==='bank-missing') return Response.json({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:'bank not found for the provided slot: 100'}});
          const slot=${JSON.stringify(scenario)}==='over-window'?133:${JSON.stringify(scenario)}==='default'?100:${JSON.stringify(scenario)}==='slot-mismatch'&&calls===4?102:101;
          result={context:{slot},value:{summary:'succeeded',transactionResults:[0,1].map(()=>({err:null,fee:5000,preExecutionAccounts:Array(5).fill(null),postExecutionAccounts:Array(5).fill(null)}))}};
        } else if(q.method==='getFeeForMessage') result={context:{slot:102},value:5000};
        else if(q.method==='getSlot') result=103;
        else throw Error('Unexpected method');
        return Response.json({jsonrpc:'2.0',id:q.id,result});
      };
    `,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(mock).href,
        'scripts/probe-jito-helius-capability.mjs',
        '--live-readonly',
        ...(scenario === 'default' ? [] : ['--simulator-bank']),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          SOLANA_MAINNET_RPC_URL:
            'https://mainnet.helius-rpc.com/?api-key=synthetic',
          SOLANA_RPC_MIN_INTERVAL_MS: '1',
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    const successful = ['default', 'discover'].includes(scenario);
    assert.equal(
      summary.status,
      successful
        ? 'requested-native-vectors-observed-not-qualified'
        : 'refused',
    );
    assert.equal(
      summary.calls,
      scenario === 'default'
        ? 6
        : scenario === 'discover'
          ? 7
          : scenario === 'slot-mismatch'
            ? 4
            : 3,
    );
    for (const key of [
      'bankVerified',
      'feeBankVerified',
      'fullSwapQualified',
      'signingAllowed',
      'executionAllowed',
    ])
      assert.equal(summary[key], false);
    const receipt = JSON.parse(await readFile(summary.receipt, 'utf8'));
    assert.ok(
      receipt.captures.every(
        (c) => !/sendTransaction|sendBundle/.test(c.method),
      ),
    );
    if (scenario === '429') assert.equal(summary.rateLimited, true);
    if (scenario === 'discover') {
      const first = JSON.parse(receipt.captures[2].request);
      const second = JSON.parse(receipt.captures[3].request);
      assert.deepEqual(first.params[0], second.params[0]);
      assert.deepEqual(
        first.params[1].preExecutionAccountsConfigs,
        second.params[1].preExecutionAccountsConfigs,
      );
      assert.equal(summary.floor, 100);
    }
  });
}
