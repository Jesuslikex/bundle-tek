import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const [mode,destination]=process.argv.slice(2);
if(!['--write','--verify'].includes(mode)||!destination)throw new Error('Use --write or --verify with a snapshot path.');
const output=path.resolve(destination);
if(!output.startsWith(path.join(root,'work','release-qa')+path.sep))throw new Error('Snapshot must stay in work/release-qa.');
const git='C:/Users/Julian/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe';
const files=execFileSync(git,['-C',root,'ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const roots=new Set(['app','components','lib','db','drizzle','scripts','test','hooks','workers','public']);
const configs=new Set(['package.json','package-lock.json','tsconfig.json','vite.config.ts','vitest.config.mjs','drizzle.config.ts','.oxlintrc.json','.oxfmtrc.json','.openai/hosting.json','next.config.ts','wrangler.conditional-monitor.jsonc','wrangler.session-preparation.jsonc']);
const selected=files.filter(file=>(roots.has(file.split('/')[0])||configs.has(file))&&!file.split('/').some(part=>part.startsWith('.env')||/\.(pem|key|p12|pfx)$/i.test(part))).sort();
const hashes=Object.fromEntries(selected.map(file=>[file,createHash('sha256').update(readFileSync(path.join(root,file))).digest('hex')]));
const digest=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
if(mode==='--write'){
 if(existsSync(output))throw new Error('Snapshot already exists; inspect before starting another run.');
 writeFileSync(output,JSON.stringify({root,capturedAt:new Date().toISOString(),files:selected.length,digest,hashes},null,2));
 console.log(JSON.stringify({snapshot:output,files:selected.length,digest}));
}else{
 const frozen=JSON.parse(readFileSync(output,'utf8'));
 if(frozen.root!==root)throw new Error('Snapshot belongs to another checkout.');
 const changed=[...new Set([...Object.keys(frozen.hashes),...Object.keys(hashes)])].filter(file=>frozen.hashes[file]!==hashes[file]);
 console.log(JSON.stringify({unchanged:changed.length===0,files:selected.length,digest,changed}));
 if(changed.length)process.exitCode=1;
}
