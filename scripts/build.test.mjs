import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const scripts=path.dirname(fileURLToPath(import.meta.url));

function root(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'otools-clipboard-build-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;
}
function run(script,...args) {return spawnSync(process.execPath,[path.join(scripts,script),...args],{encoding:'utf8'});}

test('web build refuses missing frontend package and does not copy unrelated sources',t=>{
  const dir=root(t);fs.mkdirSync(path.join(dir,'web'));fs.writeFileSync(path.join(dir,'web/private.txt'),'not assets');
  const result=run('build-web.mjs','--root',dir);assert.notEqual(result.status,0);assert.match(result.stderr,/webPackageMissing/);
  assert.equal(fs.existsSync(path.join(dir,'dist/private.txt')),false);
});

test('native build rejects unknown architecture before invoking cargo or staging output',t=>{
  const dir=root(t);const result=run('build-native.mjs','--root',dir,'--arch','bogus');
  assert.notEqual(result.status,0);assert.match(result.stderr,/unsupportedArchitecture/);assert.equal(fs.existsSync(path.join(dir,'lib')),false);
});

test('native build refuses a missing independent manifest',t=>{
  const dir=root(t);const result=run('build-native.mjs','--root',dir);
  assert.notEqual(result.status,0);assert.match(result.stderr,/nativeManifestMissing/);
});
