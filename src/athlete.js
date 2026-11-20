import {validDate} from './model-utils.js';

export const ATHLETE_METRICS={
  lthr:['LTHR / ПАНО','уд/мин'],lt1:['LT1 / АэП','уд/мин'],restHr:['Пульс покоя','уд/мин'],maxHr:['Настройка Max HR','уд/мин'],
  peakHr:['Пиковая ЧСС','уд/мин'],vo2max:['VO₂max','мл/кг/мин'],paceLT1:['Темп АэП','pace'],paceLT2:['Темп ПАНО','pace'],
  workSeconds:['Длительность работы','seconds'],analysisSeconds:['Участок анализа','seconds'],
  sleepMin:['Минимум ЧСС сна','уд/мин'],sleepMax:['Максимум ЧСС сна','уд/мин'],sleepMinutes:['Сон','minutes'],sleepQuality:['Оценка сна приложением','%'],
  tempoMin:['Нижняя цель карточки','уд/мин'],tempoMax:['Верхняя цель карточки','уд/мин'],percentMin:['Нижний % LTHR','%'],percentMax:['Верхний % LTHR','%']
};
export const ATHLETE_STATUSES={historical:'Исторический ориентир',field_estimate:'Полевая оценка',working:'Рабочий',retained:'Сохранён ориентир',
  temporary:'Временно',snapshot:'Срез настроек',observation:'Наблюдение',coach_confirmed:'Со слов тренера',saved_readback:'Сохранено и перечитано',proposed:'Предложение'};
const kinds=['test','decision','zones','snapshot','device','observation','application'];
const accepted=['historical','working','retained','temporary'];
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const key=v=>typeof v==='string'&&/^[-a-zA-Z0-9_]{1,180}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const short=(v,max=2000)=>typeof v==='string'&&v.length<=max;
const map=v=>object(v)&&Object.keys(v).length<=2000&&Object.keys(v).every(key);
const metrics=v=>object(v)&&Object.entries(v).every(([k,n])=>Object.hasOwn(ATHLETE_METRICS,k)&&Number.isFinite(n)&&n>=0&&n<=1e5);
export const sameAthleteValue=(a,b)=>{
  if(a===b)return true;if(!object(a)||!object(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>sameAthleteValue(x,b[i]));
  return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&sameAthleteValue(a[k],b[k]));
};
export function athleteMetric(client,metric){
  const athlete=client.athlete,entry=athlete?.entries[athlete.current[metric]];
  return entry?.kind==='decision'&&entry.metric===metric&&accepted.includes(entry.status)?entry:null;
}
export const athleteZones=client=>client.athlete?.entries[client.athlete.current.zones]||null;
export function validateAthlete(athlete){
  if(!object(athlete)||athlete.schemaVersion!==1||!/^\d{1,16}$/.test(athlete.trainingPeaksId)||!map(athlete.sources)||!map(athlete.entries)||!object(athlete.current)
    ||athlete.goalId!=null&&!key(athlete.goalId)||!short(athlete.raceStatus||'',300)
    ||!object(athlete.restrictions)||!['unknown','reported'].includes(athlete.restrictions.status)
    ||athlete.restrictions.text!==null&&!short(athlete.restrictions.text)||athlete.restrictions.day!==null&&!validDate(athlete.restrictions.day))
    throw Error('Проверь структуру спортивной карточки');
  for(const [id,s] of Object.entries(athlete.sources))if(!object(s)||s.id!==id||!short(s.label,300)||!s.label.trim()
    ||!validDate(s.day)||!short(s.note||''))throw Error('Проверь источник спортивных данных');
  for(const [id,e] of Object.entries(athlete.entries)){
    if(!object(e)||e.id!==id||!kinds.includes(e.kind)||!short(e.title,180)||!e.title.trim()||!validDate(e.day)
      ||!Object.hasOwn(athlete.sources,e.sourceId)||!Object.hasOwn(ATHLETE_STATUSES,e.status)||!short(e.note||'')
      ||!Array.isArray(e.references)||e.references.length>40||e.references.some(ref=>!key(ref)||ref===id||!Object.hasOwn(athlete.entries,ref))
      ||!Array.isArray(e.details)||e.details.length>30||e.details.some(t=>!short(t,1000))
      ||e.metrics!==undefined&&!metrics(e.metrics))throw Error('Проверь запись спортивных данных');
    if(e.kind==='decision'&&(!['lthr','lt1','restHr','maxHr'].includes(e.metric)||!Number.isFinite(e.value)||e.value<20||e.value>255
      ||e.previousId!=null&&(!e.references.includes(e.previousId)||athlete.entries[e.previousId]?.kind!=='decision')))
      throw Error('Проверь решение по спортивному показателю');
    if(e.kind==='zones'){
      if(!Array.isArray(e.rows)||e.rows.length!==6||e.rows.some((r,i)=>!Array.isArray(r)||r.length!==3||r[0]!=='Z'+i
        ||!Number.isInteger(r[1])||!Number.isInteger(r[2])||r[1]<0||r[2]>255||r[1]>r[2]||i>0&&r[1]!==e.rows[i-1][2]+1))
        throw Error('Проверь шесть пульсовых зон');
      if(e.lthrRef&&(athlete.entries[e.lthrRef]?.kind!=='decision'||athlete.entries[e.lthrRef]?.metric!=='lthr'
        ||e.rows[3][1]!==athlete.entries[e.lthrRef].value||!e.references.includes(e.lthrRef)))throw Error('Зоны не согласуются с указанным решением LTHR');
    }
    if(e.confidence!=null&&!['unknown','low','medium','high'].includes(e.confidence))throw Error('Проверь статус достоверности');
    if(e.equipment!==undefined&&(!object(e.equipment)||Object.values(e.equipment).some(value=>!short(value,300))))throw Error('Проверь сведения об устройствах');
    if(e.workoutId!=null&&!/^\d{1,20}$/.test(e.workoutId))throw Error('Проверь ID тренировки');
  }
  for(const [metric,ref] of Object.entries(athlete.current)){
    if(!['lthr','lt1','restHr','maxHr','zones'].includes(metric)||!key(ref))throw Error('Проверь рабочие ссылки');
    const e=athlete.entries[ref];
    if(!e||metric==='zones'&&e.kind!=='zones'||metric!=='zones'&&(e.kind!=='decision'||e.metric!==metric||!accepted.includes(e.status)))
      throw Error('Рабочий показатель должен ссылаться на принятое решение');
  }
  return athlete;
}
export function validateAthletes(state){
  for(const client of Object.values(state.clients))if(client.athlete){
    validateAthlete(client.athlete);
    const goal=client.athlete.goalId&&state.goals[client.athlete.goalId];
    if(client.athlete.goalId&&(!goal||goal.clientId!==client.id))throw Error('Проверь связь спортивной карточки с целью');
  }
  for(const record of Object.values(state.records))if(record.athleteRefs!==undefined&&(!Array.isArray(record.athleteRefs)
    ||record.athleteRefs.some(ref=>!state.clients[record.clientId]?.athlete?.entries[ref])))throw Error('Проверь спортивные ссылки журнала');
}
// Immutable evidence IDs make a repeated controlled import a no-op. Changes need a new version.
export function mergeAthlete(client,incoming,{expectedCurrent}={}){
  validateAthlete(incoming);
  const old=client.athlete;
  if(old&&old.trainingPeaksId!==incoming.trainingPeaksId)throw Error('ID спортсмена не совпадает');
  const next={...incoming,...old,sources:{...old?.sources},entries:{...old?.entries},current:{...old?.current}};
  for(const bucket of ['sources','entries'])for(const [id,record] of Object.entries(incoming[bucket])){
    if(Object.hasOwn(next[bucket],id)&&!sameAthleteValue(next[bucket][id],record))throw Error('Конфликт версии спортивной записи: '+id);
    next[bucket][id]=JSON.parse(JSON.stringify(record));
  }
  for(const [metric,ref] of Object.entries(incoming.current)){
    if(old?.current[metric]&&old.current[metric]!==ref&&expectedCurrent?.[metric]!==old.current[metric])throw Error('Рабочий показатель уже изменён: '+metric);
    next.current[metric]=ref;
  }
  validateAthlete(next);
  if(sameAthleteValue(old,next))return false;
  client.athlete=next;return true;
}
