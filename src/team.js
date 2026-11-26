import {id,validDate} from './model-utils.js';
import {CURRENCIES} from './accounting.js';

export const TEAM_ENTRY_KINDS={work:'Работа',accrual:'Начисление',payout:'Выплата',expense:'Расход'};
const key=value=>typeof value==='string'&&/^[-a-zA-Z0-9_]{1,180}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const money=value=>Number.isSafeInteger(value)&&value>0&&value<=1e11;
const note=value=>typeof value==='string'&&value.length<=2000;
export const isTeamMember=member=>Boolean(member&&!member.mergedInto&&(member.role==='Тренер'||member.teamAdmin?.role==='Тренер'));
export const sharesTeamProfile=member=>member.teamAdmin?.visible!==false;
export const teamMembers=(state,{includeHidden=true}={})=>Object.values(state.clients)
  .filter(member=>isTeamMember(member)&&(includeHidden||sharesTeamProfile(member)))
  .sort((a,b)=>a.name.localeCompare(b.name,'ru'));
export const teamRole=member=>member.role==='Тренер'&&member.teamRole==='Организатор'?'Организатор':'Тренер';
function memberFor(state,memberId){
  const member=state.clients[memberId];
  if(!isTeamMember(member))throw Error('Участник команды не найден');
  return member;
}
function checkEntry(entry,k){
  if(!object(entry)||!key(k)||entry.id!==k||!Object.hasOwn(TEAM_ENTRY_KINDS,entry.kind)||!validDate(entry.day)
    ||!note(entry.note)||typeof entry.createdAt!=='string'||typeof entry.updatedAt!=='string'
    ||!Number.isFinite(Date.parse(entry.createdAt))||!Number.isFinite(Date.parse(entry.updatedAt))
    ||entry.kind==='work'&&(!Number.isInteger(entry.minutes)||entry.minutes<1||entry.minutes>1440)
    ||entry.kind!=='work'&&entry.minutes!==null
    ||entry.amount!==null&&!money(entry.amount)||entry.kind!=='work'&&entry.amount===null
    ||entry.amount===null&&entry.currency!==null||entry.amount!==null&&!CURRENCIES.includes(entry.currency))
    throw Error('Проверь дату, время, сумму и валюту записи команды');
}
export function validateTeam(state){
  for(const member of Object.values(state.clients)){
    const admin=member.teamAdmin;if(admin===undefined)continue;
    // Keep the business history when a person's directory role is later changed.
    if(!object(admin)||!note(admin.notes)||!object(admin.entries)||Object.keys(admin.entries).length>10000
      ||admin.role!==undefined&&admin.role!=='Тренер'||admin.visible!==undefined&&typeof admin.visible!=='boolean')
      throw Error('Некорректные данные команды');
    for(const [k,entry] of Object.entries(admin.entries))checkEntry(entry,k);
  }
}
export function saveTeamVisibility(state,memberId,visible){
  const member=memberFor(state,memberId);
  if(typeof visible!=='boolean')throw Error('Укажи видимость участника');
  member.teamAdmin={notes:'',entries:{},...member.teamAdmin,visible};
}
export function saveTeamNotes(state,memberId,notes){
  const member=memberFor(state,memberId);
  if(!note(notes))throw Error('Заметка не должна превышать 2000 символов');
  member.teamAdmin={...member.teamAdmin,notes:notes.trim(),entries:member.teamAdmin?.entries||{}};
}
export function saveTeamEntry(state,memberId,values){
  const member=memberFor(state,memberId),admin=member.teamAdmin||{notes:'',entries:{}};
  const old=values.id&&key(values.id)&&Object.hasOwn(admin.entries,values.id)?admin.entries[values.id]:null;
  if(values.id&&!old)throw Error('Запись не найдена');
  const next={id:old?.id||id('team-entry'),kind:values.kind,day:values.day,note:String(values.note||'').trim(),
    minutes:values.kind==='work'?values.minutes:null,amount:values.amount??null,
    currency:values.amount==null?null:values.currency,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
  checkEntry(next,next.id);
  if(!old&&Object.keys(admin.entries).length>=10000)throw Error('Достигнут предел записей команды');
  member.teamAdmin={...admin,entries:{...admin.entries,[next.id]:next}};
  return next;
}
export function teamEntries(state,memberId,month=null){
  return Object.values(memberFor(state,memberId).teamAdmin?.entries||{})
    .filter(e=>!month||e.day.slice(0,7)===month)
    .sort((a,b)=>b.day.localeCompare(a.day)||b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
}
export function teamSummary(state,memberId,month){
  if(!validDate(month+'-01'))throw Error('Выбери месяц');
  const entries=teamEntries(state,memberId),monthly=entries.filter(e=>e.day.slice(0,7)===month);
  const currencies={};
  for(const entry of entries){
    if(entry.day.slice(0,7)>month||entry.amount===null)continue;
    const sums=currencies[entry.currency]??={accrued:0,paid:0,expenses:0,balance:0};
    if(['work','accrual'].includes(entry.kind))sums.balance+=entry.amount;
    if(entry.kind==='payout')sums.balance-=entry.amount;
    if(entry.day.slice(0,7)!==month)continue;
    if(['work','accrual'].includes(entry.kind))sums.accrued+=entry.amount;
    if(entry.kind==='payout')sums.paid+=entry.amount;
    if(entry.kind==='expense')sums.expenses+=entry.amount;
  }
  return {minutes:monthly.reduce((sum,e)=>sum+(e.minutes||0),0),entries:monthly.length,
    unpricedWork:monthly.filter(e=>e.kind==='work'&&e.amount===null).length,currencies};
}
