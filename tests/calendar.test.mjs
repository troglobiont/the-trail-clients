import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient, emptyState, linkCalendarTask} from '../src/core.js';
import * as A from '../src/accounting.js';
import {localDate} from '../src/model-utils.js';
import {calendarClient, calendarPlace, isSchedulingTask, taskCalendarChoices} from '../src/calendar-ui.js';

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

test('the abbreviated title for an outdoor session resolves to the client and outdoor tariff', () => {
  const client = {id:'c1',name:'Тестов Владимир'};
  const event = {title:'Персональная · Владимир · Сергей',location:'Калемегдан'};
  assert.equal(calendarClient(event,{c1:client}),client);
  assert.equal(calendarPlace(event.location),'Улица');
  assert.equal(calendarPlace('Mega Gym'),'Зал');
});

test('completing a calendar session uses advance once and can record a separate actual payment', () => {
  const s = emptyState();
  const date = localDate();
  const client = createClient(s,{name:'Тестов Владимир'},date);
  const service = A.saveService(s,{clientId:client.id,kind:'personal',block:'personal',place:'Улица',currency:'RSD',rate:400000,
    startsOn:date,endsOn:null,day:null,reminder:false,openingCredit:{date,amount:3200000}});
  const data = {clientId:client.id,serviceId:service.id,place:service.place,amount:service.rate,currency:service.currency,date,
    sessionId:'calendar-session-one',paymentId:'calendar-payment-one'};
  A.recordCalendarSession(s,data);
  assert.deepEqual(A.serviceBalance(s,service.id),{received:0,used:400000,balance:2800000});
  assert.throws(()=>A.recordCalendarSession(s,data),/уже записана/u);
  assert.equal(A.operations(s).length,1);
  const sameDay = {...data,sessionId:'calendar-session-two',paymentId:'calendar-payment-two',received:400000,receivedOn:date};
  const [session,receipt] = A.recordCalendarSession(s,sameDay);
  assert.equal(receipt.sessionId,session.id);
  assert.equal(A.serviceBalance(s,service.id).balance,2800000);
  A.setVoided(s,session.id,true);
  assert.throws(()=>A.recordCalendarSession(s,sameDay),/уже есть оплата/u);
});
