import {addDays,localDate,validDate} from './model-utils.js';

export const GARMIN_MEASURES={sleepMinutes:'Сон',hrv:'Ночная HRV',restingHeartRate:'Пульс покоя'};
const bounds={sleepMinutes:[0,1440],hrv:[1,500],restingHeartRate:[20,200]};
const keys=Object.keys(GARMIN_MEASURES);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const numeric=(value,min,max)=>Number.isFinite(value)&&value>=min&&value<=max;
const activityId=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/u.test(value);
const source=record=>record?.source?.trim().toLowerCase()||'';

export function garminSnapshot(payload,clientId){
  if(!object(payload)||payload.clientId!==clientId||typeof payload.asOf!=='string'||!Number.isFinite(Date.parse(payload.asOf))
    ||!validDate(payload.from)||!validDate(payload.to)||payload.from!==addDays(payload.to,-28)
    ||!object(payload.measures))throw Error('Не удалось прочитать данные Garmin');
  const {asOf,from,to}=payload;
  const inside=day=>validDate(day)&&day>=from&&day<=to;
  let activities=null;
  if(payload.activities!==null){
    if(!Array.isArray(payload.activities)||payload.activities.length>500)throw Error('Не удалось прочитать тренировки Garmin');
    const byId=new Map();
    for(const entry of payload.activities){
      if(!object(entry)||!activityId(entry.id)||!inside(entry.day)||typeof entry.title!=='string'||entry.title.length>180
        ||typeof entry.sport!=='string'||entry.sport.length>60||entry.time!==null&&
          (typeof entry.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/u.test(entry.time))
        ||!['seconds','meters','ascent','averageHr'].every(field=>entry[field]===null||numeric(entry[field],0,1000000)))
        throw Error('Не удалось прочитать тренировку Garmin');
      const {id,day,time,title,sport,seconds,meters,ascent,averageHr}=entry;
      byId.set(id,{id,day,time,title,sport,seconds,meters,ascent,averageHr});
    }
    activities=[...byId.values()].sort((a,b)=>b.day.localeCompare(a.day)||(b.time||'').localeCompare(a.time||'')||b.id.localeCompare(a.id));
  }
  const measures={};
  for(const key of keys){
    const readings=payload.measures[key];
    if(readings!==null&&(!object(readings)||Object.entries(readings).some(([day,value])=>!inside(day)||!numeric(value,...bounds[key]))))
      throw Error('Не удалось прочитать замеры Garmin');
    measures[key]=readings===null?null:{...readings};
  }
  return {clientId,asOf,from,to,activities,measures};
}

export function mergeGarminSnapshot(previous,next){
  if(Date.parse(previous?.asOf)>Date.parse(next.asOf))return previous;
  const inside=day=>day>=next.from&&day<=next.to;
  return {...next,activities:next.activities??(previous?.activities||[]).filter(activity=>inside(activity.day)),
    measures:Object.fromEntries(keys.map(key=>[key,next.measures[key]??Object.fromEntries(
      Object.entries(previous?.measures?.[key]||{}).filter(([day])=>inside(day)))])),
    missing:[...(next.activities===null?['Тренировки']:[]),...keys.filter(key=>next.measures[key]===null).map(key=>GARMIN_MEASURES[key])]};
}

export function garminRecovery(snapshot,manual={}){
  if(!snapshot)return manual;
  const result={...manual};
  for(const key of keys)for(const [day,value] of Object.entries(snapshot.measures[key])){
    if(source(result[day])!=='garmin'){
      const {freshness,sleepQuality,discomfort,weight}=manual[day]||{};
      result[day]=Object.fromEntries(Object.entries({source:'Garmin',freshness,sleepQuality,discomfort,weight}).filter(([,item])=>item!=null));
    }
    result[day]={...result[day],[key]:value};
  }
  return result;
}

export function latestGarminPulse(snapshot,today=localDate()){
  const readings=snapshot?.measures?.restingHeartRate||{};
  const day=Object.keys(readings).filter(date=>date<=today).sort().at(-1);
  return day?{day,value:readings[day]}:null;
}
