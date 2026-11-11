import test from 'node:test';
import assert from 'node:assert/strict';
import {compareVersions,validateManifest,createUpdater,APP_ID,classifyUpdateError,readPublicRelease} from '../src/updates.js';
const manifest={schemaVersion:1,appId:APP_ID,version:'0.1.1',minNativeVersion:'0.1.0',nativeRuntime:1,bundle:{url:'https://github.com/troglobiont/the-trail-clients/releases/download/v0.1.1/THE-TRAIL-Clients-update.zip',sha256:'a'.repeat(64)}};
function fixture(overrides={}){const calls=[];const bridge={native:true,async readRelease(){return {manifest:JSON.stringify(manifest),assetId:123,tag:'v0.1.1'};},async info(){return {nativeVersion:'0.1.0',runtime:1};},async downloadUpdate(m,progress){calls.push('download');progress(70);return {id:'bundle-1',version:m.version,checksum:m.bundle.sha256};},async applyUpdate(){calls.push('apply');},...overrides};const updater=createUpdater({version:'0.1.0',bridge,flush:async()=>{calls.push('save');}});return {updater,calls};}
test('versions compare numerically; foreign ID and URL rejected',()=>{assert.equal(compareVersions('0.10.0','0.9.0'),1);assert.throws(()=>validateManifest({...manifest,appId:'other'}));assert.throws(()=>validateManifest({...manifest,bundle:{...manifest.bundle,url:'https://evil.test/update.zip'}}));});
test('only inspect never installs; update saves before download and before apply',async()=>{const {updater,calls}=fixture();await updater.check();assert.equal(updater.state().status,'available');assert.deepEqual(calls,['save']);calls.length=0;await updater.update();assert.deepEqual(calls,['save','download','save','apply']);assert.equal(updater.state().status,'applying');});
test('incompatible native runtime never downloads or applies',async()=>{const {updater,calls}=fixture({async info(){return {nativeVersion:'0.1.0',runtime:2};}});await updater.update();assert.equal(updater.state().error,'native-required');assert.deepEqual(calls,['save']);});
test('checksum mismatch preserves current application',async()=>{const {updater,calls}=fixture({async downloadUpdate(){return {id:'bad',version:'0.1.1',checksum:'b'.repeat(64)};}});await updater.update();assert.equal(updater.state().error,'checksum');assert.ok(!calls.includes('apply'));});
test('double update calls use a single in-flight operation',async()=>{const {updater,calls}=fixture();await Promise.all([updater.update(),updater.update()]);assert.equal(calls.filter(c=>c==='apply').length,1);});
test('clicking update during background checking still downloads and applies',async()=>{const {updater,calls}=fixture();await Promise.all([updater.check(),updater.update(),updater.update()]);assert.equal(calls.filter(c=>c==='download').length,1);assert.equal(calls.filter(c=>c==='apply').length,1);assert.equal(updater.state().status,'applying');});
test('private repository access error is explicit, no false success',async()=>{const {updater,calls}=fixture({async readRelease(){throw Error('github-auth');}});await updater.update();assert.equal(updater.state().status,'error');assert.equal(updater.state().error,'github-auth');assert.ok(!calls.includes('download'));});
test('asset ID bridge error identifies archive stage instead of claiming internet failure',async()=>{const {updater,calls}=fixture({async downloadUpdate(){throw Error('update-asset-id');}});await updater.update();assert.equal(updater.state().error,'asset-id');assert.equal(updater.state().step,'download');assert.ok(!calls.includes('apply'));});
test('disk, GitHub limits, TLS, and timeout failures remain distinct',()=>{
  for(const [text,expected] of [['update-rate-limit','rate-limit'],['update-asset-http-404','release-missing'],['update-forbidden','forbidden'],['insufficient_disk_space','storage'],['SSLHandshakeException','tls'],['Read timed out','timeout']])assert.equal(classifyUpdateError(Error(text),'download'),expected);
  assert.equal(classifyUpdateError(Error('disk full'),'save'),'save');
});
test('public update uses release files with no token, REST asset ID or REST tag',async()=>{
  const {updater,calls}=fixture({
    readRelease:()=>readPublicRelease(async options=>{
      assert.match(options.url,/github\.com\/troglobiont\/the-trail-clients\/releases\/latest\/download\/version\.json$/);
      assert.equal(options.headers,undefined);
      return {status:200,url:'https://release-assets.githubusercontent.com/object',data:manifest};
    }),
    async downloadUpdate(m){
      assert.equal(m.direct,true);assert.equal(m.assetId,undefined);assert.equal(m.bundle.url,manifest.bundle.url);
      calls.push('download');return {id:'bundle-1',version:m.version,checksum:m.bundle.sha256};
    }
  });
  await updater.update();
  assert.deepEqual(calls,['save','download','save','apply']);
});
test('public update rejects unrelated origins, malformed manifests and missing releases',async()=>{
  await assert.rejects(readPublicRelease(async()=>({status:200,url:'https://other.test/version.json',data:manifest})),/manifest/);
  await assert.rejects(readPublicRelease(async()=>({status:404})),/release-missing/);
  const {updater,calls}=fixture({async readRelease(){return {manifest:'<html>',direct:true};}});
  await updater.update();
  assert.equal(updater.state().error,'manifest');
  assert.ok(!calls.includes('apply'));
});
