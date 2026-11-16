import test from 'node:test';
import assert from 'node:assert/strict';
import {currentServiceOrigin,parseConnection} from '../src/connection.js';
const connection=(patch={})=>JSON.stringify({format:'the-trail-connection-v1',serviceURL:'https://coach.example/',key:'x'.repeat(48),...patch});
test('connection code separates a trusted origin and device secret',()=>{
  assert.deepEqual(parseConnection(connection()),{serviceURL:'https://coach.example',key:'x'.repeat(48)});
});
test('the known retired address moves to the permanent service with the original key',()=>{
  const retired='https://sandy-dimension-references-moses.trycloudflare.com';
  const permanent='https://clients.thetrail.space';
  assert.equal(currentServiceOrigin(retired),permanent);
  assert.equal(currentServiceOrigin(permanent),permanent);
  assert.equal(currentServiceOrigin(undefined),undefined);
  assert.deepEqual(parseConnection(connection({serviceURL:retired+'/'})),{serviceURL:permanent,key:'x'.repeat(48)});
  for(const serviceURL of ['https://another.trycloudflare.com',retired+'.example.test',retired+':444']){
    assert.equal(currentServiceOrigin(serviceURL),serviceURL);
    assert.equal(parseConnection(connection({serviceURL})).serviceURL,serviceURL);
  }
});
test('connection import rejects non-HTTPS and credentials or tokens embedded in URLs',()=>{
  for(const serviceURL of ['http://coach.example','https://user:pass@coach.example','https://coach.example/path','https://coach.example/?token=private','https://coach.example/#private'])assert.throws(()=>parseConnection(connection({serviceURL})));
});
test('client backups and Telegram API or session files cannot become connection codes',()=>{
  assert.throws(()=>parseConnection(connection({format:'the-trail-clients-backup'})));
  assert.throws(()=>parseConnection(connection({telegramSession:'private'})));
  assert.throws(()=>parseConnection(connection({apiHash:'private'})));
  assert.throws(()=>parseConnection('null'));
});
test('malformed or oversized connection input cannot be saved',()=>{
  for(const key of ['', 'short','x'.repeat(4097),'x'.repeat(25)+'\n'])assert.throws(()=>parseConnection(connection({key})));
  assert.throws(()=>parseConnection('x'.repeat(6001)));
  assert.throws(()=>parseConnection('not json'));
});
