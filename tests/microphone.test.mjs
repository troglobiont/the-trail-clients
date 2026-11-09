import test from 'node:test';
import assert from 'node:assert/strict';
import {microphoneAccess,microphoneState} from '../src/microphone.js';

test('already granted microphone starts without another system permission request',async()=>{
  let requested=0;
  const result=await microphoneAccess({native:true,async microphonePermission(){return {state:'granted'};},async requestMicrophonePermission(){requested++;}});
  assert.equal(result.state,'granted');assert.equal(result.openSettings,false);assert.equal(requested,0);
});
test('first consent and rationale retry use the native Android request',async()=>{
  for(const state of ['prompt','prompt-with-rationale']){
    let requested=0;
    const result=await microphoneAccess({native:true,async microphonePermission(){return {state};},async requestMicrophonePermission(){requested++;return {state:'granted'};}});
    assert.equal(result.state,'granted');assert.equal(requested,1);
  }
});
test('denying consent returns to the card without automatically opening settings',async()=>{
  const bridge={native:true,async microphonePermission(){return {state:'prompt'};},async requestMicrophonePermission(){return {state:'denied'};}};
  const result=await microphoneAccess(bridge);
  assert.equal(result.state,'denied');assert.equal(result.settingsRequired,true);assert.equal(result.openSettings,false);
  let requested=false;bridge.microphonePermission=async()=>({state:'denied'});bridge.requestMicrophonePermission=async()=>{requested=true;};
  const retry=await microphoneAccess(bridge);
  assert.equal(retry.openSettings,true);assert.equal(requested,false);
});
test('old APK and malformed native responses cannot falsely report permission',async()=>{
  await assert.rejects(()=>microphoneAccess({native:true}),/APK/);
  await assert.rejects(()=>microphoneAccess({native:true,async microphonePermission(){return {state:'native-update-required'};},async requestMicrophonePermission(){}}),/APK/);
  assert.throws(()=>microphoneState({state:'unknown'}));
  assert.equal((await microphoneAccess({native:false})).state,'browser');
});
