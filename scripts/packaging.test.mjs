import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const scripts=path.dirname(fileURLToPath(import.meta.url));
const sourceRoot=path.dirname(scripts);

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'otools-clipboard-pack-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'dist'),{recursive:true});
  fs.mkdirSync(path.join(root,'lib'));
  fs.writeFileSync(path.join(root,'plugin.json'),JSON.stringify({packid:'otools-clipboard',uuid:'otools-clipboard',version:'0.1.0',entry:'dist/index.html',devUrl:'http://127.0.0.1:6549',quickDev:true,native:{enabled:true,autoReload:true,events:['clipboard']}}));
  fs.writeFileSync(path.join(root,'logo.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(root,'dist/index.html'),'<html><body>OTools synthetic build</body></html>');
  return root;
}
function run(script,args=[]) {
  return spawnSync(process.execPath,[path.join(scripts,script),...args],{encoding:'utf8'});
}

// A structurally valid arm64 Mach-O header with no exported code, not a real library.
// It verifies the packer rejects plausible-looking artifacts, not merely empty files.
function fakeMachO() {
  const bytes=Buffer.alloc(64);bytes.writeUInt32LE(0xfeedfacf,0);bytes.writeUInt32LE(0x0100000c,4);bytes.writeUInt32LE(6,12);return bytes;
}

function payloadOf(raw,name) {
  let offset=0;
  while(offset+30<=raw.length&&raw.readUInt32LE(offset)===0x04034b50) {
    const size=raw.readUInt32LE(offset+18),length=raw.readUInt16LE(offset+26),extra=raw.readUInt16LE(offset+28);
    const entryName=raw.toString('utf8',offset+30,offset+30+length);const start=offset+30+length+extra;
    if(entryName===name)return raw.subarray(start,start+size);
    offset=start+size;
  }
  throw new Error(`missing fixture ZIP entry ${name}`);
}

function architectureVariant() {
  const platform=({darwin:'macos',win32:'windows',linux:'linux'})[process.platform];
  const arch=process.arch==='arm64'?'arm64':'x64';
  const source=platform==='macos'?(arch==='arm64'?'macOS-arm64.dylib':'macOS-x86_64.dylib'):platform==='windows'?`Windows-${arch}.dll`:`Linux-${arch}.so`;
  const entry=platform==='macos'?'lib/macOS.dylib':platform==='windows'?'lib/Windows.dll':'lib/Linux.so';
  return {platform,arch,source,entry};
}

function realArtifact(t,root) {
  const variant=architectureVariant();
  const staged=path.join(sourceRoot,'lib',variant.source);
  const cargoName=process.platform==='darwin'?'libotools_clipboard_native.dylib':process.platform==='win32'?'otools_clipboard_native.dll':'libotools_clipboard_native.so';
  const cargo=path.join(sourceRoot,'native/target/release',cargoName);
  const actual=fs.existsSync(staged)?staged:cargo;
  if(!fs.existsSync(actual)) {t.skip('Build the actual native release before artifact tests');return null;}
  fs.copyFileSync(actual,path.join(root,'lib',variant.source));return variant;
}

function pack(root,variant) {return run('pack-plugin.mjs',['--root',root,'--platform',variant.platform,'--arch',variant.arch]);}

function verifiedArchive(result) {
  assert.equal(result.status,0,result.stderr);
  const meta=JSON.parse(result.stdout.trim().split('\n').at(-1));
  return {meta,raw:fs.readFileSync(meta.output)};
}

test('production pack rejects missing native library and leaves no partial package',t=>{
  const root=fixture(t),variant=architectureVariant();const result=pack(root,variant);
  assert.notEqual(result.status,0);assert.match(result.stderr,/nativeArtifactMissing/);
  assert.equal(fs.existsSync(path.join(root,'dist-pack')),false);
});

test('production pack rejects fake native artifacts with a plausible binary header',t=>{
  const root=fixture(t),variant=architectureVariant();fs.writeFileSync(path.join(root,'lib',variant.source),fakeMachO());
  const result=pack(root,variant);assert.notEqual(result.status,0);assert.match(result.stderr,/nativeExportMissing|nativeArtifactInvalid/);
});

test('production pack strips developer fields and contains exactly its native platform',t=>{
  const root=fixture(t),variant=realArtifact(t,root);if(!variant)return;
  const {meta,raw}=verifiedArchive(pack(root,variant));
  const manifest=JSON.parse(payloadOf(raw,'plugin.json'));
  assert.equal(Object.hasOwn(manifest,'devUrl'),false);assert.equal(Object.hasOwn(manifest,'quickDev'),false);
  assert.equal(manifest.native.autoReload,false);assert.deepEqual(manifest.native.events,['clipboard']);
  assert.deepEqual(meta.nativeLibs,[variant.entry]);
  assert.equal(payloadOf(raw,variant.entry).length,fs.statSync(path.join(root,'lib',variant.source)).size);
  const result=run('verify-plugin.mjs',[path.dirname(meta.output)]);assert.equal(result.status,0,result.stderr);
});

test('pack rejects escaping entry paths and symlinked build files before writing an output',t=>{
  const root=fixture(t),variant=realArtifact(t,root);if(!variant)return;
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'plugin.json')));manifest.entry='dist/../private';fs.writeFileSync(path.join(root,'plugin.json'),JSON.stringify(manifest));
  assert.match(pack(root,variant).stderr,/invalidEntry/);
  manifest.entry='dist/index.html';fs.writeFileSync(path.join(root,'plugin.json'),JSON.stringify(manifest));
  fs.symlinkSync(path.join(root,'plugin.json'),path.join(root,'dist/linked.json'));
  assert.match(pack(root,variant).stderr,/symlinkNotAllowed/);
});

test('ZIP verifier rejects traversal and duplicate names without extracting anything',async()=>{
  const {encodeZip,readZip}=await import('./archive.mjs');
  assert.throws(()=>readZip(encodeZip([{name:'../private',data:Buffer.from('secret')}])) ,/invalidArchivePath/);
  assert.throws(()=>readZip(encodeZip([{name:'dist/index.html',data:Buffer.from('one')},{name:'dist/index.html',data:Buffer.from('two')}])) ,/duplicateArchiveEntry/);
});

test('ZIP verifier detects CRC corruption instead of executing or trusting payloads',async()=>{
  const {encodeZip,readZip}=await import('./archive.mjs');
  const raw=encodeZip([{name:'dist/index.html',data:Buffer.from('unaltered')}]);
  raw[30+'dist/index.html'.length]^=1;
  assert.throws(()=>readZip(raw),/archiveCrcMismatch/);
});

test('package verifier compares the packaged manifest with the checksum-covered sidecar',t=>{
  const root=fixture(t),variant=realArtifact(t,root);if(!variant)return;
  const {meta}=verifiedArchive(pack(root,variant));
  const directory=path.dirname(meta.output),file=path.join(directory,'plugin.json');
  const manifest=JSON.parse(fs.readFileSync(file));manifest.uuid='wrong-identity';fs.writeFileSync(file,JSON.stringify(manifest));
  const result=run('verify-plugin.mjs',[directory]);assert.notEqual(result.status,0);assert.match(result.stderr,/checksumMismatch/);
});

test('package verifier rejects a checksum-consistent non-native binary payload',async t=>{
  const root=fixture(t),variant=realArtifact(t,root);if(!variant)return;
  const {meta,raw}=verifiedArchive(pack(root,variant)),{encodeZip,readZip}=await import('./archive.mjs');
  const entries=readZip(raw).map(entry=>entry.name===variant.entry?{...entry,data:Buffer.alloc(256,65)}:entry);
  fs.writeFileSync(meta.output,encodeZip(entries));
  const directory=path.dirname(meta.output),names=[path.basename(meta.output),'plugin.json','logo.svg'];
  fs.writeFileSync(path.join(directory,'SHA256SUMS'),names.map(name=>`${createHash('sha256').update(fs.readFileSync(path.join(directory,name))).digest('hex')}  ${name}`).join('\n')+'\n');
  const result=run('verify-plugin.mjs',[directory]);assert.notEqual(result.status,0);assert.match(result.stderr,/nativeArtifactInvalid/);
});

test('native export verifier accepts real compiled invoke/free/on_event',t=>{
  const root=fixture(t),variant=realArtifact(t,root);if(!variant)return;
  const result=run('verify-native.mjs',[path.join(root,'lib',variant.source),'--platform',variant.platform,'--arch',variant.arch]);
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/otools_plugin_on_event/);
});
