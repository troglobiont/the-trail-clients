import {id,localDate,validDate} from './model-utils.js';
import {CURRENCIES} from './accounting.js';
import {countsGroupAccrual,groupRecords} from './coach-accounting.js';

export const TEAM_ENTRY_KINDS={work:'Работа',accrual:'Начисление',payout:'Выплата',expense:'Расход'};
export const TEAM_PARTICIPATION={regular:'Постоянный',guest:'Приглашённый'};
const key=value=>typeof value==='string'&&/^[-a-zA-Z0-9_]{1,180}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const money=value=>Number.isSafeInteger(value)&&value>0&&value<=1e11;
const note=value=>typeof value==='string'&&value.length<=2000;
const validMonth=value=>typeof value==='string'&&/^\d{4}-\d{2}$/u.test(value)&&validDate(value+'-01');
export const teamEntryPeriod=entry=>entry.payoutPeriod??entry.day.slice(0,7);
export const isTeamMember=member=>Boolean(member&&!member.mergedInto&&(member.role==='Тренер'||member.teamAdmin?.role==='Тренер'));
export const sharesTeamProfile=member=>member.teamAdmin?.visible!==false;
export const teamMembers=(state,{includeHidden=true}={})=>Object.values(state.clients)
  .filter(member=>isTeamMember(member)&&(includeHidden||sharesTeamProfile(member)))
  .sort((a,b)=>a.name.localeCompare(b.name,'ru'));
export const teamRole=member=>member.role==='Тренер'&&member.teamRole==='Организатор'?'Организатор':'Тренер';
export const teamParticipation=member=>member.teamAdmin?.participation??'regular';
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
    ||entry.payoutPeriod!==undefined&&(entry.kind!=='payout'||!validMonth(entry.payoutPeriod))
    ||entry.amount!==null&&!money(entry.amount)||entry.kind!=='work'&&entry.amount===null
    ||entry.amount===null&&entry.currency!==null||entry.amount!==null&&!CURRENCIES.includes(entry.currency))
    throw Error('Проверь дату, время, сумму и валюту записи команды');
}
export function validateTeam(state){
  for(const member of Object.values(state.clients)){
    const admin=member.teamAdmin;if(admin===undefined)continue;
    // Keep the business history when a person's directory role is later changed.
    if(!object(admin)||!note(admin.notes)||!object(admin.entries)||Object.keys(admin.entries).length>10000
      ||admin.role!==undefined&&admin.role!=='Тренер'||admin.visible!==undefined&&typeof admin.visible!=='boolean'
      ||admin.participation!==undefined&&!Object.hasOwn(TEAM_PARTICIPATION,admin.participation)
      ||admin.specialty!==undefined&&(typeof admin.specialty!=='string'||admin.specialty.length>120||!admin.specialty.trim())
      ||admin.groupRate!==undefined&&!money(admin.groupRate))
      throw Error('Некорректные данные команды');
    for(const [k,entry] of Object.entries(admin.entries))checkEntry(entry,k);
  }
}
export function saveTeamProfile(state,memberId,{participation,specialty}){
  const member=memberFor(state,memberId);
  if(teamRole(member)!=='Тренер'||!Object.hasOwn(TEAM_PARTICIPATION,participation)||typeof specialty!=='string'||specialty.length>120)
    throw Error('Проверь формат участия и специализацию тренера');
  const admin={notes:'',entries:{},...member.teamAdmin,participation};
  const trimmed=specialty.trim();
  if(trimmed)admin.specialty=trimmed;
  else delete admin.specialty;
  member.teamAdmin=admin;
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
export function saveTeamGroupRate(state,memberId,groupRate){
  const member=memberFor(state,memberId);
  if(!money(groupRate))throw Error('Укажи ставку за тренировку');
  member.teamAdmin={notes:'',entries:{},...member.teamAdmin,groupRate};
}
export function saveTeamEntry(state,memberId,values){
  const member=memberFor(state,memberId),admin=member.teamAdmin||{notes:'',entries:{}};
  const old=values.id&&key(values.id)&&Object.hasOwn(admin.entries,values.id)?admin.entries[values.id]:null;
  if(values.id&&!old)throw Error('Запись не найдена');
  const payoutPeriod=values.payoutPeriod??old?.payoutPeriod;
  const next={id:old?.id||id('team-entry'),kind:values.kind,day:values.day,note:String(values.note||'').trim(),
    minutes:values.kind==='work'?values.minutes:null,amount:values.amount??null,
    currency:values.amount==null?null:values.currency,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),
    ...(values.kind==='payout'&&payoutPeriod!==undefined&&{payoutPeriod})};
  checkEntry(next,next.id);
  if(!old&&Object.keys(admin.entries).length>=10000)throw Error('Достигнут предел записей команды');
  member.teamAdmin={...admin,entries:{...admin.entries,[next.id]:next}};
  return next;
}
export function teamEntries(state,memberId,month=null){
  const manual=Object.values(memberFor(state,memberId).teamAdmin?.entries||{});
  const calendar=groupRecords(state).filter(e=>e.clientId===memberId&&!e.voided)
    .map(e=>({...e,kind:'work',createdAt:e.at,group:true,historical:!countsGroupAccrual(e)}));
  return [...manual,...calendar]
    .filter(e=>!month||teamEntryPeriod(e)===month)
    .sort((a,b)=>b.day.localeCompare(a.day)||b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
}
export function teamSummary(state,memberId,month){
  if(!validMonth(month))throw Error('Выбери месяц');
  const entries=teamEntries(state,memberId),monthly=entries.filter(e=>teamEntryPeriod(e)===month);
  const currencies={};
  for(const entry of entries){
    const period=teamEntryPeriod(entry);
    if(period>month||entry.amount===null||entry.historical)continue;
    const sums=currencies[entry.currency]??={accrued:0,paid:0,expenses:0,balance:0};
    if(['work','accrual'].includes(entry.kind))sums.balance+=entry.amount;
    if(entry.kind==='payout')sums.balance-=entry.amount;
    if(period!==month)continue;
    if(['work','accrual'].includes(entry.kind))sums.accrued+=entry.amount;
    if(entry.kind==='payout')sums.paid+=entry.amount;
    if(entry.kind==='expense')sums.expenses+=entry.amount;
  }
  return {minutes:monthly.reduce((sum,e)=>sum+(e.minutes||0),0),entries:monthly.length,
    unpricedWork:monthly.filter(e=>e.kind==='work'&&e.amount===null).length,currencies};
}

export function teamMonthPayoutDue(state,memberId,period) {
  const {currencies}=teamSummary(state,memberId,period);
  return Object.fromEntries(CURRENCIES.flatMap(currency=>{
    const sums=currencies[currency];
    const amount=sums&&Math.min(sums.balance,sums.accrued-sums.paid);
    return amount>0?[[currency,amount]]:[];
  }));
}

export function recordTeamPayout(state,memberId,{period,day,note,expected,amount,currency},today=localDate()) {
  if(!validMonth(period)||period>today.slice(0,7)||!validDate(day)||day>today)throw Error('Проверь месяц и дату выплаты');
  let parts=[[currency,amount]];
  if(expected){
    const due=teamMonthPayoutDue(state,memberId,period);
    if(CURRENCIES.some(unit=>due[unit]!==expected[unit]))throw Error('Сумма к выплате изменилась. Открой выплату заново');
    parts=Object.entries(due);
    if(!parts.length)throw Error('За этот месяц всё выплачено');
  }
  const member=memberFor(state,memberId);
  const draft={...state,clients:{...state.clients,[memberId]:{...member}}};
  for(const [currency,amount] of parts)
    saveTeamEntry(draft,memberId,{kind:'payout',day,amount,currency,note,payoutPeriod:period});
  member.teamAdmin=draft.clients[memberId].teamAdmin;
}

export function teamMonthFinance(state, month, externalExpenses) {
  const trainers = new Map();
  const cash = [], review = [];
  const trainerFor = member => {
    if (!trainers.has(member.id)) trainers.set(member.id,{
      member, groups:0, minutes:0, historic:0, accrued:{}, paid:{}, unpriced:0
    });
    return trainers.get(member.id);
  };
  const addAccrued = (trainer,entry) => {
    if (entry.amount) trainer.accrued[entry.currency] = (trainer.accrued[entry.currency] ?? 0) + entry.amount;
    else trainer.unpriced++;
  };
  for (const entry of groupRecords(state)) {
    const member = state.clients[entry.clientId];
    if (!member || entry.voided || !entry.day.startsWith(month+'-')) continue;
    const trainer = trainerFor(member);
    trainer.groups++;
    trainer.minutes += entry.minutes || 0;
    if (countsGroupAccrual(entry)) addAccrued(trainer,entry);
    else trainer.historic++;
  }
  const words = string => (string||'').toLowerCase().replace(/ё/g,'е').match(/[\p{L}\p{N}]+/gu) || [];
  for (const member of Object.values(state.clients)) {
    if (member.mergedInto) continue;
    for (const entry of Object.values(member.teamAdmin?.entries||{})) {
      if(entry.kind==='payout'&&teamEntryPeriod(entry)===month){
        const {paid}=trainerFor(member);
        paid[entry.currency]=(paid[entry.currency]??0)+entry.amount;
      }
      if (!entry.day.startsWith(month+'-')) continue;
      if (entry.kind === 'work' || entry.kind === 'accrual') {
        const trainer = trainerFor(member);
        trainer.minutes += entry.minutes || 0;
        addAccrued(trainer,entry);
        continue;
      }
      const possibleOverlap = externalExpenses.some(({date,operation,row})=>{
        if (operation) return date === entry.day && operation.currency === entry.currency && operation.amount === entry.amount;
        const amount = row.values[entry.currency];
        if (!amount) return false;
        if (date === entry.day && amount === entry.amount) return true;
        const label = words(row.name);
        return !date && entry.kind === 'payout' && label.length > 0 &&
          (label.every(word=>words(member.name).includes(word)) || /тренер/iu.test(row.name));
      });
      (possibleOverlap ? review : cash).push({kind:'expense',date:entry.day,member,teamEntry:entry});
    }
  }
  return {trainers:[...trainers.values()].sort((a,b)=>a.member.name.localeCompare(b.member.name,'ru')),cash,review};
}
