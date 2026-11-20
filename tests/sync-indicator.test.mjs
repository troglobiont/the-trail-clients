import test from 'node:test';
import assert from 'node:assert/strict';
import {syncIndicatorState} from '../src/sync-indicator.js';

test('header never shows a synced check for pending, offline or unsaved data',()=>{
  const view={status:'synced'};
  assert.equal(syncIndicatorState({view}).icon,'check');
  assert.equal(syncIndicatorState({view,pending:true}).status,'pending');
  assert.equal(syncIndicatorState({view,pending:true}).icon,'upload');
  assert.equal(syncIndicatorState({view,online:false}).status,'offline');
  assert.equal(syncIndicatorState({view,online:false}).icon,'off');
  assert.equal(syncIndicatorState({view,saveError:true}).status,'save-error');
  assert.equal(syncIndicatorState({view,saving:true}).disabled,true);
});

test('working, disconnected and conflict states have distinct actions without hiding errors',()=>{
  assert.equal(syncIndicatorState({view:{status:'working'},online:false}).icon,'refresh');
  assert.equal(syncIndicatorState({view:{status:'working'}}).disabled,true);
  assert.equal(syncIndicatorState({view:{status:'disconnected'}}).status,'local');
  const conflict=syncIndicatorState({view:{status:'conflict'},online:false});
  assert.equal(conflict.status,'conflict');assert.equal(conflict.disabled,false);
  assert.match(conflict.action,/сравнение/u);
  assert.equal(syncIndicatorState({view:{status:'error',error:'Network unavailable'}}).detail,'Network unavailable');
});
