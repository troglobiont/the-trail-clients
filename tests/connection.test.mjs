import test from 'node:test';
import assert from 'node:assert/strict';
import {parseConnection} from '../src/connection.js';
const connection=(patch={})=>JSON.stringify({format:'the-trail-connection-v1',serviceURL:'https://coach.example/',key:'x'.repeat(48),...patch});
test('connection code separates a trusted origin and device secret',()=>{
  assert.deepEqual(parseConnection(connection()),{serviceURL:'https://coach.example',key:'x'.repeat(48)});
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
