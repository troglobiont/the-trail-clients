import assert from 'node:assert/strict';
import test from 'node:test';
import {answerCoachQuestion,askCoach,athleteQuestions,createClient,createTask,emptyState,exportState,parseImport,shareTaskWithAthlete} from '../src/core.js';
import {assignedCoach,OWNER_COACH,previewAthlete,previewRoute,previewScheduleVisible,previewTaskVisible} from '../src/role-preview.js';

function fixture(){
  const state=emptyState();
  const owner=createClient(state,{name:'Шелковой Сергей'});
  const coach=createClient(state,{name:'Тестовый тренер',role:'Тренер'});
  const athlete=createClient(state,{name:'Тестовый спортсмен',coachId:coach.id});
  return {state,owner,coach,athlete};
}

test('role routes do not open hidden pages or another athlete card',()=>{
  const {state,owner,athlete}=fixture();
  assert.equal(previewAthlete(state).id,owner.id);
  const personal={role:'athlete',athleteId:athlete.id};
  assert.equal(previewRoute('#client/'+owner.id+'/training',personal),'#profile');
  assert.equal(previewRoute('#client/'+athlete.id+'/load',personal),'#client/'+athlete.id+'/load');
  assert.equal(previewRoute('#admin/team/somebody',personal),'#admin');
  assert.equal(previewRoute('#partners/some-partner',personal),'#partners/some-partner');
  assert.equal(previewRoute('#partners/some-partner/task/one',personal),'#admin');
  for(const role of ['coach','accountant'])assert.equal(previewRoute('#admin/team/somebody',{role}),'#admin');
  assert.equal(previewRoute('#admin/team/somebody',{role:'superadmin'}),'#admin/team/somebody');
  assert.equal(previewRoute('#settings',personal),'#settings');
  assert.equal(previewRoute('#settings',{role:'coach'}),'#settings');
  assert.equal(previewRoute('#settings',{role:'accountant'}),'#settings');
  assert.equal(previewRoute('#assistant',personal),'#todo');
  assert.equal(previewRoute('#todo/schedule/event',personal),'#calendar');
  assert.equal(previewRoute('#todo/payments',personal),'#account');
  assert.equal(previewRoute('#calendar/2026-11-28',personal),'#calendar/2026-11-28');
  assert.equal(previewRoute('#coach',{role:'coach'}),'#todo');
  assert.equal(previewRoute('#account',{role:'coach'}),'#todo');
  assert.equal(previewRoute('#todo/payments',{role:'coach'}),'#todo');
  assert.equal(previewRoute('#races',{role:'accountant'}),'#todo');
  assert.equal(previewRoute('#races',{role:'superadmin'}),'#races');
});

test('coach answers close the linked task and stay in the correct athlete history',()=>{
  const {state,owner,coach,athlete}=fixture();
  const question=askCoach(state,athlete.id,coach.id,'Как перенести тренировку?');
  assert.throws(()=>answerCoachQuestion(state,question.id,' '),/Напиши ответ/u);
  answerCoachQuestion(state,question.id,'До воскресенья можно перенести.');
  answerCoachQuestion(state,question.id,'До воскресенья можно перенести.');
  const restored=parseImport(exportState(state));
  assert.equal(restored.tasks[question.id].phase,'done');
  assert.equal(athleteQuestions(restored,athlete.id)[0].task.coachAnswer.text,'До воскресенья можно перенести.');
  assert.deepEqual(athleteQuestions(restored,owner.id),[]);
  assert.equal(restored.events.filter(event=>event.type==='task-closed'&&event.entityId===question.id).length,1);
});

test('the existing calendar belongs to the owner and explicit coach assignments remain scoped',()=>{
  const {coach,athlete,owner}=fixture();
  const ownerView={role:'coach',coachId:OWNER_COACH};
  const staffView={role:'coach',coachId:coach.id};
  assert(previewScheduleVisible({},owner,null,ownerView));
  assert(!previewScheduleVisible({},owner,null,staffView));
  assert(previewScheduleVisible({coachId:coach.id},athlete,null,staffView));
  assert(!previewScheduleVisible({coachId:coach.id},athlete,null,ownerView));
  assert(previewScheduleVisible({},athlete,{calendarEvent:{coachId:coach.id}},staffView));
  const athleteView={role:'athlete',athleteId:athlete.id};
  assert(!previewScheduleVisible({},null,null,athleteView));
  assert(!previewScheduleVisible({},owner,null,athleteView));
  assert(previewScheduleVisible({},athlete,null,athleteView));
});

test('questions create a single assigned coach task and sharing with each athlete is explicit',()=>{
  const {state,owner,coach,athlete}=fixture();
  const context={role:'athlete',athleteId:athlete.id};
  const privateTask=createTask(state,athlete.id,'Заметка для тренера');
  assert(!previewTaskVisible(privateTask,context));
  shareTaskWithAthlete(state,privateTask.id,true);
  assert(previewTaskVisible(privateTask,context));
  assert(!previewTaskVisible(privateTask,{...context,athleteId:owner.id}));
  const task=askCoach(state,athlete.id,assignedCoach(state,athlete),'Как перенести тренировку?','record-question');
  assert.equal(task.title,'Разобрать вопрос клиента');
  assert.equal(task.coachId,coach.id);
  assert.equal(askCoach(state,athlete.id,OWNER_COACH,'Как перенести тренировку?','record-question').id,task.id);
  assert.equal(task.coachId,coach.id);
  assert(previewTaskVisible(task,{role:'coach',coachId:coach.id}));
  assert(!previewTaskVisible(task,{role:'coach',coachId:OWNER_COACH}));
  assert(previewTaskVisible(task,{role:'superadmin'}));
  assert(!previewTaskVisible(createTask(state,athlete.id,'Уточнить оплату'),{role:'coach'}));
  const restored=parseImport(exportState(state));
  assert.equal(restored.tasks[task.id].sourceRecordId,'record-question');
  assert.equal(restored.records['record-question'].text,'Как перенести тренировку?');
});
