import { addDays, id, localDate, validDate } from './model-utils.js';
import { mergeAccounting, validateAccounting } from './accounting.js';
import { nameKey, validateStoredLedger } from './ledger-import.js';
import { validateCloudState } from './cloud-state.js';
import { raceById, raceCatalog, raceDefinition, raceGoal, sameRace, setProfile, setTraining } from './client-details.js';
export { TIMEZONE, id, localDate, validDate, addDays } from './model-utils.js';

export const SCHEMA=1;
export const STATUSES=['Активный','На паузе','Завершил','Ожидает старта','Нужно уточнить'];
export const PAUSE_KINDS={ planned:'С ориентиром', open:'Без срока' };
export const BASES=['Beginners','Middle','Hard','Simple','Online','Gym','С нуля','Сейчас плана нет'];
export const GOAL_STATUSES=['Желание клиента','Согласовано','Предложение тренера','Рабочая цель тренера'];
export const TEMPLATES=['Привет! Как дела?','Привет! Как самочувствие?','Привет! Как прошла тренировка?'];
const stamp=()=>new Date().toISOString();
export function emptyState(){return {schemaVersion:SCHEMA,revision:0,clients:{},goals:{},tasks:{},records:{},events:[],settings:{waitDays:2},createdAt:stamp(),updatedAt:stamp()};}
export function clone(value){return JSON.parse(JSON.stringify(value));}
export function normalizeSearch(text){const map={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};return String(text||'').toLowerCase().replace(/[а-яё]/g,c=>map[c]).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/kh/g,'h').replace(/ya|ia/g,'a').replace(/iy|ii|yi|y|j/g,'i').replace(/[^a-z0-9]/g,'');}
export function validateState(s){
  if(!s||s.schemaVersion!==SCHEMA||!Number.isSafeInteger(s.revision)||s.revision<0)throw Error('Неподдерживаемая версия базы');
  for(const name of ['clients','goals','tasks','records'])if(!s[name]||typeof s[name]!=='object'||Array.isArray(s[name])||Object.keys(s[name]).length>50000||Object.keys(s[name]).some(key=>!/^[-a-zA-Z0-9_]{1,180}$/.test(key)||['__proto__','constructor','prototype'].includes(key)))throw Error('Некорректная база: '+name);
  if(!Array.isArray(s.events)||!s.settings||!Number.isInteger(s.settings.waitDays)||s.settings.waitDays<1||s.settings.waitDays>30)throw Error('Некорректные настройки базы');
  for(const [key,c] of Object.entries(s.clients))if(!c||c.id!==key||typeof c.name!=='string'||!c.name.trim()||c.name.length>180||!['Клиент','Тренер'].includes(c.role)||c.role==='Клиент'&&!STATUSES.includes(c.status)||!Array.isArray(c.features)||!Array.isArray(c.rules))throw Error('Некорректная карточка клиента');
  for(const [key,g] of Object.entries(s.goals))if(!g||g.id!==key||!s.clients[g.clientId]||typeof g.title!=='string'||!g.title.trim()||g.title.length>500||!GOAL_STATUSES.includes(g.status))throw Error('Некорректная цель');
  for(const [key,t] of Object.entries(s.tasks))if(!t||t.id!==key||!s.clients[t.clientId]||typeof t.title!=='string'||!t.title.trim()||!['todo','waiting','done'].includes(t.phase)||!['current','discussion'].includes(t.lane)||!Number.isInteger(t.waitDays)||t.waitDays<1||t.waitDays>30||!Number.isInteger(t.outboundCount)||t.outboundCount<0||t.due!==null&&!validDate(t.due)||t.checkOn!==null&&!validDate(t.checkOn))throw Error('Некорректная задача');
  for(const [key,r] of Object.entries(s.records))if(!r||r.id!==key||!s.clients[r.clientId]||typeof r.text!=='string'||r.text.length>16000)throw Error('Некорректная запись');
  for(const e of s.events)if(e?.type==='client-movement'&&(!Object.prototype.hasOwnProperty.call(s.clients,e.clientId)||!validDate(e.day)||typeof e.at!=='string'||!STATUSES.includes(e.status)||![null,'new','returned','paused','ended'].includes(e.movement)))throw Error('Некорректная запись движения клиентов');
  validateAccounting(s);
  validateStoredLedger(s);
  validateCloudState(s);
  return s;
}
export function event(s,type,clientId,entityId,details={}){s.events.push({id:id('event'),type,clientId,entityId,at:stamp(),...details});}
const directorySort = new Intl.Collator('ru', { sensitivity: 'base' });
export const clientRole = client => client.teamRole === 'Организатор' ? 'Организатор' : client.role;
export const pauseKind = client => client.pause?.kind === 'planned' ? 'planned' : 'open';
export function clientSection(client) {
  if (client.mergedInto) return null;
  if (client.role !== 'Клиент') return 'team';
  if (client.status === 'На паузе') return 'paused';
  if (client.status === 'Завершил') return 'archive';
  if (client.status !== 'Активный') return 'pending';
  return client.engagement === 'occasional' ? 'occasional' : 'active';
}
export function pauseContacts(s) {
  return filterClients(s, { section:'paused' }).filter(c => validDate(c.pause?.contactOn))
    .sort((a,b) => a.pause.contactOn.localeCompare(b.pause.contactOn));
}
export function filterClients(s, f = {}) {
  const words = String(f.query || '').split(/\s+/).map(normalizeSearch).filter(Boolean);
  return Object.values(s.clients).filter(c => {
    const format = c.currentFormat || c.format;
    const labels = [c.name, ...(c.aliases || [])].map(normalizeSearch);
    return !c.mergedInto && words.every(word => labels.some(label => label.includes(word)))
      && (!f.section || clientSection(c) === f.section)
      && (!f.pauseKind || pauseKind(c) === f.pauseKind)
      && (!f.role || f.role === 'all' || c.role === f.role)
      && (!f.status || f.status === 'all' || c.status === f.status)
      && (!f.format || f.format === 'all' || format === f.format)
      && (!f.quick || f.quick === 'all' || (f.quick === 'gym' ? c.personal === 'gym' : c.format === f.quick))
      && (!f.basis || f.basis === 'all' || c.basis === f.basis)
      && (!f.level || f.level === 'all' || c.level === f.level)
      && (!f.personal || f.personal === 'all' || c.personal === f.personal);
  }).sort((a,b) => directorySort.compare(a.name, b.name) || a.id.localeCompare(b.id));
}
function recordMovement(s, client, previous, day) {
  if (client.role !== 'Клиент' || client.status === previous) return;
  if (!validDate(day) || day > localDate()) throw Error('Проверь дату изменения статуса');
  const history = s.events.filter(e => e.type === 'client-movement' && e.clientId === client.id);
  if (history.some(e => e.day > day)) throw Error('Дата раньше предыдущего изменения статуса');
  const previouslyActive = history.some(e => e.status === 'Активный');
  const movement = client.status === 'Активный'
    ? (!previouslyActive && [null, 'Ожидает старта'].includes(previous) ? 'new' : 'returned')
    : ({ 'На паузе': 'paused', 'Завершил': 'ended' })[client.status] ?? null;
  event(s, 'client-movement', client.id, client.id, { day, status: client.status, previous, movement });
}
export function createClient(s,values,day=localDate()){
  const name=String(values.name||'').trim();if(!name||name.length>180)throw Error('Введи имя клиента');
  ensureUniqueName(s,name);
  const client={id:id('client'),aliases:[],role:'Клиент',status:'Активный',format:'Уточнить',currentFormat:null,group:'Уточнить',personal:'unknown',basis:'Сейчас плана нет',level:'Обычное',features:[],rules:[],camps:[],zones:null,telegram:null,lastContact:null,context:'',...values,name};
  s.clients[client.id]=client;event(s,'client-created',client.id,client.id);recordMovement(s,client,null,day);return client;
}
export function editClient(s,clientId,values,day=localDate()){
  const c=s.clients[clientId];if(!c)throw Error('Клиент не найден');
  const previous=c.role==='Клиент'?c.status:null;
  if (values.name && nameKey(values.name) !== nameKey(c.name)) ensureUniqueName(s,values.name,clientId);
  const allowed=['name','role','status','format','currentFormat','group','personal','basis','level','context','rules','telegram','engagement','teamRole','pause','billingNote'];
  for(const k of allowed)if(k in values)c[k]=values[k];
  event(s,'client-edited',clientId,clientId);recordMovement(s,c,previous,day);
}
function ensureUniqueName(s,name,except) {
  const key = nameKey(name);
  if (Object.values(s.clients).some(c => c.id !== except && !c.mergedInto && [c.name,...(c.aliases || [])].some(value => nameKey(value) === key))) {
    throw Error('Карточка с таким именем уже есть. Проверь другие категории, включая архив.');
  }
}
export function saveProfile(s,clientId,values){
  setProfile(s.clients[clientId],values);
  event(s,'profile-edited',clientId,clientId);
}
export function saveTraining(s,clientId,values){
  setTraining(s.clients[clientId],values);
  event(s,'training-edited',clientId,clientId);
}
export function noteTelegramOpen(s,clientId,peerId,at=stamp()){
  const c=s.clients[clientId];
  if(!c || c.telegram?.peerId !== peerId || !Number.isFinite(Date.parse(at))) return;
  if(!c.telegramOpenedAt || Date.parse(c.telegramOpenedAt)<=Date.parse(at)) c.telegramOpenedAt=at;
  event(s,'telegram-opened',clientId,clientId,{at});
}
export function setTelegramCheck(s,clientId,days,today=localDate()){
  const c=s.clients[clientId];
  if(!c || days!==null && (!Number.isInteger(days) || days<1 || days>365 || !validDate(today))) throw Error('Укажи от 1 до 365 дней');
  c.telegramCheck=days===null?null:{days,since:c.telegramCheck?.since||today};
}
export function setTelegramBinding(s,clientId,binding){
  const c=s.clients[clientId];if(!c)throw Error('Клиент не найден');
  if(s.settings.pendingTelegram?.[clientId])throw Error('Сначала проверь предыдущую неподтверждённую отправку');
  if(binding!==null&&(!binding||!/^[1-9]\d{0,19}$/.test(binding.peerId||'')))throw Error('Выбери получателя из результатов поиска');
  if(binding && Object.values(s.clients).some(other=>other.id!==clientId&&!other.mergedInto&&other.telegram?.peerId===binding.peerId)) throw Error('Эта переписка уже привязана к другой карточке');
  if(c.telegram?.peerId!==binding?.peerId){c.telegramOpenedAt=null;c.telegramCheck=null;}
  c.telegram=binding===null?null:clone(binding);
  event(s,binding?'telegram-linked':'telegram-unlinked',clientId,clientId);
}
export function addGoal(s,clientId,title,status='Желание клиента',sourceRecordId=null){title=String(title).trim();if(!s.clients[clientId]||!title||title.length>500||!GOAL_STATUSES.includes(status))throw Error('Проверь цель');const existing=Object.values(s.goals).find(g=>g.clientId===clientId&&!g.deletedAt&&normalizeSearch(g.title)===normalizeSearch(title));if(existing){if(existing.status!==status){existing.status=status;existing.updatedAt=stamp();event(s,'goal-edited',clientId,existing.id,{sourceRecordId});}return existing;}const g={id:id('goal'),clientId,title,status,sourceRecordId,createdAt:stamp(),updatedAt:stamp(),deletedAt:null};s.goals[g.id]=g;event(s,'goal-created',clientId,g.id,{sourceRecordId});return g;}
export function defineRace(s,values){
  const race=raceDefinition(values);
  const existing=raceCatalog(s,{includeRecommended:true}).find(r=>r.id===race.id||sameRace(r,race));
  if(existing)return existing;
  event(s,'race-defined',null,race.id,{race});return race;
}
export function setRaceDistances(s,raceId,distances) {
  const race=raceById(s,raceId);
  if(!race)throw Error('Старт не найден');
  const clean=[...new Set(distances.map(value=>String(value).trim()).filter(Boolean))];
  if(clean.length>20||clean.some(value=>value.length>45))throw Error('Проверь список дистанций');
  event(s,'race-defined',null,raceId,{race:{...race,distances:clean}});
}
export function editGoal(s,goalId,title,status,classification){
  const g=s.goals[goalId];
  if(!g||!title?.trim()||title.length>500||!GOAL_STATUSES.includes(status))throw Error('Проверь цель');
  const before={title:g.title,status:g.status};
  if(classification)Object.assign(g,raceGoal(s,classification));
  g.title=title.trim();g.status=status;g.updatedAt=stamp();event(s,'goal-edited',g.clientId,g.id,{before});
}
export function deleteGoal(s,goalId,deleted=true){const g=s.goals[goalId];if(!g)throw Error('Цель не найдена');g.deletedAt=deleted?stamp():null;g.updatedAt=stamp();event(s,deleted?'goal-deleted':'goal-restored',g.clientId,g.id);}
export function createTask(s,clientId,title,options={}){if(!s.clients[clientId]||!title?.trim())throw Error('Введи действие');const {sourceRecordId=null}=options;const due=options.due||null;if(due&&!validDate(due))throw Error('Проверь срок');const existing=sourceRecordId&&Object.values(s.tasks).find(t=>t.sourceRecordId===sourceRecordId&&normalizeSearch(t.title)===normalizeSearch(title));if(existing)return existing;const t={id:id('task'),clientId,title:title.trim().slice(0,1000),due,lane:options.lane==='discussion'?'discussion':'current',needsReply:!!options.needsReply,waitDays:options.waitDays||s.settings.waitDays,phase:'todo',outboundCount:0,lastSentAt:null,checkOn:null,createdAt:stamp(),closedAt:null,sourceRecordId,linkedGoalId:options.linkedGoalId||null};s.tasks[t.id]=t;event(s,'task-created',clientId,t.id,{sourceRecordId});return t;}
export function completeTask(s,taskId,done=true){const t=s.tasks[taskId];if(!t)throw Error('Задача не найдена');if((t.phase==='done')===done)return;t.phase=done?'done':t.lastSentAt?'waiting':'todo';t.closedAt=done?stamp():null;event(s,done?'task-closed':'task-reopened',t.clientId,t.id);}
export function editTask(s,taskId,title,due=null,linkedGoalId=undefined){
  const t=s.tasks[taskId];if(!t)throw Error('Задача не найдена');
  if(typeof title!=='string'||!title.trim()||title.trim().length>1000)throw Error('Введи действие · не более 1000 символов');
  if(due!==null&&!validDate(due))throw Error('Проверь дату');
  if(linkedGoalId && s.goals[linkedGoalId]?.clientId!==t.clientId)throw Error('Выбери цель этого клиента');
  title=title.trim();if(t.title===title&&t.due===due&&(linkedGoalId===undefined||linkedGoalId===t.linkedGoalId))return;
  const before={title:t.title,due:t.due};t.title=title;t.due=due;t.updatedAt=stamp();
  if(linkedGoalId!==undefined)t.linkedGoalId=linkedGoalId;
  event(s,'task-edited',t.clientId,t.id,{before,after:{title,due}});
}
export const pauseTaskId = clientId => 'pause-' + clientId;
export function clientTasks(s,clientId=null){
  const tasks=openTasks(s,{clientId,lane:'all'}).filter(t=>s.clients[t.clientId]&&!s.clients[t.clientId].mergedInto);
  const followUps=pauseContacts(s).filter(c=>!clientId||c.id===clientId).map(c=>({
    id:pauseTaskId(c.id),clientId:c.id,title:'Связаться после паузы',due:c.pause.contactOn,phase:'todo',needsReply:false,pauseContact:true
  }));
  return [...tasks,...followUps].sort((a,b)=>(taskDate(a)||'9999').localeCompare(taskDate(b)||'9999'));
}
export function taskGoal(s,task){
  if(task.linkedGoalId)return s.goals[task.linkedGoalId];
  if(task.lane!=='discussion')return null;
  const title=normalizeSearch(task.title);
  const matches=Object.values(s.goals).filter(g=>{
    if(g.clientId!==task.clientId||g.deletedAt)return false;
    const name=normalizeSearch(g.title.split(' · ')[0]);
    return name.length>=8&&title.includes(name);
  });
  return matches.length===1?matches[0]:null;
}
export function completePauseContact(s,clientId){
  const c=s.clients[clientId];
  if(!c?.pause?.contactOn)return;
  const due=c.pause.contactOn;
  c.pause.contactOn=null;
  event(s,'pause-contact-completed',clientId,pauseTaskId(clientId),{text:'Связаться после паузы',due});
}
export function markSent(s,taskId,at=stamp(),messageKey=null){const t=s.tasks[taskId];if(!t||t.phase==='done'||!t.needsReply)throw Error('Задача не ожидает переписки');if(messageKey&&s.events.some(e=>e.type==='outbound'&&e.messageKey===messageKey&&e.entityId===taskId))return;const previous=t.lastSentAt?Date.parse(t.lastSentAt):0;if(!messageKey&&Date.parse(at)-previous<2500)return;t.lastSentAt=at;t.phase='waiting';t.lane='current';t.outboundCount++;t.checkOn=addDays(localDate(new Date(at)),t.waitDays);event(s,'outbound',t.clientId,t.id,{at,messageKey,source:messageKey?'telegram':'coach-mark'});}
export function scheduleTask(s,taskId,due){const t=s.tasks[taskId];if(!t||!validDate(due))throw Error('Выбери дату');t.due=due;t.lane='current';event(s,'task-scheduled',t.clientId,t.id,{due});}
export function setWait(s,taskId,days,globalDefault=false){const t=s.tasks[taskId];if(!t||!Number.isInteger(days)||days<1||days>30)throw Error('Укажи от 1 до 30 дней');t.waitDays=days;if(t.phase==='waiting'&&t.lastSentAt)t.checkOn=addDays(localDate(new Date(t.lastSentAt)),days);if(globalDefault)s.settings.waitDays=days;event(s,'task-wait-edited',t.clientId,t.id,{days,globalDefault});}
export function taskDate(t){return t.phase==='waiting'?t.checkOn:t.due;}
export function openTasks(s,{filter='all',clientId=null,lane='current'}={}){return Object.values(s.tasks).filter(t=>t.phase!=='done'&&(lane==='all'||t.lane===lane)&&(!clientId||t.clientId===clientId)&&(filter==='all'||(filter==='reply')===t.needsReply)).sort((a,b)=>(taskDate(a)||'9999').localeCompare(taskDate(b)||'9999')||a.createdAt.localeCompare(b.createdAt));}
export function taskWarning(t,today=localDate()){if(t.phase!=='waiting'||!t.checkOn||t.checkOn>today)return null;if(t.outboundCount>=3)return {level:'danger',text:'Задача остаётся открытой после нескольких сообщений · проверь переписку'};if(t.outboundCount>=2)return {level:'warning',text:'Повторная проверка переписки'};return null;}
export function saveRecord(s,clientId,text,kind='record',recordId=id('record')){if(!s.clients[clientId]||!text?.trim()||text.length>16000)throw Error('Введи запись');if(s.records[recordId])return s.records[recordId];const r={id:recordId,clientId,text:text.trim(),kind,createdAt:stamp(),status:'saved',result:null};s.records[r.id]=r;event(s,'record-created',clientId,r.id);return r;}
export function addFeature(s,clientId,text,kind='Сейчас',sourceRecordId=null){const c=s.clients[clientId];if(!c||!text?.trim())throw Error('Введи особенность');if(c.features.some(f=>f.active!==false&&normalizeSearch(f.text)===normalizeSearch(text)))return;const f={id:id('feature'),kind,text:text.trim(),active:true,sourceRecordId,createdAt:stamp()};c.features.push(f);event(s,'feature-created',clientId,f.id);return f;}
export function editFeature(s, clientId, featureId, text, kind) {
  const feature = s.clients[clientId]?.features.find(f => f.id === featureId);
  if (!feature) throw Error('Особенность не найдена');
  const note = text.trim();
  if (!note) throw Error('Введи особенность');
  if (feature.text === note && feature.kind === kind) return;

  const before = { text: feature.text, kind: feature.kind };
  feature.text = note;
  feature.kind = kind;
  event(s, 'feature-edited', clientId, featureId, { text: note, before });
}
export function setFeatureActive(s,clientId,featureId,active){const f=s.clients[clientId]?.features.find(f=>f.id===featureId);if(!f)throw Error('Особенность не найдена');f.active=active;event(s,active?'feature-restored':'feature-archived',clientId,featureId);}
export function confirmedContact(s,clientId,{at=stamp(),channel='Telegram',direction='out',source='coach',messageKey=null}={}){const c=s.clients[clientId];if(!c)throw Error('Клиент не найден');if(messageKey&&s.events.some(e=>e.type==='contact'&&e.messageKey===messageKey))return;if(!c.lastContact||Date.parse(at)>=Date.parse(c.lastContact.at))c.lastContact={at,channel,direction,source};event(s,'contact',clientId,clientId,{at,channel,direction,source,messageKey});}
export function processManualRecord(s,recordId,options={}){const r=s.records[recordId];if(!r)throw Error('Запись не найдена');if(r.status==='processed')return r.result;const changes=[];if(r.kind==='goal'){const g=addGoal(s,r.clientId,r.text,options.goalStatus||'Желание клиента',r.id);if(options.goalType)Object.assign(g,raceGoal(s,{type:options.goalType}));changes.push({type:'goal',id:g.id,title:g.title});}else if(r.kind==='task'){const t=createTask(s,r.clientId,r.text,{...options,sourceRecordId:r.id});changes.push({type:'task',id:t.id,title:t.title});}r.status='processed';r.result={mode:'manual',changes};return r.result;}
export function applyAgentResult(s,recordId,result,{goalType}={}){
  const r=s.records[recordId];if(!r)throw Error('Запись не найдена');if(r.status==='processed')return r.result;
  if(!result||!Array.isArray(result.changes)||result.changes.length>30)throw Error('Агент вернул некорректный результат');
  const draft=clone(s),record=draft.records[recordId],changes=[];
  for(const change of result.changes){
    if(typeof change.title!=='string'||!change.title.trim()||change.title.length>1000)throw Error('Проверь результат агента');
    if(change.type==='task'){const t=createTask(draft,r.clientId,change.title,{due:change.due||null,lane:change.lane,needsReply:change.needsReply,sourceRecordId:r.id});changes.push({type:'task',id:t.id,title:t.title});}
    else if(change.type==='goal'){let g;if(change.id){g=draft.goals[change.id];if(!g||g.clientId!==r.clientId)throw Error('Агент указал чужую цель');editGoal(draft,g.id,change.title,change.status);}else g=addGoal(draft,r.clientId,change.title,change.status,r.id);if(record.kind==='goal'&&goalType&&g.type!==goalType)Object.assign(g,raceGoal(draft,{type:goalType}));changes.push({type:'goal',id:g.id,title:g.title});}
    else if(change.type==='feature'){const f=addFeature(draft,r.clientId,change.title,change.kind||'Сейчас',r.id);if(f)changes.push({type:'feature',id:f.id,title:f.text});}
    else throw Error('Неизвестная операция агента');
  }
  record.status='processed';record.result={mode:'agent',changes,summary:String(result.summary||'').slice(0,1000)};validateState(draft);Object.assign(s,draft);return record.result;
}
export function parseImport(text){if(typeof text!=='string'||text.length>8*1024*1024)throw Error('Файл слишком большой');const raw=JSON.parse(text);if(raw?.format!=='the-trail-clients-backup'||raw.schemaVersion!==SCHEMA||!raw.state)throw Error('Это не файл базы THE.TRAIL Clients');delete raw.state.cloudSync;return validateState(raw.state);}
export function exportState(s){validateState(s);const {cloudSync,...backup}=s;return JSON.stringify({format:'the-trail-clients-backup',schemaVersion:SCHEMA,exportedAt:stamp(),state:backup},null,2);}
export function mergeState(current,incoming){validateState(incoming);const next=clone(current);for(const name of ['clients','goals','tasks','records'])for(const [key,value] of Object.entries(incoming[name]))if(!next[name][key])next[name][key]=clone(value);const events=new Set(next.events.map(e=>e.id));for(const e of incoming.events)if(!events.has(e.id)){next.events.push(clone(e));events.add(e.id);}next.events.sort((a,b)=>a.at.localeCompare(b.at));mergeAccounting(next,incoming);if(!next.ledger&&incoming.ledger)next.ledger=clone(incoming.ledger);return validateState(next);}
