import {addDays,localDate,validDate} from './model-utils.js';

export const ASSIGNMENT_MAX_BYTES = 128 * 1024;
const FORMAT = 'the-trail-athlete-training-week';
const numericId = value => typeof value === 'string' && /^\d{1,24}$/.test(value);

function workoutText(value,max,required=false){
  if(value==null&&!required)return '';
  if(typeof value!=='string'||value.length>max||required&&!value.trim())throw Error('Проверь название и описание тренировки.');
  return value.replace(/\r\n?/g,'\n').trim();
}

function normalizeAssignment(value){
  if(value?.format!==FORMAT||value.schemaVersion!==1)throw Error('Выбери файл личной тренировочной недели THE.TRAIL.');
  const {athleteId,weekStart,checkedAt,sessions}=value;
  if(!numericId(athleteId))throw Error('В пакете отсутствует идентификатор спортсмена.');
  if(!validDate(weekStart)||new Date(weekStart+'T12:00:00Z').getUTCDay()!==1)throw Error('Неделя должна начинаться в понедельник.');
  if(typeof checkedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(checkedAt)
    ||!validDate(checkedAt.slice(0,10))||!Number.isFinite(Date.parse(checkedAt)))throw Error('Проверь время сверки пакета.');
  if(!Array.isArray(sessions)||sessions.length>100)throw Error('Проверь список тренировок недели.');
  const ids=new Set(),end=addDays(weekStart,6);
  const workouts=sessions.map(session=>{
    if(!numericId(session?.id)||ids.has(session.id))throw Error('Проверь идентификаторы тренировок. Каждый должен быть уникальным.');
    if(!validDate(session.day)||session.day<weekStart||session.day>end)throw Error('Дата тренировки выходит за границы недели.');
    ids.add(session.id);
    return {id:session.id,day:session.day,title:workoutText(session.title,180,true),description:workoutText(session.description,10000)};
  }).sort((left,right)=>left.day.localeCompare(right.day));
  return {format:FORMAT,schemaVersion:1,athleteId,weekStart,checkedAt:new Date(checkedAt).toISOString(),sessions:workouts};
}

export function parseTrainingAssignment(text){
  if(typeof text!=='string'||new TextEncoder().encode(text).length>ASSIGNMENT_MAX_BYTES)throw Error('Размер файла недели превышает 128 КБ.');
  let value;
  try{value=JSON.parse(text.replace(/^\uFEFF/,''));}
  catch{throw Error('Не удалось прочитать файл недели. Нужен JSON.');}
  return normalizeAssignment(value);
}

export function validateTrainingAssignments(records){
  if(!Array.isArray(records))throw Error('Некорректные личные тренировочные недели.');
  const keys=new Set();
  return records.map(record=>{
    const clientId=record?.clientId;
    if(typeof clientId!=='string'||!/^[-a-zA-Z0-9_]{1,180}$/.test(clientId))throw Error('Некорректная привязка тренировочной недели.');
    const week=normalizeAssignment(record);
    const key=clientId+'/'+week.weekStart;
    if(keys.has(key))throw Error('У спортсмена повторяется тренировочная неделя.');
    keys.add(key);
    return {...week,clientId};
  });
}

export function trainingAssignmentFor(state,client,today=localDate()){
  if(client?.role!=='Клиент'||client.mergedInto||!client.athlete?.trainingPeaksId)return null;
  const weeks=(state.settings.trainingAssignments??[])
    .filter(week=>week.clientId===client.id&&week.athleteId===client.athlete.trainingPeaksId);
  if(!weeks.length)return null;
  return weeks.find(week=>today>=week.weekStart&&today<=addDays(week.weekStart,6))
    ??weeks.reduce((latest,week)=>week.weekStart>latest.weekStart?week:latest);
}

export function previewTrainingAssignment(state,clientId,week){
  const client=state.clients[clientId];
  if(client?.role!=='Клиент'||client.mergedInto||client.athlete?.trainingPeaksId!==week.athleteId){
    throw Error('Файл недели относится к другому спортсмену или карточка ещё не сопоставлена с планом.');
  }
  const current=(state.settings.trainingAssignments??[]).find(record=>record.clientId===clientId&&record.weekStart===week.weekStart);
  if(!current)return true;
  if(current.athleteId!==week.athleteId)throw Error('У этой недели уже есть другая привязка к спортсмену.');
  if(JSON.stringify(current.sessions)===JSON.stringify(week.sessions))return false;
  if(week.checkedAt<=current.checkedAt)throw Error('Новая версия недели должна иметь более позднее время сверки.');
  return true;
}

export function applyTrainingAssignment(state,clientId,value){
  const week=normalizeAssignment(value);
  if(!previewTrainingAssignment(state,clientId,week))return false;
  const records=state.settings.trainingAssignments??[];
  state.settings.trainingAssignments=[...records.filter(record=>record.clientId!==clientId||record.weekStart!==week.weekStart),{...week,clientId}];
  return true;
}
