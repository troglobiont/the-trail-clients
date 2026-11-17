import test from 'node:test';
import assert from 'node:assert/strict';
import {linkCalendarTask} from '../src/core.js';
import {isSchedulingTask, taskCalendarChoices} from '../src/calendar-ui.js';

test('finding a session by a unique first name does not associate an ambiguous first name', () => {
  const task = {id:'task-1',clientId:'c1',title:'Согласовать день недели и время тренировки'};
  const clients = {c1:{id:'c1',name:'Тестова Эмилия'},c2:{id:'c2',name:'Тестов Иван'}};
  const singleName = {id:'one',title:'Персональная · Эмилия · Сергей'};
  const fullName = {id:'two',title:'Персональная · Эмилия Тестова · Сергей'};
  const foreign = {id:'three',title:fullName.title,clientId:'c2'};
  assert.ok(isSchedulingTask(task));
  assert.deepEqual(taskCalendarChoices([singleName,fullName,foreign],clients,task,{}),[singleName,fullName]);
  clients.c3 = {id:'c3',name:'Примерова Эмилия'};
  assert.deepEqual(taskCalendarChoices([singleName,fullName,foreign],clients,task,{}),[fullName]);
});

test('linking keeps the calendar event on the completed task and rejects another task using it', () => {
  const task = {id:'task-1',clientId:'c1',phase:'todo'}, other = {...task,id:'task-2'};
  const s = {tasks:{[task.id]:task,[other.id]:other},events:[]};
  const event = {id:'google-event',start:'2026-11-19T15:30:00+01:00',end:'2026-11-19T16:30:00+01:00'};
  linkCalendarTask(s,task.id,event);
  assert.equal(task.phase,'done');
  assert.equal(task.calendarEvent.id,event.id);
  assert.throws(()=>linkCalendarTask(s,other.id,event),/уже привязана/u);
  assert.equal(other.phase,'todo');
});
