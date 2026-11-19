import {id,localDate,validDate} from './model-utils.js';

export const PARTNER_STATUSES={draft:'Знакомство',terms_agreed:'Условия согласованы',owner_confirmed:'Подтверждено Сергеем',
  partner_confirmed_terms_unknown:'Условия уточняются',active:'Сотрудничаем',paused:'На паузе'};
export const PARTNER_CATEGORIES=['Спортивная диагностика','Часы и оборудование','Экипировка','Массаж и восстановление','Площадки','Другое'];
const key=value=>typeof value==='string' && /^[-a-zA-Z0-9_]{1,180}$/u.test(value) && !['__proto__','constructor','prototype'].includes(value);
const short=(value,max)=>typeof value==='string' && value.length<=max;
export function partnerURL(value) {
  try { const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null; }
  catch { return null; }
}
export const partnerList=state=>Object.values(state.partners||{}).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
export const partnerTasks=(state,partnerId=null,done=false)=>Object.values(state.partnerTasks||{})
  .filter(task=>(!partnerId||task.partnerId===partnerId)&&(task.phase==='done')===done)
  .sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999')||a.createdAt.localeCompare(b.createdAt));

export function validatePartners(state) {
  for(const bucket of ['partners','partnerTasks']) if(state[bucket]!==undefined && (!state[bucket] || Array.isArray(state[bucket])
      || typeof state[bucket]!=='object' || Object.keys(state[bucket]).length>10000)) throw Error('Некорректная база партнёров');
  for(const [k,p] of Object.entries(state.partners||{})) {
    if(!key(k)||p?.id!==k||!short(p.name,180)||!p.name.trim()||!short(p.category,100)
        ||!Object.hasOwn(PARTNER_STATUSES,p.relationshipStatus)||!Array.isArray(p.benefits)||p.benefits.length>50
        ||!Array.isArray(p.contacts)||p.contacts.length>30||!Array.isArray(p.sources)||p.sources.length>100
        ||p.notes!==undefined&&!short(p.notes,4000)) throw Error('Некорректная карточка партнёра');
    for(const term of p.benefits) if(!key(term.id)||!short(term.description||term.service||'',1000)
        ||term.discountPercent!=null&&(!Number.isFinite(term.discountPercent)||term.discountPercent<0||term.discountPercent>100)
        ||term.price!=null&&(!Number.isFinite(term.price)||term.price<0||term.price>1e9)
        ||term.confirmedOn!=null&&!validDate(term.confirmedOn)) throw Error('Проверь условия партнёра');
    for(const contact of p.contacts) if(!contact||!short(contact.name||'',180)||!short(contact.email||'',254)||!short(contact.phone||'',60)) throw Error('Проверь контакт партнёра');
  }
  for(const [k,t] of Object.entries(state.partnerTasks||{})) if(!key(k)||t?.id!==k||!state.partners?.[t.partnerId]
      ||!short(t.title,1000)||!t.title.trim()||!['todo','done'].includes(t.phase)||t.due!==null&&!validDate(t.due)
      ||!Number.isFinite(Date.parse(t.createdAt))) throw Error('Проверь задачу партнёра');
}

export function savePartner(state,values) {
  const old=values.id?state.partners?.[values.id]:null;
  if(values.id&&!old)throw Error('Партнёр не найден');
  const partner={...old,...values,id:old?.id||id('partner'),name:String(values.name??old?.name??'').trim(),
    category:values.category??old?.category??'Другое',relationshipStatus:values.relationshipStatus??old?.relationshipStatus??'draft',
    contacts:values.contacts??old?.contacts??[],benefits:values.benefits??old?.benefits??[],sources:values.sources??old?.sources??[],
    createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
  validatePartners({partners:{...state.partners,[partner.id]:partner},partnerTasks:state.partnerTasks});
  (state.partners??={})[partner.id]=partner;
  return partner;
}

export function savePartnerTask(state,partnerId,values) {
  if(!state.partners?.[partnerId])throw Error('Партнёр не найден');
  const old=values.id?state.partnerTasks?.[values.id]:null;
  if(values.id&&(!old||old.partnerId!==partnerId))throw Error('Задача не найдена');
  const task={...old,id:old?.id||id('partner-task'),partnerId,title:String(values.title??old?.title??'').trim(),
    due:values.due??old?.due??null,phase:old?.phase||'todo',createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
  // An explicit null clears the due date.
  if(Object.hasOwn(values,'due'))task.due=values.due;
  validatePartners({partners:state.partners,partnerTasks:{...state.partnerTasks,[task.id]:task}});
  (state.partnerTasks??={})[task.id]=task;
  return task;
}
export function completePartnerTask(state,taskId,done=true) {
  const task=state.partnerTasks?.[taskId];if(!task)throw Error('Задача не найдена');
  task.phase=done?'done':'todo';task.closedAt=done?new Date().toISOString():null;task.updatedAt=new Date().toISOString();
}
export function termConfirmation(partner,term) {
  if(term.manualConfirmation)return {level:'owner_statement',date:term.confirmedOn||null};
  return {level:partner.confirmation?.level||'unknown',date:term.confirmedOn||partner.confirmation?.date||null};
}
export function savePartnerTerm(state,partnerId,term) {
  const partner=state.partners?.[partnerId];if(!partner)throw Error('Партнёр не найден');
  const old=term.id?partner.benefits.find(item=>item.id===term.id):null;
  if(term.id&&!old)throw Error('Условие не найдено');
  const next={...old,...term,id:old?.id||id('partner-term'),manualConfirmation:true,confirmedOn:term.confirmedOn||localDate()};
  // Changed terms are a new owner statement; retain earlier sources as history only.
  if(old)next.previousSourceIds=old.previousSourceIds||old.sourceIds||[];
  next.sourceIds=[];delete next.priceBasis;delete next.referencePrice;
  savePartner(state,{id:partnerId,benefits:old?partner.benefits.map(item=>item.id===old.id?next:item):[...partner.benefits,next]});
}
