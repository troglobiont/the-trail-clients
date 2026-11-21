import {normalizeSearch} from './core.js';

export const ROLES={superadmin:'Суперадмин',coach:'Тренер',accountant:'Бухгалтер',athlete:'Спортсмен'};
export const OWNER_COACH='owner-coach';
const ownerName='Шелковой Сергей';
const ownerNames=new Set([ownerName,'Сергей Шелковой'].map(normalizeSearch));
export const isOwnerPerson=client=>ownerNames.has(normalizeSearch(client?.name));
export const hasFinance=role=>role==='superadmin'||role==='accountant';
export const isAthlete=role=>role==='athlete';
const available=client=>client?.role==='Клиент'&&!client.mergedInto;

export function previewAthletes(state){
  return Object.values(state.clients).filter(available).sort((left,right)=>left.name.localeCompare(right.name,'ru'));
}

export function previewAthlete(state,id){
  const client=state.clients[id];
  return available(client)?client:Object.values(state.clients).find(client=>available(client)&&isOwnerPerson(client));
}

export function previewCoaches(state){
  return [[OWNER_COACH,ownerName],...Object.values(state.clients).filter(client=>client.role==='Тренер'
    &&client.teamRole!=='Организатор'&&!client.mergedInto&&!isOwnerPerson(client)).map(client=>[client.id,client.name])];
}

export function assignedCoach(state,client){
  const id=client.coachId;
  return previewCoaches(state).some(([key])=>key===id)?id:OWNER_COACH;
}

export function coachContact(state,id){
  return id===OWNER_COACH?Object.values(state.clients).find(client=>!client.mergedInto&&isOwnerPerson(client)):state.clients[id];
}

export const isPaymentText=value=>/(?:^|[^\p{L}])(?:оплат\p{L}*|плат[её]ж\p{L}*|долг(?:а|у|и|ом)?|задолженн\p{L}*|дебитор\p{L}*|аванс\p{L}*)(?![\p{L}])/iu.test(value||'');

export function previewTaskVisible(task,{role,athleteId,coachId=OWNER_COACH}){
  if(isAthlete(role))return task.clientId===athleteId&&task.sharedWithAthlete===true;
  if(role==='coach')return (!task.coachId||task.coachId===coachId)&&!task.payment
    &&(task.kind==='athlete-question'||!isPaymentText(task.title));
  return true;
}

export function previewScheduleVisible(event,client,task,{role,athleteId,coachId=OWNER_COACH}){
  if(isAthlete(role))return Boolean(athleteId&&client?.id===athleteId);
  if(role==='coach')return (event.coachId||task?.calendarEvent?.coachId||task?.coachId||OWNER_COACH)===coachId;
  return true;
}

export function previewRoute(hash,{role,athleteId}){
  if(role!=='superadmin'&&(hash==='#settings'||hash==='#assistant'))return '#todo';
  if(role==='accountant'&&hash==='#races')return '#todo';
  if(role==='coach'&&(hash==='#account'||hash==='#todo/payments'))return '#todo';
  if(hash==='#calendar'&&role!=='coach')return '#todo';
  if(hash==='#profile'&&!isAthlete(role))return '#clients';
  if(isAthlete(role)){
    if(hash==='#clients'||hash.startsWith('#clients/')||hash.startsWith('#client/')&&hash.split('/')[1]!==athleteId)return '#profile';
    if(hash.startsWith('#admin/')||hash==='#partners'||hash.startsWith('#partners/'))return '#admin';
  }
  return hash;
}
