import {CURRENCIES,accounting,activeService,saveOperation} from './accounting.js';
import {localDate,validDate} from './model-utils.js';

export const GROUP_COMPLETION='coach-group-completion';
export const GROUP_REPORT='coach-group-report';
export const GROUP_STAFFING='coach-group-staffing';
export const COACH_CASH='coach-cash';
export const GROUP_RATE=200000;
export const CASH_STATUS={pending:'На проверке',returned:'Нужно уточнить',approved:'Подтверждено'};

const key=value=>typeof value==='string'&&/^[-a-zA-Z0-9_]{1,180}$/u.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const amount=value=>Number.isSafeInteger(value)&&value>0&&value<=100000000000;
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const note=(value,max=1000)=>typeof value==='string'&&value.length<=max;
const month=value=>typeof value==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/u.test(value);
const staff=(state,id)=>Object.hasOwn(state.clients,id)?state.clients[id]:null;
const trainer=person=>person&&!person.mergedInto&&
  (person.teamAdmin?.role==='Тренер'||person.role==='Тренер'&&person.teamRole!=='Организатор');
export const assignableGroupCoach=person=>Boolean(trainer(person)&&person.teamAdmin?.participation!=='guest');

export const isGroupRecord=entry=>entry?.type===GROUP_COMPLETION||entry?.type===GROUP_REPORT;
export const countsGroupAccrual=entry=>entry.type===GROUP_COMPLETION||entry.type===GROUP_REPORT&&entry.payConfirmed===true;
export const groupCompletion=(state,eventKey,calendarRef)=>
  state.events.find(e=>e.type===GROUP_REPORT&&calendarRef&&e.calendarRef===calendarRef)
  ?? state.events.find(e=>isGroupRecord(e)&&e.id===eventKey);

export function groupRecords(state){
  const reports=new Set(state.events.filter(e=>e.type===GROUP_REPORT&&e.calendarRef).map(e=>e.calendarRef));
  return state.events.filter(e=>e.type===GROUP_REPORT||e.type===GROUP_COMPLETION&&!reports.has(e.calendarRef));
}
export function groupEventReference(event){
  try{ return new URL(event.url).searchParams.get('eid')||event.id; }
  catch{ return event.id; }
}
export function groupStaffing(state,event){
  const ref=groupEventReference(event);
  return ref&&state.events.find(entry=>entry.type===GROUP_STAFFING&&entry.calendarRef===ref);
}
export const coachCash=(state,coachId)=>state.events.filter(e=>e.type===COACH_CASH&&(!coachId||e.clientId===coachId))
  .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));

function replaceEvent(state,entry){
  const index=state.events.findIndex(e=>e.id===entry.id);
  if(index<0)state.events.push(entry);
  else state.events[index]=entry;
  return entry;
}

export function updateGroupStaffing(state,eventKey,event,{action,coachId,requesterId,revision},context,now=new Date()){
  const calendarRef=groupEventReference(event);
  if(!key(eventKey)||!calendarRef||!note(calendarRef,1000)||event.kind!=='group'||!timestamp(event.start))
    throw Error('Групповая тренировка не найдена');
  if(Date.parse(event.start)<=now.getTime())throw Error('Тренировка уже началась');
  const previous=groupStaffing(state,event);
  if((previous?.revision??0)!==revision)throw Error('Назначение изменилось. Открой тренировку снова');
  const admin=context.role==='superadmin';
  if(action==='request'){
    if(context.role!=='coach'||!trainer(staff(state,context.coachId)))throw Error('Запрос может отправить тренер');
  }else if(!admin)throw Error('Утвердить назначение может только суперадмин');
  const at=now.toISOString();
  const entry=previous?{...previous,requests:{...previous.requests}}:
    {id:eventKey,type:GROUP_STAFFING,calendarRef,at,revision:0,coachId:null,draftCoachId:null,requests:{}};
  if(action==='decline'){
    if(!Object.hasOwn(entry.requests,requesterId))throw Error('Запрос уже рассмотрен');
    delete entry.requests[requesterId];
  }else{
    if(!key(coachId)||!assignableGroupCoach(staff(state,coachId)))throw Error('Выбери тренера для группового расписания');
    if(action==='draft')entry.draftCoachId=coachId;
    else if(action==='request')entry.requests[context.coachId]={coachId,at};
    else if(action==='approve'){
      const candidate=requesterId?entry.requests[requesterId]?.coachId:entry.draftCoachId;
      if(coachId!==candidate)throw Error('Предложение изменилось');
      entry.coachId=coachId;
      entry.draftCoachId=null;
      entry.requests={};
    }else throw Error('Действие с назначением неизвестно');
  }
  return replaceEvent(state,{...entry,updatedAt:at,revision:entry.revision+1});
}

export function saveGroupCompletion(state,eventKey,event,coachId,context,voided=false,now=new Date()){
  const calendarRef=groupEventReference(event),previous=groupCompletion(state,eventKey,calendarRef);
  if(!key(eventKey)||event.kind!=='group'||!timestamp(event.start)||!timestamp(event.end))throw Error('Тренировка не найдена');
  if(context.role!=='superadmin'&&(context.role!=='coach'||context.coachId!==coachId||voided||
    previous)) {
    if(context.role==='coach'&&context.coachId===coachId&&previous?.clientId===coachId&&!previous.voided&&!voided)return previous;
    throw Error('Отметку может изменить суперадмин');
  }
  if(!trainer(staff(state,coachId)))throw Error('Выбери ответственного тренера');
  const minutes=Math.round((Date.parse(event.end)-Date.parse(event.start))/60000);
  if(minutes<1||minutes>1440||Date.parse(event.end)>now.getTime())throw Error('Отметку можно поставить после занятия');
  if(voided&&!previous)throw Error('Отметка о проведении не найдена');
  const at=now.toISOString();
  const next={...previous,id:previous?.id??eventKey,type:previous?.type??GROUP_COMPLETION,calendarRef,clientId:coachId,at:previous?.at??at,updatedAt:at,
    day:localDate(new Date(event.start)),minutes,
    amount:(previous?.clientId===coachId?previous.amount:staff(state,coachId).teamAdmin?.groupRate)??GROUP_RATE,currency:'RSD',
    note:String(event.location||'').trim().slice(0,180),voided};
  if(previous&&['clientId','day','minutes','note','voided'].every(k=>previous[k]===next[k]))return previous;
  return replaceEvent(state,next);
}

function cashValues(state,values,today){
  const {serviceId,date,currency,amount:received,period,note:description}=values;
  const service=accounting(state).services[serviceId],person=state.clients[service?.clientId];
  if(!service||person?.role!=='Клиент'||person.mergedInto||service.oneOff)throw Error('Выбери услугу клиента');
  if(!validDate(date)||date>today||!activeService(service,date)||!CURRENCIES.includes(currency)||!amount(received)||!note(description))
    throw Error('Проверь дату, валюту и сумму получения');
  if(service.kind==='personal'?period!==null:!month(period)||period<service.startsOn.slice(0,7)
    ||service.endsOn&&period>service.endsOn.slice(0,7))throw Error('Проверь месяц оплаты');
  return {payerClientId:service.clientId,serviceId,date,currency,amount:received,period,note:description.trim()};
}

export function submitCoachCash(state,requestId,values,context,now=new Date()){
  const at=now.toISOString(),previous=coachCash(state).find(e=>e.id===requestId);
  if(!key(requestId)||context.role!=='coach'||!trainer(staff(state,context.coachId))||
    previous&&previous.clientId!==context.coachId)throw Error('Наличные отправляет получивший их тренер');
  if(previous?.status==='pending'&&!values.expectedUpdatedAt)return previous;
  if(previous&&(previous.status!=='returned'||values.expectedUpdatedAt!==previous.updatedAt))throw Error('Запись уже изменилась');
  const fields=cashValues(state,values,localDate(now));
  if(previous&&(previous.payerClientId!==fields.payerClientId))
    throw Error('Проверь исходную услугу');
  return replaceEvent(state,{...previous,id:requestId,type:COACH_CASH,clientId:context.coachId,
    at:previous?.at??at,updatedAt:at,status:'pending',...fields,
    history:[...(previous?.history??[]),{at,action:previous?'resubmitted':'submitted',actor:context.coachId,values:fields}]});
}

export function reviewCoachCash(state,requestId,expectedUpdatedAt,decision,values,context,now=new Date()){
  if(context.role!=='superadmin')throw Error('Подтвердить оплату может суперадмин');
  const previous=coachCash(state).find(e=>e.id===requestId);
  if(!previous)throw Error('Запись не найдена');
  if(previous.status==='approved'&&decision==='approved')return previous;
  if(previous.status!=='pending'||previous.updatedAt!==expectedUpdatedAt)throw Error('Запись уже изменилась');
  const at=now.toISOString(),actor=context.actorId||'superadmin';
  if(decision==='returned'){
    const reason=String(values.reason??'').trim();
    if(!reason||!note(reason))throw Error('Укажи, что нужно уточнить');
    return replaceEvent(state,{...previous,status:'returned',reason,updatedAt:at,
      history:[...previous.history,{at,action:'returned',actor,reason}]});
  }
  if(decision!=='approved')throw Error('Выбери решение по оплате');
  const fields=cashValues(state,{...previous,...values},localDate(now));
  if(fields.payerClientId!==previous.payerClientId)throw Error('Выбери услугу того же клиента');
  const service=accounting(state).services[fields.serviceId];
  const credit=fields.currency===service.currency?fields.amount:values.credit;
  if(!amount(credit))throw Error('Укажи зачёт в валюте тарифа');
  const operationId='payment-'+requestId;
  if(accounting(state).operations[operationId])throw Error('Эта оплата уже записана');
  const label=('Наличные · принял '+state.clients[previous.clientId].name).slice(0,300);
  saveOperation(state,{kind:'payment',date:fields.date,currency:fields.currency,amount:fields.amount,payer:'',
    note:[label,fields.note].filter(Boolean).join(' · ').slice(0,300),
    allocations:[{serviceId:fields.serviceId,month:fields.period,part:fields.amount,credit}]},operationId);
  return replaceEvent(state,{...previous,...fields,status:'approved',operationId,updatedAt:at,
    history:[...previous.history,{at,action:'approved',actor,values:fields,credit}]});
}

export function validateCoachAccounting(state){
  const seen=new Set(),staffed=new Set();
  for(const e of state.events){
    if(e?.type===GROUP_STAFFING){
      const knownCoach=id=>key(id)&&Boolean(staff(state,id));
      if(!key(e.id)||seen.has(e.id)||!e.calendarRef||!note(e.calendarRef,1000)||staffed.has(e.calendarRef)
        ||!timestamp(e.at)||!timestamp(e.updatedAt)||!Number.isSafeInteger(e.revision)||e.revision<1
        ||e.coachId!==null&&!knownCoach(e.coachId)||e.draftCoachId!==null&&!knownCoach(e.draftCoachId)
        ||!e.requests||typeof e.requests!=='object'||Array.isArray(e.requests)
        ||Object.entries(e.requests).some(([id,r])=>!knownCoach(id)||!knownCoach(r?.coachId)||!timestamp(r.at)))
        throw Error('Некорректное назначение группового тренера');
      seen.add(e.id);staffed.add(e.calendarRef);
      continue;
    }
    if(!isGroupRecord(e)&&e?.type!==COACH_CASH)continue;
    if(!key(e.id)||seen.has(e.id)||!state.clients[e.clientId]||!timestamp(e.at)||!timestamp(e.updatedAt))
      throw Error('Некорректная запись учёта тренера');
    seen.add(e.id);
    if(isGroupRecord(e)){
      const report=e.type===GROUP_REPORT;
      const hasDuration=Number.isInteger(e.minutes)&&e.minutes>=1&&e.minutes<=1440;
      const hasCalendarRef=Boolean(e.calendarRef)&&note(e.calendarRef,1000);
      if(!validDate(e.day)||!amount(e.amount)||e.currency!=='RSD'||typeof e.voided!=='boolean'||!note(e.note,180)
        ||!(hasDuration||report&&e.minutes===null)||!(hasCalendarRef||report&&e.calendarRef===null)
        ||e.payConfirmed!==undefined&&(!report||typeof e.payConfirmed!=='boolean'||e.payConfirmed&&(!hasDuration||!hasCalendarRef))
        ||report&&(!e.source||!note(e.source,180)))
        throw Error('Некорректная отметка о групповой тренировке');
    }else if(!Object.hasOwn(CASH_STATUS,e.status)||!state.clients[e.payerClientId]||
      !key(e.serviceId)||!validDate(e.date)||!CURRENCIES.includes(e.currency)||!amount(e.amount)||!note(e.note)||
      !(e.period===null||month(e.period))||!Array.isArray(e.history)||!e.history.length||
      e.status==='approved'&&(e.operationId!=='payment-'+e.id||accounting(state).operations[e.operationId]?.kind!=='payment'))
      throw Error('Некорректная запись о получении наличных');
  }
}
