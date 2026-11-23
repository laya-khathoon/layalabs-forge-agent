const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'forge-security-'));
 const root=path.join(dir,'workspace');fs.mkdirSync(root);fs.mkdirSync(root+'-private');
 fs.writeFileSync(path.join(root,'note.txt'),'safe text');fs.writeFileSync(path.join(root+'-private','secret.txt'),'not readable');
 fs.writeFileSync(path.join(root,'.env'),'not readable');fs.symlinkSync(path.join(root,'.env'),path.join(root,'env-alias'));fs.symlinkSync(root+'-private',path.join(root,'escape'));
 const port=18793;
 const proc=spawn(process.execPath,['out/mcpServer.js','--http',String(port)],{env:{...process.env,FORGE_WORKSPACE_ROOT:root,FORGE_ALLOW_COMMANDS:''},stdio:['ignore','pipe','pipe']});
 try {
  await new Promise((resolve,reject)=>{proc.stderr.once('data',resolve);proc.once('error',reject);setTimeout(()=>reject(Error('server did not start')),5000).unref()});
  const url=`http://127.0.0.1:${port}/mcp`;
  const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
  const call=async(name,args)=>{const r=await fetch(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});const t=await r.text();return JSON.parse(t.split('\n').find(l=>l.startsWith('data: ')).slice(6)).result;};
  assert.match(JSON.stringify(await call('read_file',{path:'note.txt'})),/safe text/);
  for(const p of ['../workspace-private/secret.txt','escape/secret.txt','.env','env-alias']) assert.equal((await call('read_file',{path:p})).isError,true,p);
  assert.match(JSON.stringify(await call('run_command',{command:'echo should-not-run'})),/Shell commands are disabled/);
  assert.equal((await fetch(url,{headers:{Origin:'https://example.invalid'}})).status,403);
  assert.equal(await new Promise(resolve=>{require("node:http").get(url,{headers:{Host:`attacker.invalid:${port}`}},r=>{r.resume();resolve(r.statusCode)})}),403);
  assert.equal((await call('propose_write',{path:'new.txt',content:'hello'})).isError,undefined);
  assert.equal(fs.existsSync(path.join(root,'new.txt')),false);
  console.log('PASS: valid reads, sibling traversal, symlinks, env files, shell default, Origin/Host checks, write proposal remains read-only');
 } finally {proc.kill();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
