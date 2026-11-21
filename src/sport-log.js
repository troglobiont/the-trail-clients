import {addDays, localDate, validDate} from './model-utils.js';
import {sameAthleteValue} from './athlete.js';

export const TRAINING_TYPES=[['run','Бег'],['gym','Зал'],['bike','Вело'],['other','Другое']];
export const RECOVERY_FIELDS={
  sleepMinutes:['Длительность сна, мин',0,1440,1],
  sleepHeartRate:['Средняя ЧСС сна, уд/мин',20,200,1],
  restingHeartRate:['Пульс покоя, уд/мин',20,200,1],
  hrv:['Ночная HRV (RMSSD), мс',1,500,.1],
  freshness:['Свежесть, 0–10',0,10,1],
  sleepQuality:['Качество сна, 0–10',0,10,1],
  discomfort:['Дискомфорт, 0–10',0,10,1],
  weight:['Вес, кг',10,500,.1],
};
const deviceFields=['sleepMinutes','sleepHeartRate','restingHeartRate','hrv'];
export const hasDeviceReading=record=>deviceFields.some(field=>record[field]!=null);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const range=(value,min,max)=>Number.isFinite(value)&&value>=min&&value<=max;
const bounded=(value,min,max)=>Math.max(min,Math.min(max,value));
const sourceKey=value=>value.trim().normalize('NFKC').toLowerCase().replace(/\s+/g,' ');
const mean=values=>values.reduce((sum,value)=>sum+value,0)/values.length;

function validSession(session){
  return object(session)&&TRAINING_TYPES.some(([type])=>type===session.type)
    &&Number.isInteger(session.minutes)&&range(session.minutes,1,1440)&&range(session.rpe,0,10)
    &&(session.power===undefined||session.type==='bike'&&object(session.power)
      &&range(session.power.normalized,1,3000)&&range(session.power.threshold,1,3000));
}

function validLoadDay(day){
  return object(day)&&Array.isArray(day.sessions)&&day.sessions.length<=24
    &&day.sessions.every(validSession)&&day.sessions.reduce((minutes,session)=>minutes+session.minutes,0)<=1440;
}

function validRecovery(record){
  if(!object(record))return false;
  const {source,...values}=record;
  return Object.keys(values).length>0&&Object.entries(values).every(([key,value])=>{
    const bounds=Object.hasOwn(RECOVERY_FIELDS,key)&&RECOVERY_FIELDS[key];
    return bounds&&range(value,bounds[1],bounds[2])&&(bounds[3]!==1||Number.isInteger(value));
  })&&(source===undefined||typeof source==='string'&&source.trim().length>0&&source.length<=80)
    &&(!hasDeviceReading(record)||typeof source==='string');
}

const validators={load:validLoadDay,recovery:validRecovery};
export function validateSportLog(log){
  if(!object(log)||Object.entries(log).some(([kind,days])=>!Object.hasOwn(validators,kind)||!object(days)
    ||Object.entries(days).some(([day,data])=>!validDate(day)||!validators[kind](data))))throw Error('Проверь историю спортсмена');
}

export function saveSportDay(client,kind,day,record,{today=localDate(),previous}={}){
  if(!client||client.mergedInto)throw Error('Клиент не найден');
  if(!validDate(day)||day>today)throw Error('Укажи дату не позже сегодняшней');
  if(!Object.hasOwn(validators,kind)||record!==null&&!validators[kind](record))
    throw Error(kind==='load'?'Проверь длительность и усилие тренировок':'Проверь наблюдения и источник замеров');
  const records=client.sportLog?.[kind]||{};
  const current=records[day]??null;
  if(previous!==undefined&&!sameAthleteValue(previous,current))
    throw Error('Запись за этот день уже изменилась. Открой её заново');
  if(record===null&&!current)return;
  client.sportLog??={};
  client.sportLog[kind]??={};
  if(record===null)delete client.sportLog[kind][day];
  else client.sportLog[kind][day]=record;
}

export const sessionLoad=session=>session.minutes*session.rpe;
export const powerTss=session=>session.power
  ?100*(session.minutes/60)*(session.power.normalized/session.power.threshold)**2:null;
export const dayLoad=day=>day.sessions.reduce((sum,session)=>sum+sessionLoad(session),0);

function throughDate(log,day){
  const days=[];
  for(let date=day;log[date];date=addDays(date,-1))days.push(dayLoad(log[date]));
  return days.reverse();
}
function smoothed(days,period){
  if(days.length<period)return null;
  let value=0;
  for(let index=0;index<period;index++)value+=days[index];
  value/=period;
  for(let index=period;index<days.length;index++)value+=(days[index]-value)/period;
  return value;
}

export function trainingLoad(log={},today=localDate()){
  const yesterday=addDays(today,-1);
  const through=log[today]?today:yesterday;
  const days=throughDate(log,through);
  const previous=through===today?days.slice(0,-1):days;
  const previousAtl=smoothed(previous,7),previousCtl=smoothed(previous,42);
  return {
    atl:smoothed(days,7),ctl:smoothed(days,42),
    tsb:previousCtl===null?null:previousCtl-previousAtl,
    through:days.length?through:null,streak:days.length,today:log[today]?dayLoad(log[today]):null,
  };
}

function median(values){
  const sorted=[...values].sort((a,b)=>a-b);
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:mean(sorted.slice(middle-1,middle+1));
}

export function recoveryIndex(log={},today=localDate()){
  const current=log[today];
  if(!current)return {value:null,groups:0,reference:{}};
  const from=addDays(today,-28);
  const history=Object.entries(log).filter(([day])=>day>=from&&day<today).map(([,record])=>record);
  const reference={};
  function relative(field,floor,device=true,transform=value=>value){
    if(current[field]==null)return null;
    const points=history.filter(record=>record[field]!=null&&(!device||record.source&&
      sourceKey(record.source)===sourceKey(current.source))).map(record=>record[field]);
    if(points.length<14)return null;
    reference[field]=median(points);
    const values=points.map(transform);
    const center=median(values);
    const spread=median(values.map(value=>Math.abs(value-center)));
    return bounded((transform(current[field])-center)/Math.max(1.4826*spread,floor),-2,2);
  }
  const sleep=relative('sleepMinutes',15);
  const hrv=relative('hrv',.05,true,Math.log);
  const heart=relative('restingHeartRate',1)??relative('sleepHeartRate',1);
  const pulse=[hrv,heart===null?null:-heart].filter(value=>value!==null);
  const freshness=relative('freshness',1,false);
  const domains=[[sleep===null?null:Math.min(0,sleep),.35],[pulse.length?mean(pulse):null,.35],[freshness,.30]]
    .filter(([value])=>value!==null);
  return {
    value:domains.length<2?null:Math.round(50+25*domains.reduce((sum,[value,weight])=>sum+value*weight,0)
      /domains.reduce((sum,[,weight])=>sum+weight,0)),
    groups:domains.length,reference,
  };
}
