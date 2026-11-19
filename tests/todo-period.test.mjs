import test from 'node:test';
import assert from 'node:assert/strict';
import {todoPeriodEntries} from '../src/todo-period.js';
import {taskDate} from '../src/core.js';

test('ToDo periods separate overdue, upcoming and undated entries without losing the full list',()=>{
  const entries=[{due:'2026-11-18'},{due:'2026-11-19'},{due:'2026-11-26'},{due:'2026-12-19'},{due:'2026-12-20'},{due:null}];
  assert.equal(todoPeriodEntries(entries,null,'2026-11-19'),entries);
  assert.deepEqual(todoPeriodEntries(entries,7,'2026-11-19'),entries.slice(1,3));
  assert.deepEqual(todoPeriodEntries(entries,30,'2026-11-19'),entries.slice(1,4));
  assert.deepEqual(todoPeriodEntries(entries,-1,'2026-11-19'),entries.slice(0,1));
});

test('a task awaiting a reply is filtered by the next check instead of the original due date',()=>{
  const task={phase:'waiting',due:'2026-11-01',checkOn:'2026-11-23'};
  const entries=[{due:taskDate(task)}];
  assert.deepEqual(todoPeriodEntries(entries,-1,'2026-11-19'),[]);
  assert.deepEqual(todoPeriodEntries(entries,7,'2026-11-19'),entries);
});
