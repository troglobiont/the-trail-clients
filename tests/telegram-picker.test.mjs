import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecipientSearch} from '../src/telegram-picker.js';
const contact={peerId:'102',displayName:'Тестовый контакт',username:'test_contact'};
test('mobile keyboard finalization keeps the chosen recipient, real edits invalidate it',async()=>{
  let view;
  const picker=createRecipientSearch({search:async()=>({contacts:[contact]}),onChange:state=>{view=state;}});
  picker.setQuery('Тестовый');await picker.find();picker.select('102');
  picker.setQuery('Тестовый');picker.setQuery(' Тестовый  ');
  assert.deepEqual(picker.selected(),contact);assert.equal(view.contacts.length,1);
  picker.setQuery('Другой');assert.equal(picker.selected(),null);assert.deepEqual(view.contacts,[]);
  picker.select('102');assert.equal(picker.selected(),null);
});
test('late search responses cannot repopulate edited or closed pickers',async()=>{
  const pending=[];let view;
  const picker=createRecipientSearch({search:query=>new Promise(resolve=>pending.push({query,resolve})),onChange:state=>{view=state;}});
  picker.setQuery('Первый');const first=picker.find();
  picker.setQuery('Второй');const second=picker.find();
  pending[1].resolve({contacts:[contact]});await second;picker.select('102');
  pending[0].resolve({contacts:[{...contact,peerId:'101'}]});await first;
  assert.deepEqual(picker.selected(),contact);
  picker.setQuery('Третий');const third=picker.find();picker.dispose();
  pending[2].resolve({contacts:[contact]});await third;assert.deepEqual(view.contacts,[]);
});
test('malformed responses are rejected atomically and never become selectable',async()=>{
  let view;
  for(const contacts of [[contact,{peerId:'-100',displayName:'Group'}],Array(11).fill(contact),null]){
    const picker=createRecipientSearch({search:async()=>({contacts}),onChange:state=>{view=state;}});
    picker.setQuery('Контакт');await picker.find();picker.select('102');
    assert.equal(picker.selected(),null);assert.deepEqual(view.contacts,[]);assert.ok(view.error);assert.equal(view.busy,false);
  }
});
