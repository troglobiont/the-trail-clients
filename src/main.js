import * as C from './core.js';
import { assistantKind, mentionsCompletedSession, suggestAssistantClients } from './assistant.js';
import { CURRENCIES, TARIFF_LABELS, activeService, amountMinor, clientPaymentStatuses, clientServices, matchingTariffClients, serviceBalance, tariffLabel } from './accounting.js';
import {createStore,browserAdapter} from './store.js';
import {createUpdater} from './updates.js';
import {currentServiceOrigin,parseConnection} from './connection.js';
import {createRecipientSearch} from './telegram-picker.js';
import {failedTelegramAttempt,prepareTelegramAttempt,sameTelegramDestination,telegramDeliveryNotice} from './telegram-delivery.js';
import {microphoneAccess,microphoneState} from './microphone.js';
import {createAccountingUI} from './accounting-ui.js';
import {applyLedger, LEDGER_FORMAT, parseLedgerImport} from './ledger-import.js';
import {createCloudAPI} from './cloud-api.js';
import {createCloudSync} from './cloud-sync.js';
import {createClientDetailsUI} from './client-details-ui.js';
import {birthdayGreeting,birthdayReminders,pingActivity,profileTelegramUsername,telegramLink,telegramReminders,GOAL_TYPES} from './client-details.js';
import {cloudConfig} from './cloud-config.js';
import {CALENDAR_ARCHIVE_ROUTE,CALENDAR_ARCHIVE_SECTION,CALENDAR_UPCOMING_SECTION,createCalendarUI,isSchedulingTask} from './calendar-ui.js';
import {createTrainingWeekUI,TRAINING_WEEK_ROUTE} from './training-week-ui.js';
import {createTrainingCalendarUI} from './training-calendar-ui.js';
import {todoPeriodEntries} from './todo-period.js';
import {createPartnersUI} from './partners-ui.js';
import {partnerTasks} from './partners.js';
import {syncIndicatorState,cloudIcon,settingsWheel} from './sync-indicator.js';
import {createAdminUI} from './admin-ui.js';
import {createAthleteUI} from './athlete-ui.js';
import {createSportLogUI} from './sport-log-ui.js';
import {inlineSelect} from './inline-select.js';
import {goalProposal} from './goal-record.js';
import {garminSnapshot,mergeGarminSnapshot} from './garmin-data.js';
import {assignedCoach,coachContact,hasFinance,isAthlete,isOwnerPerson,isPaymentText,OWNER_COACH,previewAthlete,
  previewAthletes,previewCoaches,previewRoute,previewTaskVisible,previewTrainingVisible,ROLES} from './role-preview.js';
const VERSION=__APP_VERSION__;
const root=document.getElementById('app'),notice=document.getElementById('notice'),dialog=document.getElementById('editor');
let store,updater,cloud,cloudReady,noticeTimer,draftTimer,localSaves=0,localSaveError=false,headerBound=false;
const catalogViews = { active:'Клиенты', occasional:'Разовые', paused:'На паузе', archive:'Архив', team:'Команда', pending:'До старта' };
const planBasisLabel = basis => basis === 'С нуля' ? 'Вне когорты' : basis;
const planBasisOptions = C.BASES.map(basis=>[basis,planBasisLabel(basis)]);
const CATALOG_PAGE_SIZE = 12;
const CLIENTS_DOUBLE_TAP_MS = 450;
const paymentFilters = [['all','Оплаты'],['paid','Оплачено'],['pending','К оплате'],['overdue','Просрочено']];
const defaultFilters=()=>({query:'',format:'all',quick:'all',basis:'all',level:'all',personal:'all',
  packageFilter:'all',tariffCurrency:'all',paymentCurrency:'all',paymentMonth:C.localDate().slice(0,7),paymentStatus:'all'});
const ui={role:'superadmin',previewCoachId:OWNER_COACH,previewAthleteId:null,filters:defaultFilters(),catalogScope:'active',pauseFilter:null,catalogLimit:CATALOG_PAGE_SIZE,
  contactOrder:false, recentlyCompleted:new Set(), birthdayPeriod:7, paymentPeriod:-1,taskPeriod:null,scheduleKind:null,returnTo:'#clients',open:new Set([CALENDAR_UPCOMING_SECTION]),drafts:{},birthdayDrafts:new Map(),sendAck:{},recordResults:{},busy:new Set(),update:{status:'idle'}};
const state=()=>store.state();
const ownAthlete=()=>previewAthlete(state(),ui.previewAthleteId);
const roleContext=()=>({role:ui.role,coachId:ui.previewCoachId,athleteId:isAthlete(ui.role)?ownAthlete()?.id:null});
const canReadGroupWeek=()=>['superadmin','coach'].includes(ui.role);
const visibleTask=task=>previewTaskVisible(task,roleContext());
const hasAthleteCard=client=>client?.role==='Клиент'||Boolean(client?.athlete);
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined&&text!==null)node.textContent=text;if(className)node.className=className;return node;}
function append(parent,...children){parent.append(...children.filter(Boolean));return parent;}
function button(text,fn,className=''){const b=el('button',text,className);b.type='button';b.addEventListener('click',()=>run(async()=>{b.disabled=true;try{await fn();}finally{if(b.isConnected)b.disabled=false;}}));return b;}
function message(value,error=false,action=null){
  clearTimeout(noticeTimer);notice.replaceChildren(el('span',value));notice.className='notice'+(error?' error':'');
  if(action)notice.append(button(action.label,async()=>{await action.run();clearTimeout(noticeTimer);notice.hidden=true;},'notice-action'));
  notice.hidden=false;noticeTimer=setTimeout(()=>{notice.hidden=true;},action||error?9000:4500);
}
async function run(fn){try{await fn();}catch(e){message(e.message||'Операция не выполнена',true);}}
async function commit(fn,redraw=true){
  if(!localSaves)localSaveError=false;
  localSaves++;renderCloudStatus();
  try{const value=await store.mutate(fn);if(redraw)render();return value;}
  catch(e){localSaveError=true;throw e;}
  finally{localSaves--;renderCloudStatus();}
}
function row(...items){return append(el('div',null,'row'),...items);}
function text(text,className='muted small'){return el('div',text,className);}
function field(label,input){return append(el('label',label),input);}
function input(type='text',value='',placeholder=''){const i=el('input');i.type=type;i.value=value;i.placeholder=placeholder;return i;}
function select(values,value){const s=el('select');for(const item of values){const [v,label]=Array.isArray(item)?item:[item,item],o=el('option',label);o.value=v;s.append(o);}s.value=value;return s;}
function clientStatus(c) {
  if (c.role !== 'Клиент') return C.clientRole(c);
  if (C.clientSection(c) === 'occasional') return 'Разово';
  if (c.status === 'На паузе' && C.pauseGroup(c) === 'returning') return 'На паузе · к возврату';
  return c.status;
}
function chips(c){const list=el('span',null,'row');for(const value of c.role==='Клиент'?[clientStatus(c),c.format,'Основа: '+planBasisLabel(c.basis)]:[C.clientRole(c)])list.append(el('span',value,'chip'));if(c.level==='Премиум')list.append(el('span','Премиум','chip emphasis'));if(['gym','outside'].includes(c.personal))list.append(el('span',c.personal==='gym'?'Персональный зал с Сергеем':'Персонально с Сергеем · улица','chip emphasis'));return list;}
function formatDate(iso,withTime=false){if(!iso)return '';return new Intl.DateTimeFormat('ru-RU',{timeZone:C.TIMEZONE,day:'numeric',month:'short',...(withTime?{hour:'2-digit',minute:'2-digit'}:{})}).format(new Date(iso.length===10?iso+'T12:00:00Z':iso));}
function section(title,key,children){const d=el('details',null,'fold'),summary=el('summary',title);d.open=ui.open.has(key);d.addEventListener('toggle',()=>{if(d.open)ui.open.add(key);else ui.open.delete(key);});append(d,summary,append(el('div',null,'fold-body stack'),...children));return d;}
function navigate(hash){location.hash=hash;}
function openClient(clientId,type,target){ui.returnTo=location.hash.startsWith('#client/')?ui.returnTo:location.hash||'#todo';navigate('#client/'+clientId+(type?'/'+type+(target?'/'+target:''):''));}
const detailsUI=createClientDetailsUI({state,ui,el,append,button,row,field,input,select,text,section,modal,commit,render,formatDate,openClient,message,focusCard,
  openAthleteEntry:(c,id)=>athleteUI.openEntry(c,id)});
const accountingUI=createAccountingUI({state,el,append,button,row,field,input,select,text,section,modal,commit,render,formatDate,navigate,message,importLedger:()=>importDatabase(true),
  searchClients:query=>C.filterClients(state(),{query,role:'Клиент'}),
  activateClient:(s,id,day)=>C.editClient(s,id,{status:'Активный',engagement:null,pause:null},day),
  pauseClientTariff:C.pauseClientTariff,
  openClient(clientId){ui.open.add(clientId+'-account');openClient(clientId);}
});
const scheduleRoute='#todo/schedule';
const trainingCalendarUI=createTrainingCalendarUI({state,el,append,text,button,row,formatDate,modal,navigate,message,save:fn=>commit(fn),
  readPersonalWeek:(clientId,weekStart)=>calendarUI.personalWeek(clientId,weekStart),
  readWeek:async(clientId,prepared)=>{
    await cloudReady;
    if(!cloud||cloud.state().status==='disconnected')return null;
    return cloud.trainingWeek(clientId,prepared);
  },
  publishWeek:(clientId,week)=>cloud.publishTrainingWeek(clientId,week)
});
const trainingWeekUI=createTrainingWeekUI({state,el,append,text,button,row,formatDate,modal,navigate,message,
  save:fn=>commit(fn),weekPanel:trainingCalendarUI.weekPanel,
  readGroupWeek:async day=>{
    await cloudReady;
    if(!cloud||cloud.state().status==='disconnected')return null;
    return cloud.groupWeek(day);
  }});
const calendarUI=createCalendarUI({state,service,roleContext,el,append,button,row,field,input,select,text,section,modal,commit,formatDate,navigate,openClient,message,
  readCalendar:async(from,to)=>{
    await cloudReady;
    if(!cloud)throw Error('Подключи облачную синхронизацию для расписания');
    return cloud.calendar({from,to,includeGroups:true});
  },
  saveCalendar:value=>store.mutate(s=>{s.settings.calendarCache=value;},{trackCloud:false}),
  searchClients:query=>C.filterClients(state(),{query,role:'Клиент'}),
  scheduledSession:accountingUI.scheduledSession,addScheduledTariff:accountingUI.addScheduledTariff,groupProtocol:trainingWeekUI.groupProtocol});
const partnersUI=createPartnersUI({state,el,append,button,row,text,field,input,select,section,modal,commit,navigate,formatDate,message,
  openList:()=>{ui.open.add('admin-partners');navigate('#admin');}});
const adminUI=createAdminUI({state,ui,el,append,button,row,text,field,input,select,section,modal,commit,navigate,openClient,render,formatDate,partnersUI});
const logUI=createSportLogUI({el,append,button,row,text,section,modal,commit,input,select,field,navigate,formatDate,garminData});
const athleteUI=createAthleteUI({ui,el,append,button,text,section,navigate,logUI,garminData,
  renderRestrictions:c=>renderFeatures(c,{embedded:true})});
function modal(title,build,{saveLabel='Сохранить',saveClass='primary',cancelLabel='Отмена',onSaved}={}){
  dialog.textContent='';
  const form=el('form'),heading=el('h2',title),error=text('','form-error');
  heading.id='editor-title';error.setAttribute('role','alert');form.append(heading);
  let save;
  const saveControl=saveLabel&&button(saveLabel,async()=>{
    try{await save();dialog.close();onSaved?.();}catch(e){error.textContent=e.message;}
  },saveClass);
  save=build(form,enabled=>{if(saveControl)saveControl.disabled=!enabled;error.textContent='';});
  const controls=row(button(cancelLabel,()=>dialog.close()),saveControl);
  form.addEventListener('submit',e=>{e.preventDefault();if(saveControl&&!saveControl.disabled)saveControl.click();});
  append(form,error,controls);dialog.append(form);
  if(dialog.open)(form.querySelector('[autofocus]')||form.querySelector('select,input,button'))?.focus();
  else dialog.showModal();
  dialog.scrollTop=0;
}

const cloudLabels={working:'Синхронизация…',synced:'Синхронизировано',pending:'Ждёт синхронизации',conflict:'Нужно выбрать версию',error:'Ждёт синхронизации'};
function renderCloudStatus(){
  if(!store)return;
  const view=cloud?.state();
  const pending=state().cloudSync&&Object.keys(state().cloudSync.pending).length;
  const indicator=syncIndicatorState({view,pending,online:navigator.onLine,saving:localSaves>0,saveError:localSaveError});
  const control=document.getElementById('sync-now'),status=document.getElementById('save-status'),icon=document.getElementById('sync-icon');
  const checked=view?.checkedAt||state().cloudSync?.syncedAt;
  const hint=[indicator.label,indicator.detail,checked&&'Последняя проверка: '+formatDate(checked,true),indicator.action].filter(Boolean).join('. ');
  control.dataset.status=indicator.status;control.disabled=indicator.disabled;control.title=hint;control.setAttribute('aria-label',hint);
  if(status.textContent!==indicator.label)status.textContent=indicator.label;
  if(icon.dataset.icon!==indicator.icon){icon.dataset.icon=indicator.icon;icon.replaceChildren(cloudIcon(document,indicator.icon));}
  renderCloudPanel();
}
function openCloudSettings(){
  ui.open.add('settings-cloud');
  ui.focusCloudPanel=true;
  if(location.hash==='#settings')render();else navigate('#settings');
}
async function syncFromHeader(){
  if(localSaveError){message('Предыдущее изменение не сохранено. Повтори его ввод.',true);return;}
  const view=cloud?.state();
  if(!cloud||view.status==='disconnected'){openCloudSettings();return;}
  if(view.status==='conflict'){cloudConflict();return;}
  await cloud.sync();
  const result=cloud.state();
  if(result.status==='conflict')cloudConflict();
  else if(result.status==='error'||result.status==='disconnected')message(result.error||'Синхронизация недоступна',true,
    {label:'Подробнее',run:openCloudSettings});
  else if(result.status==='synced')message('Всё синхронизировано');
  else message('Изменения ждут синхронизации');
}
function bindHeaderControls(){
  if(headerBound)return;
  document.querySelector('.gear-link').replaceChildren(settingsWheel(document));
  document.getElementById('sync-icon').replaceChildren(cloudIcon(document));
  document.getElementById('sync-now').addEventListener('click',()=>run(syncFromHeader));
  const switcher=document.getElementById('role-switch');
  document.addEventListener('click',event=>{if(!switcher.contains(event.target))switcher.open=false;});
  switcher.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&switcher.open){switcher.open=false;switcher.querySelector('summary').focus();}
  });
  window.addEventListener('offline',renderCloudStatus);
  window.addEventListener('online',renderCloudStatus);
  headerBound=true;
}
function renderRoleSwitch(){
  const switcher=document.getElementById('role-switch'),menu=document.getElementById('role-menu');
  document.getElementById('current-role').textContent=ROLES[ui.role];
  document.querySelector('.header-controls').hidden=ui.role!=='superadmin';
  const choices=Object.entries(ROLES).map(([key,label])=>{
    const control=button(label,()=>{
      switcher.open=false;
      if(ui.role===key)return;
      ui.role=key;ui.returnTo=isAthlete(key)?'#profile':'#clients';
      ui.filters=defaultFilters();ui.focusRoute=null;ui.catalogLimit=CATALOG_PAGE_SIZE;
      notice.hidden=true;
      const next=['athlete','coach'].includes(key)?'#calendar':'#todo';
      if(location.hash===next)render();else navigate(next);
    },'role-choice');
    control.setAttribute('aria-pressed',String(ui.role===key));
    return control;
  });
  let person;
  if(ui.role==='coach'){
    const coach=select(previewCoaches(state()),ui.previewCoachId);
    coach.addEventListener('change',()=>{ui.previewCoachId=coach.value;switcher.open=false;render();});
    person=field('Тренер в просмотре',coach);
  }else if(isAthlete(ui.role)){
    const activeId=ownAthlete()?.id||'';
    const options=previewAthletes(state()).map(client=>[client.id,client.name]);
    if(!activeId)options.unshift(['','Выбрать спортсмена']);
    const athlete=inlineSelect(document,options,activeId,'Карточка в просмотре');
    athlete.element.addEventListener('change',()=>{
      if(!athlete.value)return;
      ui.previewAthleteId=athlete.value;ui.returnTo='#profile';switcher.open=false;
      switcher.querySelector('summary').focus();
      if(['#profile','#calendar'].includes(location.hash))render();else navigate('#calendar');
    });
    person=athlete.field;
  }
  menu.replaceChildren(...[text('Просмотр ролей'),...choices,person].filter(Boolean));
  const nav=document.querySelector('.app-nav');
  nav.dataset.role=ui.role;
  for(const link of nav.querySelectorAll('a')){
    link.hidden=(
      link.hash==='#clients'&&isAthlete(ui.role)||link.hash==='#profile'&&!isAthlete(ui.role)||
      link.hash==='#account'&&!hasFinance(ui.role)||link.hash==='#calendar'&&!['coach','athlete'].includes(ui.role)||
      link.hash==='#races'&&ui.role==='accountant'
    );
    if(link.hash==='#admin')link.textContent=isAthlete(ui.role)?'Ещё':'Админ';
  }
}
function cloudLogin(){
  modal('Подключить синхронизацию',form=>{
    const email=input('email');email.autocomplete='username';email.maxLength=254;
    const password=input('password');password.autocomplete='current-password';
    append(form,text('Карточки, задачи, занятия, оплаты и история учёта будут синхронизироваться с личным проектом The.Trail Clients в Supabase.'),
      field('Почта аккаунта приложения',email),field('Пароль аккаунта приложения',password));
    return async()=>{
      if(!email.value.trim()||!password.value)throw Error('Введи почту и пароль для приложения');
      await cloud.connect(email.value.trim(),password.value);
      password.value='';
    };
  });
}
function cloudConflict(){
  const snapshot=cloud.state();
  modal('Выбрать версию записей',form=>{
    const selections={};
    for(const conflict of snapshot.conflicts){
      const title=conflict.local?.name||conflict.remote?.name||conflict.local?.title||conflict.remote?.title||conflict.key;
      const versions=el('details');
      append(versions,el('summary','Посмотреть обе версии'),el('h3','Телефон'),el('pre',JSON.stringify(conflict.local,null,2)?.slice(0,1500)||'Запись удалена','cloud-version'),
        el('h3','Облако'),el('pre',JSON.stringify(conflict.remote,null,2)?.slice(0,1500)||'Запись удалена','cloud-version'));
      const pick=select([['','Выбрать версию'],['phone','Оставить с телефона'],['cloud','Взять из облака']],'');
      selections[conflict.key]=pick;
      append(form,field(title,pick),versions);
    }
    return ()=>{
      if(Object.values(selections).some(x=>!x.value))throw Error('Выбери версию для каждой записи');
      return cloud.sync({revision:snapshot.revision,choices:Object.fromEntries(Object.entries(selections).map(([k,x])=>[k,x.value]))});
    };
  });
}
function renderCloudPanel(){
  const panel=document.getElementById('cloud-panel');
  if(!panel)return;
  panel.replaceChildren();
  if(!cloud){panel.append(text('Доступна в Android-приложении.'));return;}
  const view=cloud.state();
  if(view.status==='disconnected'){
    append(panel,text(view.error||'Подключи личный аккаунт The.Trail Clients.'),row(button('Подключить синхронизацию',cloudLogin,'primary')));
    return;
  }
  append(panel,text(view.email),el('p',cloudLabels[view.status]),view.error&&text(view.error,'warning-text small'));
  if(view.checkedAt)panel.append(text('Последняя проверка: '+formatDate(view.checkedAt,true)));
  if(!navigator.onLine)panel.append(text('Нет сети. Изменения сохраняются на устройстве.','warning-text small'));
  const syncNow=view.status==='conflict'?button('Выбрать версию',cloudConflict):button('Синхронизировать сейчас',()=>cloud.sync());
  syncNow.disabled=view.status==='working';
  append(panel,row(syncNow,button('Выйти из облака',()=>cloud.disconnect(),'subtle')));
}
function startCloud(){
  const bridge=window.TrailNative;
  if(!bridge?.native||!bridge.cloudRequest)return;
  cloud=createCloudSync({store,api:createCloudAPI({...cloudConfig,request:options=>bridge.cloudRequest(options)}),
    vault:{load:()=>bridge.getSecret('cloudSession'),save:value=>bridge.setSecret('cloudSession',value)},
    onChange:renderCloudStatus,onReceive:render});
  const retry=async()=>{void checkGarminConnection?.();void refreshGarmin(garminRouteClient());await cloud.sync();await calendarUI.preload();};
  window.addEventListener('online',retry);
  window.addEventListener('trail-app-active',retry);
  setInterval(()=>{if(!document.hidden)retry();},45000);
  renderCloudStatus();
  cloudReady=cloud.restore();
  run(async()=>{await cloudReady;await calendarUI.preload();});
}
let garminFlight,garminAttempt,garminIssue,checkGarminConnection;
function garminData(client){
  const cache=state().settings.garminCache,owner=state().cloudSync?.owner;
  if(!owner||cache?.owner!==owner||cache.snapshot?.clientId!==client?.id)return null;
  try{
    const value=garminSnapshot(cache.snapshot,client.id);
    if(!value.activities||Object.values(value.measures).some(value=>value===null))return null;
    const missing=Array.isArray(cache.snapshot.missing)?cache.snapshot.missing.filter(value=>
      ['Тренировки','Сон','Ночная HRV','Пульс покоя'].includes(value)):[];
    return {...value,missing};
  }catch{return null;}
}
function garminRouteClient(hash=location.hash){
  if(hash.startsWith('#client/'))return state().clients[hash.split('/')[1]];
  if(isAthlete(ui.role)&&['#profile','#admin'].includes(hash))return ownAthlete();
  return null;
}
function refreshGarmin(client,manual=false){
  if(client?.role!=='Клиент'||client.mergedInto||!isOwnerPerson(client))return;
  if(garminFlight)return garminFlight;
  const cache=garminData(client);
  const attempted=garminAttempt?.clientId===client.id?garminAttempt.at:0;
  if(!manual&&(!cloud||Date.now()-attempted<5*60000||cache&&Date.now()-Date.parse(cache.asOf)<5*60000))return;
  garminAttempt={clientId:client.id,at:Date.now()};
  garminFlight=(async()=>{
    try{
      await cloudReady;
      const owner=state().cloudSync?.owner;
      if(!cloud||!owner)throw Error('Войди в облако The.Trail, чтобы обновлять Garmin.');
      const snapshot=garminSnapshot(await cloud.garmin(client.id),client.id);
      await store.mutate(s=>{
        if(s.cloudSync?.owner!==owner||s.clients[client.id]?.role!=='Клиент'||s.clients[client.id].mergedInto)return;
        const previous=garminData(client);
        s.settings.garminCache={owner,snapshot:mergeGarminSnapshot(previous,snapshot)};
      },{trackCloud:false});
      garminIssue=null;
    }catch(error){garminIssue={clientId:client.id,message:error.message||'Не удалось обновить Garmin'};}
  })().finally(()=>{
    garminFlight=null;
    if(garminRouteClient()?.id===client.id&&!dialog.open&&!document.activeElement?.matches('input,textarea,select'))render();
  });
  return garminFlight;
}
function garminPanel(client){
  const data=garminData(client),issue=garminIssue?.clientId===client.id?garminIssue.message:null;
  const status=text('');
  status.setAttribute('role','status');
  async function connection(action){
    await cloudReady;
    if(!cloud||!state().cloudSync?.owner)throw Error('Войди в облако The.Trail для подключения Garmin.');
    return cloud.garminConnection(client.id,action);
  }
  const connect=button('Подключить Garmin',async()=>{
    status.textContent='Открываю Garmin Connect…';
    try{
      const result=await connection('start');
      if(result.status==='unavailable')throw Error('Подключение Garmin Connect пока недоступно.');
      const url=new URL(result.url);
      if(result.status!=='authorizing'||url.origin!=='https://connect.garmin.com'||url.pathname!=='/oauth2Confirm'||
        url.username||url.password||url.hash||!url.searchParams.has('state'))throw Error('Не удалось открыть Garmin Connect.');
      status.textContent='Подтверди доступ в Garmin Connect и вернись в приложение.';
      window.location.assign(url.href);
    }catch(error){status.textContent=error.message;}
  },'primary');
  checkGarminConnection=async()=>{
    try{
      const result=await connection('status');
      if(result.status==='connected'){
        status.textContent='Garmin Connect подключён.';
        connect.textContent='Переподключить Garmin';
      }else{
        status.textContent=result.status==='ready'?'Подтверди доступ в Garmin Connect.':'Подключение Garmin Connect пока недоступно.';
        connect.textContent='Подключить Garmin';
      }
    }catch(error){status.textContent=error.message;}
  };
  void checkGarminConnection();
  return append(el('section',null,'panel stack'),el('h2','Garmin Connect'),status,connect,
    data&&text(issue||'Последняя загрузка · '+formatDate(data.asOf,true)),
    data?.missing.length&&text('Не обновились · '+data.missing.join(', '),'warning-text small'),
    data&&row(button('Тренировки Garmin',()=>{
      ui.open.add(client.id+'-garmin-activities');openClient(client.id,'load');
    },'subtle'),button('Обновить Garmin',()=>refreshGarmin(client,true),'subtle')));
}
function athleteSourcesPage(client){
  const calendar=append(el('section',null,'panel stack'),el('h2','Google Календарь'),
    text('Личный тренировочный календарь можно будет подключить позже.'));
  const later=append(el('div',null,'stack'),
    append(el('div',null,'row between'),el('strong','COROS'),text('Пока недоступно')),
    append(el('div',null,'row between'),el('strong','Suunto'),text('Пока недоступно')),
    append(el('div',null,'row between'),el('strong','Apple Watch'),text('Потребуется версия для iPhone')));
  return append(el('div',null,'stack-lg athlete-sources'),
    button('← К профилю',()=>navigate('#profile'),'back subtle'),
    el('h1','Источники данных'),text(client.name),garminPanel(client),calendar,later);
}
function pauseEditor(client) {
  const group = select(Object.entries(C.PAUSE_GROUPS),C.pauseGroup(client ?? {}));
  const returnWindow = input('text',client?.pause?.returnWindow || '','Например, в январе');
  returnWindow.maxLength = 140;
  const contactOn = input('date',client?.pause?.contactOn || '');
  const element = append(el('div',null,'stack'),field('Группа паузы',group),field('Ориентир возврата',returnWindow),field('Связаться',contactOn));
  const values = () => ({kind:returnWindow.value.trim() ? 'planned' : 'open',returning:group.value === 'returning',
    returnWindow:returnWindow.value.trim(),contactOn:contactOn.value || null});
  return {element,values};
}

function editClient(clientId=null) {
  const c = clientId ? state().clients[clientId] : null;
  modal(c ? 'Данные клиента' : 'Новый клиент', form => {
    const name = input('text', c?.name || '');
    name.maxLength = 180;
    const role = select(['Клиент','Тренер','Организатор'], c ? C.clientRole(c) : 'Клиент');
    const status = select([...C.STATUSES, ['occasional','Разово']], c?.engagement === 'occasional' ? 'occasional' : C.STATUSES.includes(c?.status) ? c.status : 'Активный');
    const pause = pauseEditor(c);
    const pauseFields = pause.element;
    const coach=select(previewCoaches(state()),c?assignedCoach(state(),c):OWNER_COACH);
    const coachField=field('Ведущий тренер',coach);
    const date = input('date', C.localDate());
    date.max = C.localDate();
    const effective = field('Дата изменения статуса',date);
    const statusField = field('Статус сотрудничества',status);
    form.append(field('Фамилия Имя',name));
    const classification=el('div',null,'stack');
    append(classification,field('Роль',role),statusField,pauseFields,coachField);
    const controls = {
      format:select(['Очно','Дистанционно','Уточнить'],c?.format||'Уточнить'),
      basis:select(planBasisOptions,c?.basis||'Сейчас плана нет'),
      level:select(['Обычное','Премиум'],c?.level||'Обычное'),
      group:select(['Да','Нет','Уточнить'],c?.group||'Уточнить'),
      personal:select([['none','Нет'],['gym','В зале'],['outside','На улице'],['unknown','Нужно уточнить']],c?.personal||'unknown'),
      currentFormat:select([['','Нет временного изменения'],['Очно','Временно очно'],['Дистанционно','Временно онлайн']],c?.currentFormat||'')
    };
    const labels = {format:'Обычный формат',basis:'Основа плана',level:'Ведение',group:'Групповые с Сергеем',personal:'Персональные с Сергеем',currentFormat:'Формат сейчас'};
    for (const [key,control] of Object.entries(controls)) classification.append(field(labels[key],control));
    const context=el('textarea');context.value=c?.context||'';context.rows=2;
    const rules=el('textarea');rules.value=(c?.rules||[]).join('\n');rules.rows=3;
    append(classification,effective,field('Контекст',context),field('Правила плана · по одному на строку',rules));
    const fold=section('Классификация',(c?.id||'new')+'-classification',[classification]);
    if(!c)fold.open=true;
    form.append(fold);
    const profileEditor = c ? null : detailsUI.profileEditor();
    if(profileEditor) append(form,el('h3','О клиенте'),profileEditor.element);
    const actualStatus = () => status.value === 'occasional' ? 'Активный' : status.value;
    const syncFields = () => {
      const isClient = role.value === 'Клиент';
      statusField.hidden = !isClient;
      coachField.hidden = !isClient;
      pauseFields.hidden = !isClient || status.value !== 'На паузе';
      effective.hidden = !isClient || c?.role === 'Клиент' && actualStatus() === c.status;
      profileEditor?.requireFields(isClient);
    };
    role.addEventListener('change',syncFields);
    status.addEventListener('change',syncFields);
    syncFields();
    return () => {
      const isClient = role.value === 'Клиент';
      const values = {
        ...Object.fromEntries(Object.entries(controls).map(([key,control])=>[key,control.value])),
        name:name.value.trim(), context:context.value.trim(), rules:rules.value.split('\n').map(r=>r.trim()).filter(Boolean), role:isClient ? 'Клиент' : 'Тренер', teamRole:role.value === 'Организатор' ? 'Организатор' : null,
        status:isClient ? actualStatus() : 'Тренер', currentFormat:controls.currentFormat.value || null,
        engagement:isClient && status.value === 'occasional' ? 'occasional' : null,
        coachId:isClient&&coach.value!==OWNER_COACH?coach.value:null,
        pause:!pauseFields.hidden ? pause.values() : null
      };
      if (!values.name) throw Error('Введи имя');
      if (profileEditor) values.profile = profileEditor.values();
      return commit(s=>c ? C.editClient(s,c.id,values,date.value) : C.createClient(s,values,date.value));
    };
  });
}

function clearCatalogSearch() {
  const search = document.getElementById('catalog-search-input');
  if (search) {
    search.value = '';
    search.dispatchEvent(new Event('input'));
  } else {
    ui.filters.query = '';
    ui.catalogLimit = CATALOG_PAGE_SIZE;
  }
}

function bindClientsTab() {
  const tab = document.querySelector('.app-nav a[href="#clients"]');
  let previousTap = -Infinity;
  document.addEventListener('click',event=>{
    if (!tab.contains(event.target) || event.detail === 0 || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      previousTap = -Infinity;
      return;
    }
    if (event.timeStamp - previousTap > CLIENTS_DOUBLE_TAP_MS) {
      previousTap = event.timeStamp;
      return;
    }
    previousTap = -Infinity;
    clearCatalogSearch();
  });
}

function renderCatalog(scope) {
  if (scope !== ui.catalogScope) {
    ui.catalogScope = scope;
    ui.filters = defaultFilters();
    ui.catalogLimit = CATALOG_PAGE_SIZE;
    ui.pauseFilter = null;
  }
  const page = el('div',null,'stack catalog-page');
  if (scope !== 'active') page.append(button('← К активным клиентам',()=>navigate('#clients'),'back subtle'));
  page.append(append(el('div',null,'page-title'),el('h1',catalogViews[scope]),
    hasFinance(ui.role)&&scope === 'active' && Object.keys(state().clients).length && button('Добавить клиента',()=>editClient(),'subtle')));
  if (!Object.keys(state().clients).length) {
    page.append(hasFinance(ui.role)?emptyDatabase():text('Клиенты пока не добавлены.'));
    return page;
  }

  const search = input('search',ui.filters.query,'Поиск (фамилия имя)');
  search.id = 'catalog-search-input';
  search.setAttribute('aria-label','Поиск (фамилия имя)');
  search.maxLength = 100;
  const clear = button('×',clearCatalogSearch,'catalog-search-clear');
  clear.setAttribute('aria-label','Очистить поиск');
  clear.hidden = !search.value;
  function updateSearch(){
    clear.hidden = !search.value;
    ui.filters.query = search.value;
    ui.catalogLimit = CATALOG_PAGE_SIZE;
    renderCatalogResults();
  }
  search.addEventListener('input',updateSearch);
  const searchField = append(el('div',null,'catalog-search'),search,clear);
  page.append(scope === 'active' ? activeCatalogFilters(searchField) : searchField);
  if (scope === 'paused') page.append(pauseFilters());
  const list = el('div',null,'client-directory');
  list.id = 'client-tiles';
  page.append(list);

  if (scope === 'active') {
    const links = el('nav',null,'catalog-sections');
    links.setAttribute('aria-label','Другие списки клиентов');
    const counts = {};
    for (const c of Object.values(state().clients)) {
      const key = C.clientSection(c);
      if (key) counts[key] = (counts[key] || 0) + 1;
    }
    for (const key of ['occasional','paused','archive','team','pending']) {
      const link = button('',()=>navigate('#clients/'+key),'catalog-section-link');
      append(link,el('span',catalogViews[key]),el('span',String(counts[key] || 0),'muted'),el('span','›','muted'));
      links.append(link);
    }
    const more=section('Другие категории','catalog-other',[links]);
    more.classList.add('catalog-other');page.append(more);
  }
  return page;
}

function pauseFilters() {
  const filters = el('div',null,'row catalog-quick');
  filters.setAttribute('role','group');
  filters.setAttribute('aria-label','Группа паузы');
  const paused = C.filterClients(state(),{ section:'paused' });
  for (const [key,label] of Object.entries(C.PAUSE_GROUPS)) {
    const count = paused.filter(c=>C.pauseGroup(c) === key).length;
    const control = button(label + ' · ' + count,()=>{
      ui.pauseFilter = ui.pauseFilter === key ? null : key;
      ui.catalogLimit = CATALOG_PAGE_SIZE;
      for (const item of filters.children) item.setAttribute('aria-pressed',String(item.dataset.pause === ui.pauseFilter));
      renderCatalogResults();
    });
    control.dataset.pause = key;
    control.setAttribute('aria-pressed',String(ui.pauseFilter === key));
    filters.append(control);
  }
  return filters;
}

function activeCatalogFilters(searchField) {
  const quick = el('div',null,'row catalog-quick catalog-shortcuts');
  quick.setAttribute('role','group');
  quick.setAttribute('aria-label','Быстрые фильтры');
  for (const [value,label] of [['Дистанционно','Онлайн'],['Очно','Очно'],['gym','Зал']]) {
    const control = button(label,()=>{
      ui.filters.quick = ui.filters.quick === value ? 'all' : value;
      ui.catalogLimit = CATALOG_PAGE_SIZE;
      for (const b of quick.querySelectorAll('[data-quick]')) b.setAttribute('aria-pressed',String(b.dataset.quick === ui.filters.quick));
      renderCatalogResults();
    });
    control.dataset.quick = value;
    control.setAttribute('aria-pressed',String(ui.filters.quick === value));
    quick.append(control);
  }
  const contactOrder=button('Пинг',()=>{
    ui.contactOrder=!ui.contactOrder;
    ui.catalogLimit=CATALOG_PAGE_SIZE;
    contactOrder.setAttribute('aria-pressed',String(ui.contactOrder));
    renderCatalogResults();
  });
  contactOrder.setAttribute('aria-label','Пинг: давно без контакта');
  contactOrder.setAttribute('aria-pressed',String(ui.contactOrder));
  quick.append(contactOrder);
  const paymentFilter = button('', () => {
    ui.filters.paymentStatus = paymentFilters[(paymentFilterIndex() + 1) % paymentFilters.length][0];
    ui.catalogLimit = CATALOG_PAGE_SIZE;
    refreshPaymentFilter();
    renderCatalogResults();
  },'catalog-payment-filter');
  const paymentFilterIndex = () => paymentFilters.findIndex(([value]) => value === ui.filters.paymentStatus);
  const refreshPaymentFilter = () => {
    const index = paymentFilterIndex();
    const [value,label] = paymentFilters[index];
    paymentFilter.replaceChildren(el('span',label,`payment-indicator payment-${value}`));
    paymentFilter.setAttribute('aria-pressed',String(value !== 'all'));
    paymentFilter.setAttribute('aria-label',`Оплаты: ${value === 'all' ? 'все' : label.toLowerCase()}. Следующий фильтр: ${index === paymentFilters.length - 1 ? 'все' : paymentFilters[index + 1][1].toLowerCase()}`);
  };
  if(hasFinance(ui.role)){refreshPaymentFilter();quick.append(paymentFilter);}
  const extra = el('div',null,'filters');
  const currencyOptions = [['all','Любая'],...CURRENCIES];
  for (const [key,label,values] of [
    ['packageFilter','Тариф',[['all','Любой'],['all-online','Весь онлайн'],...Object.entries(TARIFF_LABELS)]],
    ['tariffCurrency','Валюта тарифа',currencyOptions],
    ['paymentCurrency','Валюта поступления',currencyOptions],
    ['format','Формат сейчас',[['all','Любой'],['Очно','Очно'],['Дистанционно','Онлайн'],['Уточнить','Нужно уточнить']]],
    ['basis','Основа плана',[['all','Любая'],...planBasisOptions]],
    ['level','Ведение',[['all','Любое'],'Обычное','Премиум']],
    ['personal','Персональные с Сергеем',[['all','Любые'],['gym','В зале'],['outside','На улице'],['none','Нет'],['unknown','Нужно уточнить']]]
  ]) if(hasFinance(ui.role)||!['packageFilter','tariffCurrency','paymentCurrency'].includes(key))extra.append(filterControl(key,label,values));
  const month = input('month',ui.filters.paymentMonth);
  const monthField = field('Месяц поступления',month);
  monthField.hidden = ui.filters.paymentCurrency === 'all';
  monthField.id = 'catalog-payment-month';
  month.addEventListener('change',()=>{
    if (!month.value) return;
    ui.filters.paymentMonth = month.value;
    ui.catalogLimit = CATALOG_PAGE_SIZE;
    renderCatalogResults();
  });
  if(hasFinance(ui.role))extra.append(monthField);
  const advanced = append(el('div',null,'stack catalog-advanced'),
    extra,button('Сбросить фильтры',()=>{
      ui.filters = {...defaultFilters(),query:ui.filters.query};
      ui.contactOrder = false;
      ui.catalogLimit = CATALOG_PAGE_SIZE;
      render();
    },'subtle')
  );
  return append(el('div',null,'stack catalog-options'),searchField,quick,section('Фильтры','catalog-filters',[advanced]));
}

function filterControl(key,label,values) {
  const options=values.map(item=>Array.isArray(item)?item:[item,item]);
  const control=el('details',null,'catalog-control');
  const choices=el('div',null,'catalog-control-options');
  const summary=append(el('summary'),el('span',label,'catalog-control-label'),el('span'));
  const selected=summary.lastElementChild;
  control.setAttribute('name','client-filter-menu');
  function refresh(){
    selected.textContent=options.find(([value])=>ui.filters[key]===value)?.[1]||options[0][1];
    for(const item of choices.children)item.setAttribute('aria-pressed',String(ui.filters[key]===item.dataset.value));
  }
  for(const [value,title] of options){
    const choice=button(title,()=>{
      ui.filters[key]=value;ui.catalogLimit=CATALOG_PAGE_SIZE;
      if(key==='paymentCurrency')document.getElementById('catalog-payment-month').hidden=value==='all';
      control.open=false;summary.focus();refresh();renderCatalogResults();
    });
    choice.dataset.value=value;choices.append(choice);
  }
  control.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&control.open){control.open=false;summary.focus();}
  });
  refresh();return append(control,summary,choices);
}

function renderCatalogResults() {
  const list = document.getElementById('client-tiles');
  if (!list) return;
  const scope = ui.catalogScope;
  const tariffs = hasFinance(ui.role)&&scope === 'active' ? matchingTariffClients(state(),ui.filters) : null;
  const payment = hasFinance(ui.role)&&scope === 'active' && ui.filters.paymentStatus !== 'all' ? clientPaymentStatuses(state()) : null;
  const clients = C.filterClients(state(),{ ...ui.filters,section:scope,pauseGroup:ui.pauseFilter })
    .filter(c=>(!tariffs || tariffs.has(c.id)) && (!payment || payment.get(c.id) === ui.filters.paymentStatus));
  const byContact=scope==='active'&&ui.contactOrder;
  const activities = byContact ? new Map(clients.map(client=>[client.id,pingActivity(client)])) : null;
  if (activities) clients.sort((a,b)=>(activities.get(a.id)?.time ?? Number.MIN_SAFE_INTEGER) -
    (activities.get(b.id)?.time ?? Number.MIN_SAFE_INTEGER));
  if (scope === 'active' && ui.filters.query.trim()) {
    clients.push(...C.filterClients(state(),{query:ui.filters.query}).filter(c=>C.clientSection(c)!=='active'));
  }
  const accountingClients = hasFinance(ui.role)?accountingUI.activeClientIds():new Set();
  list.replaceChildren();
  for (const c of clients.slice(0,ui.catalogLimit)) {
    const item = button(c.name,()=>openClient(c.id),'client-directory-item');
    item.setAttribute('aria-label','Открыть клиента: '+c.name);
    const category = C.clientSection(c);
    const activity = activities?.get(c.id);
    const pingDetail = activity ? `${activity.kind === 'telegram-opened' ? 'Чат открыт' : 'Контакт'} ${formatDate(activity.at)} ${C.localDate(new Date(activity.time)).slice(0,4)}`
      : 'Контакт не записан';
    const detail = category !== scope ? category === 'paused' ? clientStatus(c) : catalogViews[category]
      : scope === 'paused' ? [C.pauseGroup(c)==='returning' && 'К возврату', c.pause?.returnWindow,
        c.pause?.contactOn && 'Связаться ' + formatDate(c.pause.contactOn)].filter(Boolean).join(' · ')
      : scope === 'team' ? C.clientRole(c) : byContact ? pingDetail : '';
    if (detail) item.append(text(detail));
    const quick = accountingClients.has(c.id) && button('Учёт',()=>accountingUI.quickEntry(c.id),'directory-account');
    if (quick) quick.setAttribute('aria-label','Учёт · '+c.name);
    list.append(append(el('div',null,'directory-row'),item,quick));
  }
  if (clients.length > ui.catalogLimit) list.append(button('Показать ещё · ' + (clients.length-ui.catalogLimit),()=>{
    ui.catalogLimit += CATALOG_PAGE_SIZE;
    renderCatalogResults();
  },'subtle'));
  if (!clients.length) list.append(text('Карточки не найдены'));
}
function emptyDatabase(){return append(el('div',null,'empty'),el('h2','Твоя клиентская база'),el('p','Импортируй подготовленный файл или добавь первого клиента. База хранится на этом устройстве.'),row(button('Импортировать базу',()=>importDatabase(),'primary'),button('Добавить клиента',()=>editClient())));}
function taskStateLabel(t){if(!t.needsReply)return 'Моё действие';if(t.phase==='todo')return 'Нужно написать клиенту';return (t.checkOn<=C.localDate()?'Проверить переписку':'Жду ответа клиента')+' · '+formatDate(t.checkOn);}
function todoPeriods(label,selected,options,onChange){
  const periods=el('div',null,'row catalog-quick todo-periods');
  periods.setAttribute('role','group');
  periods.setAttribute('aria-label',label);
  for(const [value,caption,hint] of options){
    const control=button(caption,()=>{onChange(value);render();});
    if(hint)control.title=hint;
    control.setAttribute('aria-pressed',String(value===selected));
    periods.append(control);
  }
  return periods;
}

function editBirthdayGreeting(client,day){
  const key=client.id+'|'+day;
  const draft=el('textarea');draft.rows=6;draft.maxLength=4096;
  draft.value=ui.birthdayDrafts.get(key)??birthdayGreeting(client);
  draft.addEventListener('input',()=>ui.birthdayDrafts.set(key,draft.value));
  modal('Поздравление · '+client.name,form=>{
    const feedback=el('div',null,'small muted');feedback.setAttribute('role','status');
    const copy=button('Скопировать',async()=>{
      const value=draft.value.trim();
      if(!value){feedback.textContent='Введи поздравление';return;}
      try{
        await navigator.clipboard.writeText(value);
      }catch{
        draft.focus();draft.select();
        if(!document.execCommand?.('copy')){
          feedback.textContent='Текст выделен. Скопируй его через меню.';
          return;
        }
      }
      feedback.textContent='Поздравление скопировано';
    },'primary');
    append(form,field('Текст поздравления',draft),copy,feedback);
    return async()=>{
      await commit(s=>C.completeBirthday(s,client.id,day));
      ui.birthdayDrafts.delete(key);
      message('Поздравление отмечено');
    };
  },{saveLabel:'Поздравил',saveClass:'subtle'});
}

function todoTiles(entries,today){
  const list=el('div',null,'stack');
  for(const item of entries){
    const b=button('',item.open,item.birthday?'task-tile birthday-tile':'task-tile');
    const due=item.due===today?'Сегодня':item.due?formatDate(item.due):'Без срока';
    const overdue=item.payment&&item.due&&item.due<today;
    if(overdue)b.classList.add('task-tile-overdue');
    const title=item.birthday
      ? append(el('span',null,'task-title birthday-action'),el('span','Поздравить'),el('span','›','birthday-arrow'))
      : el('span',item.title,'task-title');
    if(item.birthday)title.lastElementChild.setAttribute('aria-hidden','true');
    append(b,append(el('span',null,'task-tile-top'),el('span',item.name,'task-client-name'),
      item.partner&&el('span','Партнёр','chip'),item.payment&&el('span','$ Оплата','chip payment-chip'),item.birthday&&el('span','🎂 ДР','chip birthday-chip')),
      title,text([overdue&&'Просрочено',due,item.next].filter(Boolean).join(' · '),overdue?'danger-text small':undefined));
    if(item.warning)b.append(text(item.warning.text,item.warning.level==='danger'?'danger-text small':'warning-text small'));
    list.append(b);
  }
  return list;
}

function renderTodo(filter='all'){
  const page=el('div',null,'stack-lg');
  const athlete=isAthlete(ui.role),person=athlete?ownAthlete():null,coach=ui.role==='coach';
  const payments=days=>coach||athlete&&!person?[]:accountingUI.todoItems(days,person?{clientId:person.id}:undefined);
  const today=C.localDate(),days=ui.birthdayPeriod;
  const past=days<0;
  const birthdayEntries=(horizon,scope,from=today)=>birthdayReminders(state(),from,horizon,scope)
  .filter(({client})=>!athlete||client.id===person?.id).map(({client,day})=>({
    name:client.name,due:day,birthday:true,next:scope==='other'?catalogViews[C.clientSection(client)]:'',
    open:athlete?()=>navigate('#profile'):()=>editBirthdayGreeting(client,day)
  }));
  const tasks=C.clientTasks(state()).filter(visibleTask).map(t=>({
    name:state().clients[t.clientId].name,title:t.title,due:C.taskDate(t),
    next:athlete?'От тренера':taskStateLabel(t),reply:!athlete&&t.needsReply,warning:!athlete&&C.taskWarning(t),open:()=>openClient(t.clientId,'task',t.id)
  }));
  const assistant=button('🎙',()=>navigate('#assistant'),'assistant-entry');
  assistant.setAttribute('aria-label','Ассистент · надиктовать запись');assistant.title='Надиктовать запись';
  append(page,append(el('div',null,'page-title'),el('h1','ToDo'),ui.role==='superadmin'&&assistant));
  const filters=el('div',null,'row catalog-quick todo-filters');
  filters.setAttribute('role','group');filters.setAttribute('aria-label','Фильтры ToDo');
  for(const [value,label] of [['all','Все'],['payments','Оплата'],['birthdays','ДР'],['schedule','Расписание']]){
    if(coach&&value==='payments')continue;
    const b=button(label,()=>navigate(value==='all'?'#todo':'#todo/'+value));
    if(value==='birthdays')b.setAttribute('aria-label','ДР · Дни рождения');
    b.setAttribute('aria-pressed',String(filter===value));filters.append(b);
  }
  const filterPanel=append(el('div',null,'todo-filter-panel'),filters);
  page.append(filterPanel);
  if(filter==='schedule'){
    const showKinds=canReadGroupWeek(),kind=showKinds?ui.scheduleKind:null;
    if(showKinds)filterPanel.append(todoPeriods('Виды тренировок',kind,[['group','Группа'],['gym','Зал']],value=>{
      ui.scheduleKind=kind===value?null:value;
    }));
    return append(page,calendarUI.schedule(kind));
  }
  if(athlete&&!person)return append(page,text('Выбери карточку спортсмена в меню под логотипом.'));
  if(!Object.keys(state().clients).length&&!Object.keys(state().partners||{}).length)
    return append(page,hasFinance(ui.role)?emptyDatabase():text('Задач пока нет.'));
  if(filter==='birthdays'){
    const from=past?C.addDays(today,-7):today;
    const entries=birthdayEntries(past?6:days,'active',from);
    const others=birthdayEntries(past?6:days,'other',from);
    if(past){entries.reverse();others.reverse();}
    const empty=past?'За последние 7 дней все поздравления отмечены.':'Нет дней рождения на ближайшие '+days+' дней.';
    filterPanel.append(todoPeriods('Период дней рождения',days,[[7,'7 дней'],[30,'30 дней'],[-7,'Прошли','Дни рождения за последние 7 дней без поздравления']],value=>{ui.birthdayPeriod=value;}));
    const own=athlete?[...entries,...others]:entries;
    append(page,own.length?todoTiles(own,today):text(empty),
      !athlete&&section('Другие категории'+(others.length?' · '+others.length:''),'birthday-other',[
        others.length?todoTiles(others,today):text(empty)
      ]));
    return page;
  }
  if(filter==='payments'){
    const period=athlete?ui.athletePaymentPeriod??7:ui.paymentPeriod;
    const entries=payments(period);
    filterPanel.append(todoPeriods('Период оплаты',period,[[7,'7 дней'],[30,'30 дней'],[-1,'Долги','Неоплаченные счета с прошедшим сроком']],value=>{
      if(athlete)ui.athletePaymentPeriod=value;else ui.paymentPeriod=value;
    }));
    return append(page,entries.length?todoTiles(entries,today):text(period<0?'Просроченных оплат нет.':'Нет предстоящих оплат на ближайшие '+period+' дней.'));
  }
  const period=ui.taskPeriod;
  filterPanel.append(todoPeriods('Период задач',period,[[7,'7 дней'],[30,'30 дней'],[-1,'Проср.','Задачи с прошедшим сроком']],value=>{
    ui.taskPeriod=ui.taskPeriod===value?null:value;
  }));
  const telegram=(athlete?[]:telegramReminders(state())).map(({client,day})=>({
    name:client.name,title:'Давно не открывал переписку',due:day,next:'Проверить Telegram',reminder:true,open:()=>openClient(client.id,'telegram')
  }));
  const birthdays=period===-1?birthdayEntries(6,'active',C.addDays(today,-7)):birthdayEntries(period??14,'active');
  const partnerEntries=(athlete?[]:partnerTasks(state())).filter(task=>!coach||!isPaymentText(task.title)).map(task=>({name:state().partners[task.partnerId].name,title:task.title,due:task.due,partner:true,
    next:'Задача партнёра',open:()=>navigate('#partners/'+task.partnerId+'/task/'+task.id)}));
  const entries=todoPeriodEntries([...tasks,...partnerEntries,...payments(period??undefined),...birthdays,...telegram],period,today)
    .sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999'));
  page.append(entries.length?todoTiles(entries,today):text(period===null?'Открытых задач в этом разделе нет.':
    period===-1?'Просроченных задач нет.':'Нет задач на ближайшие '+period+' дней.'));
  return page;
}
function editTask(t){
  modal('Редактировать задачу',form=>{
    const title=el('textarea'),due=input('date',t.due||'');title.value=t.title;title.maxLength=1000;
    const goals=Object.values(state().goals).filter(g=>g.clientId===t.clientId&&!g.deletedAt);
    const goal=select([['','Не связана'],...goals.map(g=>[g.id,g.title])],C.taskGoal(state(),t)?.id||'');
    const shared=input('checkbox');shared.checked=t.sharedWithAthlete===true;
    append(form,!t.pauseContact&&field('Что сделать',title),field('Когда сделать · можно оставить пустым',due),
      !t.pauseContact&&goals.length&&field('Связанная цель',goal));
    if(!t.pauseContact)form.append(append(el('label',null,'checkbox'),shared,el('span','Видно спортсмену')));
    if(t.phase==='waiting')form.append(text('Проверка ответа остаётся '+formatDate(t.checkOn)+'. Её интервал меняется в настройках задачи.'));
    return ()=>commit(s=>{
      if(t.pauseContact){
        const c=s.clients[t.clientId];
        C.editClient(s,c.id,{pause:{...c.pause,contactOn:due.value||null}});
      }else{
        C.editTask(s,t.id,title.value,due.value||null,goals.length?goal.value||null:undefined);
        C.shareTaskWithAthlete(s,t.id,shared.checked);
      }
    });
  });
}
async function finishClientTask(t) {
  await commit(s=>t.pauseContact?C.completePauseContact(s,t.clientId):C.completeTask(s,t.id,true),false);
  if(!t.pauseContact)ui.recentlyCompleted.add(t.id);
  render();
}
function task(t){
  const wrap=el('div',null,'task');
  wrap.id='task-'+t.id;wrap.tabIndex=-1;
  const question=t.kind==='athlete-question'&&state().records[t.sourceRecordId]?.text;
  if(isAthlete(ui.role))return append(wrap,el('div',t.title,'task-title'),question&&el('div',question,'feature-copy'),
    t.due&&text(formatDate(t.due)));
  if(t.phase==='done'){
    wrap.classList.add('task-completed');
    return append(wrap,el('div',t.title,'task-title'),question&&el('div',question,'feature-copy'),calendarUI.linked(t),row(el('span','Выполнено','chip'),
      button('Вернуть в работу',()=>commit(s=>C.completeTask(s,t.id,false)),'subtle')));
  }
  wrap.append(append(el('div',null,'task-heading'),el('div',t.title,'task-title'),button('Изменить',()=>editTask(t),'subtle')));
  if(question)wrap.append(el('div',question,'feature-copy'));
  if(t.sharedWithAthlete)wrap.append(text('Видно спортсмену'));
  wrap.append(text((t.due&&t.phase==='todo'?formatDate(t.due)+' · ':'')+taskStateLabel(t)));
  if(isSchedulingTask(t))append(wrap,calendarUI.linked(t),button('Назначить тренировку',()=>calendarUI.book(t,()=>{
    ui.recentlyCompleted.add(t.id);render();message('Тренировка связана с задачей');
  }),'subtle'));
  const goal=C.taskGoal(state(),t);
  if(goal&&!goal.deletedAt)wrap.append(button('К цели: '+goal.title,()=>{
    ui.goalFilters??={};ui.goalFilters[t.clientId]='';render();focusCard('goal',goal.id);
  },'subtle'));
  if(t.lastSentAt)wrap.append(text('Последняя отметка: '+formatDate(t.lastSentAt,true)+' · проверка '+formatDate(t.checkOn)));
  if(t.needsReply){
    const controls=el('div',null,'task-actions'),ack=ui.sendAck[t.id]===t.lastSentAt&&t.checkOn>C.localDate(),label=ack?(t.outboundCount>1?'Я написал клиенту повторно, жду ответа':'Я написал клиенту, жду ответа'):(t.lastSentAt?'Написать клиенту повторно':'Написать клиенту');
    controls.append(button(label,async()=>{const at=new Date().toISOString();await commit(s=>C.markSent(s,t.id,at),false);ui.sendAck[t.id]=state().tasks[t.id].lastSentAt;render();},ack?'sent':''),button('Закрыть задачу',()=>finishClientTask(t)));wrap.append(controls);
    const warning=C.taskWarning(t);if(warning)wrap.append(text(warning.text,warning.level==='danger'?'danger-text small':'warning-text small'));
    const delay=input('number',t.waitDays);delay.min=1;delay.max=30;
    wrap.append(section('Настройки задачи',t.id+'-settings',[
      field('Дней до проверки после сообщения',delay),
      button('Сохранить интервал',()=>commit(s=>C.setWait(s,t.id,Number(delay.value)))),
      button('Использовать этот интервал для новых задач',()=>commit(s=>C.setWait(s,t.id,Number(delay.value),true)))
    ]));
  }else{
    const checkbox=input('checkbox');checkbox.checked=false;
    checkbox.addEventListener('change',()=>run(()=>finishClientTask(t)));
    wrap.append(append(el('label',null,'checkbox'),checkbox,el('span','Выполнено')));
  }
  return wrap;
}
function editFeature(clientId, feature) {
  const restriction=hasAthleteCard(state().clients[clientId]);
  modal(feature ? restriction?'Изменить ограничение':'Изменить особенность' : restriction?'Добавить ограничение':'Добавить особенность', form => {
    const note = el('textarea');
    note.value = feature?.text ?? '';
    note.rows = 5;
    const kinds = ['Сейчас', 'Постоянно учитывать', 'На этой неделе'];
    if (feature?.kind && !kinds.includes(feature.kind)) kinds.push(feature.kind);
    const kind = select(kinds, feature?.kind || kinds[0]);
    append(form, field('Суть', note), field('Когда учитывать', kind));
    if(restriction&&feature)form.append(button('Уже не актуально',async()=>{
      await commit(s=>C.setFeatureActive(s,clientId,feature.id,false));dialog.close();
    },'subtle danger'));
    return () => commit(s => feature
      ? C.editFeature(s, clientId, feature.id, note.value, kind.value)
      : C.addFeature(s, clientId, note.value, kind.value));
  });
}

function featureRow(clientId,feature) {
  const kind=feature.kind||'';
  const [label,...metadata]=kind.split(' · ');
  const wrap=el('div',null,'feature');wrap.id='feature-'+feature.id;wrap.tabIndex=-1;
  return append(wrap,el('div',feature.text,'feature-text'),label&&text(label),
    metadata.length&&section('Подробности',feature.id+'-meta',[text(metadata.join(' · '))]),
    append(el('div',null,'row feature-footer'),
      button('Изменить',()=>editFeature(clientId,feature),'subtle'),
      button('Уже не актуально',()=>commit(s=>C.setFeatureActive(s,clientId,feature.id,false)),'subtle')));
}

function renderFeatures(client,{embedded=false}={}) {
  const active=client.features.filter(f=>f.active!==false);
  if(embedded){
    const reported=client.athlete?.restrictions;
    const extra=reported?.status==='reported'&&reported.text&&!active.some(f=>f.text===reported.text)?reported.text:null;
    return append(el('div',null,'stack athlete-restrictions'),
      append(el('div',null,'row between feature-heading'),el('h3','Ограничения'),button('+ Добавить',()=>editFeature(client.id),'subtle')),
      ...active.map(feature=>{
        const item=button(feature.text,()=>navigate('#client/'+client.id+'/restriction/'+feature.id),'athlete-restriction');
        item.id='feature-'+feature.id;return item;
      }),extra&&text(extra),!active.length&&!extra&&text('Не зафиксированы'));
  }
  return append(el('section',null,'stack feature-section'),
    append(el('div',null,'row between feature-heading'),el('h2','Особенности','block-heading'),
      button('+ Добавить',()=>editFeature(client.id),'feature-add')),
    ...active.map(f=>featureRow(client.id,f)),
    !active.length&&text('Пока не зафиксированы'));
}

function pauseDetails(client) {
  const category = C.clientSection(client);
  if (!['paused','archive'].includes(category)) return null;
  return append(el('section',null,'stack'),
    client.pause?.returnWindow&&text('Ориентир возврата · '+client.pause.returnWindow),
    client.pause?.contactOn&&text('Связаться · '+formatDate(client.pause.contactOn)),
    row(button('Возобновить',()=>accountingUI.resumeClient(client)),category==='paused' &&
      button('Настроить паузу',()=>modal('Пауза',form=>{
        const pause = pauseEditor(client);
        form.append(pause.element);
        return ()=>commit(s=>{
          const current = s.clients[client.id];
          if (C.clientSection(current)!=='paused') throw Error('Статус клиента изменился. Открой карточку заново');
          C.editClient(s,client.id,{pause:pause.values()});
        });
      }),'subtle')));
}

function focusCard(type,id){
  requestAnimationFrame(()=>{
    const target=document.getElementById(id?type+'-'+id:type+'-client-panel');
    if(!target)return;
    for(let parent=target;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
    target.focus({preventScroll:true});target.scrollIntoView({block:'start'});
  });
}

function renderHistory(c) {
  const history=el('ol',null,'history');
  const athlete=isAthlete(ui.role),coach=ui.role==='coach';
  const features=new Map(c.features.map(f=>[f.id,f]));
  const past=Object.values(state().tasks).filter(t=>t.clientId===c.id&&t.phase==='done'&&visibleTask(t));
  for(const t of past.sort((a,b)=>(b.closedAt||'').localeCompare(a.closedAt||''))){
    history.append(append(el('li'),text('Выполнено'+(t.closedAt?' · '+formatDate(t.closedAt,true):'')),el('div',t.title),!athlete&&calendarUI.linked(t),
      !athlete&&button('Вернуть в работу',async()=>{await commit(s=>C.completeTask(s,t.id,false));focusCard('task',t.id);},'subtle')));
  }
  for(const f of features.values())if(f.active===false) {
    history.append(append(el('li'),text('Прежняя особенность'),el('div',f.text,'feature-copy'),
      !athlete&&button('Снова актуально',async()=>{await commit(s=>C.setFeatureActive(s,c.id,f.id,true));focusCard('feature',f.id);},'subtle')));
  }
  const athleteEvents=new Set(['profile-edited','training-edited','goal-created','goal-edited','goal-deleted','goal-restored',
    'feature-created','feature-edited','feature-archived','feature-restored']);
  const coachEvents=new Set([...athleteEvents,'record-created','pause-contact-completed','contact','telegram-opened','telegram-linked','telegram-unlinked']);
  const related=Object.values(state().tasks).filter(task=>task.clientId===c.id);
  const events=state().events.filter(e=>e.clientId===c.id).slice().reverse()
    .filter(e=>{
      const task=state().tasks[e.entityId],record=state().records[e.entityId];
      if(e.type==='task-closed'&&task?.phase==='done'||e.type==='feature-archived'&&features.get(e.entityId)?.active===false)return false;
      if(athlete)return athleteEvents.has(e.type)||record?.kind==='athlete-question'||task&&visibleTask(task);
      if(!coach)return true;
      if(task)return visibleTask(task);
      if(record?.kind==='athlete-question')return related.some(task=>task.sourceRecordId===record.id&&visibleTask(task));
      return coachEvents.has(e.type)&&!isPaymentText(e.text||record?.text);
    }).slice(0,100);
  const lastPause=events.find(e=>e.type==='pause-contact-completed');
  for(const e of events){
    const record=state().records[e.entityId],goal=state().goals[e.entityId],t=state().tasks[e.entityId],f=features.get(e.entityId);
    const title=e.text||record?.text||goal?.title||t?.title||f?.text;
    const entry=append(el('li'),text([(!athlete&&!coach&&e.sourceMeta)||formatDate(e.at,true),
      record?.kind==='athlete-question'?'Вопрос тренеру':eventLabel(e.type)].filter(Boolean).join(' · ')),
      title&&el('div',title,f?'feature-copy':''));
    if(t&&t.phase!=='done')entry.append(button('К задаче',()=>focusCard('task',t.id),'subtle'));
    if(e===lastPause&&C.clientSection(c)==='paused'&&!c.pause?.contactOn&&C.validDate(e.due))entry.append(button('Вернуть напоминание',async()=>{
      await commit(s=>{const current=s.clients[c.id];if(C.clientSection(current)==='paused'&&!current.pause?.contactOn)C.editClient(s,c.id,{pause:{...current.pause,contactOn:e.due}});});
      focusCard('task',C.pauseTaskId(c.id));
    },'subtle'));
    history.append(entry);
  }
  return history.children.length?history:text('Записей пока нет');
}

function contactSummary(c){
  const activity=pingActivity(c);
  if(!activity)return 'Контакт в приложении не отмечен';
  return activity.kind==='telegram-opened'?'Переписка открыта: '+formatDate(activity.at,true):'Последний контакт: '+formatDate(activity.at,!c.lastContact.dateOnly)+' · '+c.lastContact.channel;
}
function restrictionCard(c,id){
  const feature=c.features.find(item=>item.id===id),back=button('← К спортсмену',()=>navigate('#client/'+c.id),'back subtle');
  if(!feature)return append(el('div',null,'stack-lg'),back,text('Ограничение не найдено'));
  return append(el('div',null,'stack-lg'),back,text(c.name),el('h1','Ограничение'),el('div',feature.text),
    text(feature.kind||'Сейчас'),feature.active===false&&text('Уже не актуально'),
    button('Изменить',()=>editFeature(c.id,feature),'subtle'),
    button(feature.active===false?'Вернуть в актуальные':'Уже не актуально',async()=>{
      await commit(s=>C.setFeatureActive(s,c.id,id,feature.active===false));
      if(feature.active!==false)navigate('#client/'+c.id);
    },'subtle'));
}
function contactCoach(client){
  const coach=coachContact(state(),assignedCoach(state(),client));
  const linked=coach&&coach.id!==client.id;
  const binding=linked&&coach.telegram;
  const href=linked&&telegramLink({username:profileTelegramUsername(coach)});
  return section('Связь с тренером',client.id+'-coach-contact',[
    linked&&text(coach.name),
    binding?.peerId||href?button('Открыть переписку в Telegram',async()=>{
      if(binding?.peerId){
        try{if((await window.TrailNative?.openTelegram?.(binding))?.opened)return;}
        catch(error){if(!href)throw error;}
      }
      if(!href)throw Error('Не удалось открыть чат тренера');
      if(window.TrailNative?.native)window.location.assign(href);else window.open(href,'_blank','noopener');
    },'primary'):text('Telegram тренера пока не указан.')
  ]);
}
const questionDrafts=new Map();
function athleteQuestion(client){
  let draft=questionDrafts.get(client.id)||{text:'',id:C.id('record')};
  const form=el('form',null,'compose'),note=el('textarea');
  note.rows=3;note.maxLength=4000;note.value=draft.text;
  note.addEventListener('input',()=>{draft.text=note.value;questionDrafts.set(client.id,draft);});
  const send=button('Отправить тренеру',async()=>{
    await commit(s=>C.askCoach(s,client.id,assignedCoach(s,s.clients[client.id]),note.value,draft.id),false);
    questionDrafts.delete(client.id);render();message('Вопрос отправлен тренеру');
  },'primary');
  form.addEventListener('submit',event=>{event.preventDefault();send.click();});
  return append(form,el('h2','Разобрать вопрос'),field('Вопрос тренеру',note),send);
}

function renderClient(clientId,targetType,targetId){
  const c=state().clients[clientId];
  if(!c||c.mergedInto){navigate('#clients');return el('div');}
  const page=el('div',null,'stack-lg client-page');
  const athlete=isAthlete(ui.role),coach=ui.role==='coach';
  const backLabel=ui.returnTo.startsWith('#admin/team/')?'← К работе и выплатам':ui.returnTo.startsWith(scheduleRoute+'/')?'← К тренировке':
    {'#todo':'← К ToDo','#account':'← К учёту','#races':'← К стартам','#todo/birthdays':'← К дням рождения'}[ui.returnTo]||'← К списку клиентов';
  if(!athlete||targetType)page.append(button(athlete?'← К ToDo':backLabel,()=>navigate(athlete?'#todo':ui.returnTo),'back subtle'));
  const header=el('header',null,'stack client-header');
  append(header,append(el('div',null,'page-title'),el('h1',c.name),hasFinance(ui.role)&&button('Изменить',()=>editClient(c.id),'subtle')),chips(c),
    !athlete&&text(contactSummary(c)),
    athlete&&isOwnerPerson(c)&&button('Источники данных',()=>openClient(c.id,'sources'),'back subtle'));
  const followUp=hasFinance(ui.role)&&pauseDetails(c);
  append(page,header,followUp);
  const sport=hasAthleteCard(c);
  const goals=detailsUI.goals(c,()=>{
    const draft=getDraft(c.id);draft.kind='goal';
    const form=document.getElementById('compose');
    form.querySelectorAll('[data-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.kind==='goal')));
    document.getElementById('goal-status-field').hidden=false;
    document.getElementById('task-fields').hidden=true;
    form.scrollIntoView({behavior:'smooth',block:'start'});
    document.getElementById('client-note').focus({preventScroll:true});
    saveDraftSoon();
  },{compact:sport,readOnly:athlete});
  if(sport)page.append(athleteUI.summary(c,goals,previewTrainingVisible(state(),c,roleContext())
    &&button('Детали тренировок',()=>openClient(c.id,'training-plan'),'back subtle calendar-link')));
  if(c.role==='Тренер')page.append(button('Работа и выплаты',()=>navigate('#admin/team/'+c.id),'subtle'));
  const tasks=[...C.clientTasks(state(),clientId),...Array.from(ui.recentlyCompleted,id=>state().tasks[id])
    .filter(t=>t?.clientId===clientId&&t.phase==='done')].filter(visibleTask);
  if(tasks.length)page.append(append(el('section',null,'panel action-panel'),el('h2',athlete?'Задачи от тренера':'Действия по клиенту','block-heading'),...tasks.map(task)));
  if(!sport)page.append(renderFeatures(c));
  if(c.role==='Клиент'&&hasFinance(ui.role))page.append(accountingUI.clientPanel(c));
  if(c.role==='Клиент'&&coach)page.append(button('Принять оплату',()=>accountingUI.coachReceipt(c.id),'primary account-main-action'));
  const reference=el('div',null,'reference-sections');
  const telegram=athlete?contactCoach(c):section('Сообщения в Telegram',c.id+'-telegram',[telegramPanel(c)]);
  telegram.id='telegram-client-panel';telegram.tabIndex=-1;
  const profile=section(athlete?'О себе':'О клиенте',c.id+'-profile',[...detailsUI.profile(c,{coach}),
    athlete&&button('Оплаты',()=>navigate('#account'),'subtle')]);
  profile.id='profile-client-panel';profile.tabIndex=-1;
  const training=section('Тренировочные данные',c.id+'-zones',[c.athlete&&athleteUI.details(c),...detailsUI.training(c,{showZones:!sport})]);
  training.id='training-client-panel';training.tabIndex=-1;training.classList.add('client-training');
  reference.append(telegram,profile,detailsUI.journal(c,{readOnly:athlete,allowTask:visibleTask}),training);
  if(!sport)reference.append(goals);
  if(!coach)reference.append(section('Кемпы и история участия',c.id+'-camps',c.camps?.length?c.camps.map(camp=>text(camp.name+' · '+camp.status,' ')):[text('История участия пока не восстановлена')]));
  reference.append(section('История записей',c.id+'-history',[renderHistory(c)]));
  page.append(reference,athlete?athleteQuestion(c):compose(c));
  if(targetType&&ui.focusRoute!==location.hash){
    ui.focusRoute=location.hash;
    if(targetType==='goal'){
      ui.open.add(c.id+'-goals');
    }
    if(targetType==='training'&&ui.athleteReturnEntry){
      const entry=ui.athleteReturnEntry;delete ui.athleteReturnEntry;focusCard('athlete-row',entry);
    }else focusCard(targetType,targetId);
  }
  return page;
}
function eventLabel(type){return ({'birthday-greeted':'День рождения · поздравил','pause-contact-completed':'Связь после паузы отмечена','telegram-opened':'Открыта переписка в Telegram','profile-edited':'Обновлены сведения о клиенте','training-edited':'Обновлены тренировочные данные','record-created':'Запись Сергея','goal-created':'Цель добавлена','goal-edited':'Цель изменена','goal-deleted':'Цель удалена','goal-restored':'Цель восстановлена','task-created':'Задача создана','task-edited':'Задача изменена','telegram-linked':'Переписка привязана','telegram-unlinked':'Переписка отвязана','task-closed':'Задача закрыта','task-reopened':'Задача возвращена','outbound':'Исходящее сообщение','task-scheduled':'Разговор назначен','client-edited':'Данные клиента изменены','client-created':'Клиент добавлен','client-movement':'Статус сотрудничества изменён','feature-created':'Особенность добавлена','feature-edited':'Особенность изменена','feature-archived':'Особенность снята с актуального','feature-restored':'Особенность снова актуальна','contact':'Контакт с клиентом','source-note':'Сведения от Сергея'})[type]||'Изменение';}
function getDraft(clientId){return ui.drafts[clientId]||(ui.drafts[clientId]={text:'',kind:'record',needsReply:false,due:'',goalStatus:''});}
function saveDraftSoon(){clearTimeout(draftTimer);draftTimer=setTimeout(()=>run(()=>saveDrafts()),500);}
async function saveDrafts(){clearTimeout(draftTimer);if(!store)return;await commit(s=>{s.settings.drafts=C.clone(ui.drafts);},false);}
function compose(c){
  const d=getDraft(c.id),form=el('form',null,'compose');form.id='compose';
  append(form,el('h2','Запись по клиенту'));
  const modes=el('div',null,'segmented'),note=el('textarea');
  note.id='client-note';note.rows=4;note.maxLength=16000;note.value=d.text;
  note.placeholder='Можно надиктовать без ввода текста или написать здесь';
  const taskFields=el('div',null,'stack');taskFields.id='task-fields';taskFields.hidden=d.kind!=='task';
  const due=input('date',d.due||''),reply=input('checkbox');reply.checked=!!d.needsReply;
  due.addEventListener('change',()=>{d.due=due.value;saveDraftSoon();});
  reply.addEventListener('change',()=>{d.needsReply=reply.checked;saveDraftSoon();});
  append(taskFields,field('Когда сделать · можно оставить пустым',due),append(el('label',null,'checkbox'),reply,el('span','Нужен ответ клиента · проверять через '+state().settings.waitDays+' дн. после сообщения')));
  const status=inlineSelect(document,[['','Определить по записи'],...C.GOAL_STATUSES.map(value=>[value,value])],d.goalStatus||'','Статус цели');
  status.element.addEventListener('change',()=>{d.goalStatus=status.value;saveDraftSoon();});
  const type=inlineSelect(document,[['','Определить по записи'],...Object.entries(GOAL_TYPES)],d.goalType||'','Тип цели');
  type.element.addEventListener('change',()=>{d.goalType=type.value;saveDraftSoon();});
  const goalField=append(el('div',null,'stack'),status.field,type.field);goalField.id='goal-status-field';goalField.hidden=d.kind!=='goal';
  for(const [kind,label] of [['record','Без пометки'],['task','Задача'],['goal','Цель']]){
    const b=button(label,()=>{d.kind=kind;modes.querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===b)));taskFields.hidden=kind!=='task';goalField.hidden=kind!=='goal';updateAction();saveDraftSoon();});
    b.dataset.kind=kind;b.setAttribute('aria-pressed',String(d.kind===kind));modes.append(b);
  }
  const send=el('button','','primary'),hint=text(''),extra=button('Надиктовать ещё',()=>recordVoice(c.id));send.type='submit';hint.setAttribute('role','status');
  const localSave=button('Сохранить без агента',async()=>{submitting=true;updateAction();try{await submitRecord(c,d);}finally{if(send.isConnected){submitting=false;updateAction();}}},'subtle');
  let submitting=false;
  function updateAction(){
    const permission=ui.microphonePermission;
    const microphoneLabel=permission?.settingsRequired?'Открыть доступ к микрофону':permission&&permission.state!=='granted'?'Разрешить микрофон':null;
    const recording=ui.recorder&&ui.recordingClientId===c.id;
    const pending=ui.pendingVoice?.clientId===c.id;
    const recognizing=ui.busy.has('voice-'+c.id);
    const starting=ui.voiceStartingClientId===c.id,saving=ui.voiceSavingClientId===c.id;
    const otherRecording=!!ui.recorder&&!recording;
    send.disabled=submitting||recognizing||starting||saving||otherRecording;
    send.classList.toggle('recording',!!recording);
    send.classList.toggle('processing',!!(submitting||recognizing||starting||saving));
    hint.classList.toggle('recording-status',!!recording);
    send.textContent=submitting?'Обрабатываю запись…':starting?'Подключаю микрофон…':saving?'Сохраняю аудио…':recognizing?'Распознаю голос…':recording?'Остановить и распознать':pending?'Распознать сохранённую запись':d.text.trim()?'Обработать запись':(microphoneLabel||(state().settings.serviceURL&&!state().settings.agentEnabled?'Включить агента и надиктовать':'Надиктовать запись'));
    hint.textContent=recognizing?'Расшифровываю голос на Mac…':recording?'Идёт запись. Говори, затем нажми «Остановить и распознать».':pending?'Аудио сохранено на устройстве. Нажми кнопку для повторной расшифровки.':otherRecording?'Сначала останови запись в карточке другого клиента.':d.text.trim()?'Проверь текст. Кнопка передаст его на обработку.':permission?.settingsRequired?'Android больше не показывает запрос. Кнопка откроет настройки THE.TRAIL Clients: Разрешения → Микрофон.':microphoneLabel?'Нажми кнопку и разреши микрофон в системном окне Android. После разрешения начнётся запись.':'Текст вводить не нужно: нажми кнопку ниже и говори.';
    extra.hidden=!d.text.trim()||!!recording||pending||recognizing||starting||saving;extra.disabled=submitting;
    localSave.hidden=!d.text.trim()||state().settings.agentEnabled||!state().settings.serviceURL||!!recording||pending||recognizing||starting||saving;localSave.disabled=submitting;
    localSave.textContent=d.kind==='task'?'Создать задачу без агента':d.kind==='goal'?'Добавить цель без агента':'Сохранить без агента';
  }
  note.addEventListener('input',()=>{d.text=note.value;d.pendingRecordId=null;updateAction();saveDraftSoon();});
  append(form,modes,note,taskFields,goalField,hint,send,extra,localSave);
  if(!state().settings.serviceURL)form.append(text('Для диктовки подключи Mac в настройках. Текст и подбор старта из каталога работают на устройстве.'));
  else if(!state().settings.agentEnabled)form.append(text('AI-разбор включится при нажатии кнопки после проверки подключения.'));
  if(ui.recordResults[c.id])form.append(text(ui.recordResults[c.id],'record-result'));
  form.addEventListener('submit',e=>{e.preventDefault();run(async()=>{
    if(send.disabled)return;
    if(ui.pendingVoice?.clientId===c.id){await transcribeVoice(ui.pendingVoice);return;}
    if(ui.recorder||!d.text.trim()){await recordVoice(c.id);return;}
    submitting=true;updateAction();
    try{if(d.kind!=='goal'&&state().settings.serviceURL&&!state().settings.agentEnabled)await ensureAgent(false);await submitRecord(c,d);}
    finally{if(send.isConnected){submitting=false;updateAction();}}
  });});
  updateAction();return form;
}
async function ensureAgent(voice=false){
  if(!state().settings.serviceURL)throw Error('Сначала подключи Mac в настройках «Агент и Telegram»');
  if(state().settings.agentEnabled)return;
  const status=await service('/agent/status',{});
  if(!status.ready)throw Error('Агент на Mac не готов. Проверь подключение в настройках');
  if(voice&&!status.voiceReady)throw Error('Расшифровка голоса на Mac не готова. Проверь подключение');
  await commit(s=>{s.settings.agentEnabled=true;},false);
}
function agentClient(c){
  const keys=['id','name','role','status','format','currentFormat','basis','group','personal','level','features','rules','context'];
  return Object.fromEntries(keys.map(key=>[key,c[key]]));
}
async function submitRecord(c,d){
  const data={...d},pending=state().records[d.pendingRecordId];
  const record=pending&&pending.text===data.text.trim()&&pending.kind===data.kind?pending:await commit(s=>C.saveRecord(s,c.id,data.text,data.kind),false);
  d.pendingRecordId=record.id;await saveDrafts();
  const finish=async result=>{
    ui.recordResults[c.id]=result.changes.length?result.changes.map(x=>(x.type==='task'?'Задача: ':x.type==='goal'?'Цель: ':'Особенность: ')+x.title).join('\n')
      :result.mode==='agent'?'Запись сохранена. Агент не выделил задач, целей или особенностей.':'Запись сохранена в истории';
    ui.drafts[c.id]={text:'',kind:'record',needsReply:false,due:'',goalStatus:''};await saveDrafts();render();
  };
  if(data.kind==='goal'){
    if(record.status==='processed'){await finish(record.result);return;}
    let proposal=goalProposal(state(),data.text,data);
    // A dedicated goal entry always creates a new goal. Existing goals are deliberately
    // excluded from extraction, and only the reviewed fields are committed below.
    if(!proposal.matched&&state().settings.serviceURL&&state().settings.agentEnabled){
      try{
        const response=await service('/records/parse',{client:agentClient(state().clients[c.id]),goals:[],openTasks:[],record,
          timezone:C.TIMEZONE,waitDays:state().settings.waitDays,needsReply:false,goalIntent:'create'});
        const goals=response.changes?.filter(change=>change.type==='goal');
        if(goals?.length===1&&!goals[0].id){
          const parsed=goals[0];
          proposal=goalProposal(state(),parsed.title,{goalType:data.goalType||parsed.goalType,goalStatus:data.goalStatus||parsed.status});
        }
        if(response.question)proposal.notice=response.question;
      }catch(e){proposal.notice=[proposal.notice,'AI недоступен: '+e.message+'. Проверь поля цели ниже.'].filter(Boolean).join(' ');}
    }
    let saved;
    detailsUI.reviewGoal(c,proposal,(s,values)=>{saved=C.processManualRecord(s,record.id,values);},()=>{void finish(saved);});
    return;
  }
  let result;
  if(state().settings.serviceURL&&state().settings.agentEnabled){
    try{
      const response=await service('/records/parse',{client:agentClient(state().clients[c.id]),goals:Object.values(state().goals).filter(g=>g.clientId===c.id&&!g.deletedAt),
        openTasks:C.clientTasks(state(),c.id).filter(t=>!t.pauseContact),record,timezone:C.TIMEZONE,waitDays:state().settings.waitDays,needsReply:data.needsReply});
      if(response.question){ui.recordResults[c.id]='Нужно уточнить: '+response.question;render();return;}
      result=await commit(s=>C.applyAgentResult(s,record.id,response),false);
    }catch(e){ui.recordResults[c.id]='Запись сохранена. Обработка не завершена: '+e.message;render();return;}
  }else result=await commit(s=>C.processManualRecord(s,record.id,{due:data.due||null,needsReply:data.needsReply}),false);
  await finish(result);
}
const assistantKey='__assistant__';
function assistantAmount(value) {
  const explicit=value.match(/(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[,.](\d{1,2}))?\s*(тысяч\p{L}*|[кk](?!\p{L}))?\s*(RSD|RUB|EUR|USD|динар\p{L}*|дин|рубл\p{L}*|руб|евро|доллар\p{L}*|₽|€|[$])/iu);
  if(!explicit)return {};
  const [,integer,decimals,multiplier,unit]=explicit;
  const amount=Number(integer.replace(/\s/g,''))+Number('0.'+(decimals||'0'));
  const currency=/rsd|дин/i.test(unit)?'RSD':/rub|руб|₽/i.test(unit)?'RUB':/eur|евро|€/i.test(unit)?'EUR':'USD';
  return { amount:amountMinor(amount*(multiplier?1000:1)),currency };
}
function renderAssistant(){
  const d=getDraft(assistantKey),page=el('div',null,'stack-lg assistant-page');
  const note=el('textarea');note.rows=5;note.maxLength=16000;note.value=d.text;
  note.placeholder='Например: Стремовская оплатила персоналку в зале';
  note.setAttribute('aria-label','Запись для ассистента');
  const pending=ui.pendingVoice?.clientId===assistantKey;
  const recording=ui.recordingClientId===assistantKey;
  const busy=ui.voiceStartingClientId===assistantKey||ui.voiceSavingClientId===assistantKey||ui.busy.has('voice-'+assistantKey);
  const voice=button(busy?'Обрабатываю…':pending?'Повторить распознавание':recording?'Остановить и распознать':'Надиктовать запись',
    ()=>pending?transcribeVoice(ui.pendingVoice):recordVoice(assistantKey),recording?'primary recording':'subtle');
  voice.disabled=busy;
  const review=button('Продолжить',()=>reviewAssistant(d.text),'primary');
  const refresh=()=>{review.disabled=!d.text.trim()||busy||recording;};
  note.addEventListener('input',()=>{d.text=note.value;refresh();saveDraftSoon();});refresh();
  return append(page,button('← К ToDo',()=>navigate('#todo'),'back subtle'),el('h1','Ассистент'),note,row(voice,review));
}
function reviewAssistant(value){
  const clients=C.filterClients(state());
  const {selected,suggestions}=suggestAssistantClients(value,clients);
  const kinds={payment:'Принять оплату', session:'Записать занятие', task:'Поставить задачу',goal:'Добавить цель',record:'Сохранить запись'};
  modal('Запись ассистента',(form,setSaveEnabled)=>{
    const client=select([['','Выбери клиента'],...clients.map(c=>[c.id,c.name])],selected);
    const kind=select(Object.entries(kinds),assistantKind(value));
    const update=()=>setSaveEnabled(!!client.value);
    client.addEventListener('change',update);
    const suggested=!selected&&suggestions.length&&append(el('div',null,'stack'),
      text('Похожие имена в базе'),row(...suggestions.map(id=>button(state().clients[id].name,()=>{
        client.value=id;
        update();
      },'subtle'))));
    append(form,text(value),suggested,field('Клиент',client),field('Действие',kind));
    update();
    return async()=>{
      const c=state().clients[client.value];
      if(!c||c.mergedInto)throw Error('Выбери клиента');
      const type=kind.value;
      requestAnimationFrame(()=>run(()=>type==='payment'||type==='session'?reviewAssistantFinance(c,type,value):previewAssistantRecord(c,type,value)));
    };
  },{saveLabel:'Проверить'});
}
function reviewAssistantFinance(client,type,value){
  const place=/в\s+зал(?:е|у)?(?!\p{L})/iu.test(value)?'Зал':/на\s+улиц[еу](?!\p{L})/iu.test(value)?'Улица':null;
  const personal=type==='session'||!!place||/персонал|индивидуальн/iu.test(value);
  const {amount,currency}=assistantAmount(value);
  const day=C.localDate();
  const date=/вчера/iu.test(value)?C.addDays(day,-1):day;
  const services=clientServices(state(),client.id).filter(s=>(!personal||s.kind==='personal')&&(!place||s.place===place));
  const matchingCurrency=s=>!currency||s.currency===currency;
  const eligible=services.filter(s=>!s.oneOff&&activeService(s,date));
  const visit=options=>accountingUI.assistantVisit({clientId:client.id,transcript:value,day:date,place,amount,currency,
    draftKey:assistantKey,onSaved:()=>{delete ui.drafts[assistantKey];render();},...options});
  if(type==='session'||(personal&&mentionsCompletedSession(value))) {
    visit({services:eligible.filter(matchingCurrency),checkPayment:/оплат|получил|деньги/iu.test(value)});
    return;
  }
  const payable=services.filter(s=>s.kind==='personal'&&serviceBalance(state(),s.id).balance<0);
  const choices=accountingUI.quickOptions(client.id,[...new Set([...eligible,...payable])]).filter(option=>option.kind===type);
  if(!choices.length&&personal) {
    visit({services:[],checkPayment:true,paymentOnly:true});
    return;
  }
  if(!choices.length)throw Error('Для такого действия у клиента нет подходящего действующего тарифа');
  const matches=choices.filter(option=>matchingCurrency(option.service));
  if(!matches.length)throw Error('Названная валюта отличается от тарифа. Открой «Распределить оплату» в учёте.');
  const open=option=>accountingUI.quickEntry(client.id,{...option,amount,date,onSaved:clearAssistantDraft});
  if(matches.length===1){open(matches[0]);return;}
  modal('Выбрать тариф',form=>{
    for(const choice of matches){
      const service=choice.service;
      form.append(button([tariffLabel(service),service.oneOff&&'разово '+formatDate(service.startsOn),service.currency]
        .filter(Boolean).join(' · '),()=>open(choice)));
    }
  },{saveLabel:false});
}
async function clearAssistantDraft(){
  delete ui.drafts[assistantKey];await saveDrafts();render();
}
async function previewAssistantRecord(client,kind,value){
  const haveAgent=state().settings.serviceURL;
  const record={id:C.id('record'),clientId:client.id,text:value.trim(),kind,createdAt:new Date().toISOString()};
  let result;
  if(haveAgent){
    await ensureAgent(false);
    result=await service('/records/parse',{client:agentClient(client),record,timezone:C.TIMEZONE,
      goals:Object.values(state().goals).filter(g=>g.clientId===client.id&&!g.deletedAt),
      openTasks:C.clientTasks(state(),client.id).filter(t=>!t.pauseContact),waitDays:state().settings.waitDays,needsReply:false});
  }
  if(result?.question)throw Error(result.question);
  modal('Подтвердить запись',form=>{
    const note=el('textarea');note.value=record.text;note.maxLength=16000;
    append(form,text(client.name,'account-form-client'));
    if(result?.changes?.length){
      for(const change of result.changes)form.append(text([({task:'Задача',goal:'Цель',feature:'Особенность'})[change.type],change.title,change.due&&formatDate(change.due)].filter(Boolean).join(' · '),'record-result'));
      form.append(text(record.text));
    }else form.append(field('Текст записи',note));
    return async()=>{
      await commit(s=>{
        const saved=C.saveRecord(s,client.id,note.value,kind);
        if(result?.changes?.length)C.applyAgentResult(s,saved.id,result);
        else C.processManualRecord(s,saved.id);
      },false);
      await clearAssistantDraft();message('Запись сохранена');
    };
  });
}
async function service(path,body){const base=currentServiceOrigin(state().settings.serviceURL);if(!base)throw Error('Подключи сервис в настройках');const address=new URL(path,base);if(address.protocol!=='https:')throw Error('Нужен HTTPS-адрес сервиса');if(window.TrailNative?.native){const res=await window.TrailNative.request(address.href,'POST',body);return JSON.parse(res.body);}throw Error('Подключение сервиса доступно в установленном Android-приложении');}
async function recordVoice(clientId){
  if(ui.recorder){
    if(ui.recordingClientId!==clientId)throw Error('Сначала останови запись в карточке другого клиента');
    if(ui.recorder.state!=='recording'&&ui.recorder.state!=='paused')return;
    ui.voiceSavingClientId=clientId;render();ui.recorder.stop();return;
  }
  if(ui.voiceStartingClientId||ui.voiceSavingClientId)return;
  if(ui.pendingVoice)throw Error('Сначала обработай сохранённую голосовую запись в карточке её клиента');
  if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined')throw Error('Запись голоса недоступна на этом устройстве');
  let stream;ui.voiceStartingClientId=clientId;render();
  try{
    await ensureAgent(true);
    const permission=await microphoneAccess(window.TrailNative);
    if(permission.state!=='browser')ui.microphonePermission=permission;
    if(permission.openSettings){await window.TrailNative.openMicrophoneSettings();return;}
    if(!['granted','browser'].includes(permission.state))return;
    stream=await navigator.mediaDevices.getUserMedia({audio:true});
    const chunks=[],recorder=new MediaRecorder(stream);ui.recorder=recorder;ui.recordingClientId=clientId;
    let stopTimer;
    recorder.addEventListener('dataavailable',e=>{if(e.data.size)chunks.push(e.data);});
    recorder.addEventListener('stop',()=>run(async()=>{
      clearTimeout(stopTimer);stream.getTracks().forEach(t=>t.stop());ui.recorder=null;ui.recordingClientId=null;
      ui.voiceSavingClientId=clientId;render();
      try{
        const blob=new Blob(chunks,{type:recorder.mimeType});
        if(!blob.size)throw Error('Аудио не записалось. Попробуй ещё раз');
        if(blob.size>6*1024*1024)throw Error('Запись слишком длинная. Попробуй короче.');
        const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(blob);});
        const pending={id:C.id('audio'),clientId,audio:base64,mime:blob.type};ui.pendingVoice=pending;
        if(window.TrailNative?.native)await window.TrailNative.saveVoice(pending);
        ui.voiceSavingClientId=null;await transcribeVoice(pending);
      }finally{ui.voiceSavingClientId=null;render();}
    }));
    recorder.start();stopTimer=setTimeout(()=>{if(recorder.state==='recording')recorder.stop();},90000);
  }catch(error){
    stream?.getTracks().forEach(t=>t.stop());ui.recorder=null;ui.recordingClientId=null;
    if(error.name==='NotAllowedError'){
      if(window.TrailNative?.microphonePermission)ui.microphonePermission=microphoneState(await window.TrailNative.microphonePermission());
      throw Error('Android не разрешил запись. Используй кнопку доступа к микрофону или проверь системный переключатель микрофона.');
    }
    throw error;
  }finally{ui.voiceStartingClientId=null;render();}
}
async function transcribeVoice(pending){
  const key='voice-'+pending.clientId;if(ui.busy.has(key))return;ui.busy.add(key);render();
  try{
    const result=await service('/audio/transcribe',{audio:pending.audio,mime:pending.mime,idempotencyKey:pending.id});
    if(typeof result.text!=='string'||!result.text.trim())throw Error('Речь не распознана. Попробуй ещё раз');
    const draft=getDraft(pending.clientId);
    if(draft.lastVoiceId!==pending.id){draft.text=(draft.text?draft.text+'\n':'')+result.text;draft.lastVoiceId=pending.id;await saveDrafts();}
    if(window.TrailNative?.native)await window.TrailNative.clearVoice();ui.pendingVoice=null;
    message('Голос распознан. Проверь текст и передай запись агенту.');
  }finally{ui.busy.delete(key);render();}
}
async function refreshMicrophonePermission(){
  if(!window.TrailNative?.native||!window.TrailNative.microphonePermission)return;
  try{ui.microphonePermission=microphoneState(await window.TrailNative.microphonePermission());}
  catch{ui.microphonePermission=null;}
}
window.addEventListener('trail-app-active',()=>run(async()=>{
  await refreshMicrophonePermission();
  if(store&&!ui.recorder&&!ui.voiceStartingClientId&&!ui.voiceSavingClientId)render();
}));
function agentConnectionCheck(){
  const wrap=el('div',null,'stack'),result=text('');
  append(wrap,button('Проверить агента и голос',async()=>{
    result.textContent='Проверяю…';
    try{const status=await service('/agent/status',{});result.textContent=(status.ready?'Агент готов: ':'Агент не настроен: ')+status.label+' · '+(status.voiceReady?'Голос готов: ':'Голос не настроен: ')+status.voiceLabel;}
    catch(error){result.textContent=error.message;throw error;}
  }),result);return wrap;
}
async function openTelegramDraft(c,template){
  const open=()=>{
    const current=state().clients[c.id];
    if(!sameTelegramDestination(current?.telegram,c.telegram))throw Error('Получатель изменился. Открой его карточку заново');
    return detailsUI.openTelegram(current);
  };
  try{await navigator.clipboard.writeText(template);}
  catch{
    modal('Заготовка для Telegram',form=>{
      const draft=el('textarea');draft.value=template;draft.readOnly=true;draft.rows=2;
      const status=text('Скопируй текст перед открытием переписки.');
      append(form,field('Текст сообщения',draft),button('Скопировать',()=>{
        draft.focus();draft.select();
        let copied=false;
        try{copied=Boolean(document.execCommand?.('copy'));}catch{}
        status.textContent=copied?'Текст скопирован.':'Текст выделен. Скопируй его через меню.';
      }),status,button('Открыть чат',async()=>{await open();dialog.close();},'primary'));
    },{saveLabel:null,cancelLabel:'Закрыть'});
    return;
  }
  await open();
}

async function sendTelegramTemplate(c,template,taskId){
  const busy='telegram-'+c.id;
  if(ui.busy.has(busy))return;
  ui.busy.add(busy);
  try{
    const previous=state().settings.pendingTelegram?.[c.id];
    const operation=prepareTelegramAttempt(previous,c.telegram,{key:C.id('message'),text:template,taskId});
    await commit(s=>{
      if(!sameTelegramDestination(s.clients[c.id]?.telegram,operation))throw Error('Получатель изменился. Открой его карточку заново');
      s.settings.pendingTelegram={...s.settings.pendingTelegram,[c.id]:operation};
    },false);
    let result;
    try{
      result=await service('/telegram/send',{peerId:operation.peerId,accountPeerId:operation.accountPeerId,text:template,idempotencyKey:operation.key});
      if(!result?.messageId||!result.sentAt||!Number.isFinite(Date.parse(result.sentAt)))throw Error('Сервис не подтвердил отправку');
    }catch(error){
      await commit(s=>{
        if(s.settings.pendingTelegram?.[c.id]?.key===operation.key)
          s.settings.pendingTelegram[c.id]=failedTelegramAttempt(operation,previous,error);
      });
      return;
    }
    await commit(s=>{
      const messageKey=operation.peerId+':'+result.messageId;
      C.confirmedContact(s,c.id,{at:result.sentAt,messageKey,source:'telegram-api'});
      const task=s.tasks[operation.taskId];
      if(task?.clientId===c.id&&task.needsReply&&task.phase!=='done'){
        C.markSent(s,task.id,result.sentAt,messageKey);ui.sendAck[task.id]=result.sentAt;
      }
      if(s.settings.pendingTelegram?.[c.id]?.key===operation.key)delete s.settings.pendingTelegram[c.id];
    });message('Отправлено · '+formatDate(result.sentAt,true));
  }finally{ui.busy.delete(busy);}
}

function telegramAttemptPanel(c,attempt){
  const pending=el('div',null,'stack telegram-delivery');
  const status=text(telegramDeliveryNotice(attempt));status.setAttribute('role','status');
  const same=sameTelegramDestination(c.telegram,attempt);
  return append(pending,el('strong',attempt.text),status,
    !same&&text('Эта попытка относится к прежней привязке.'),
    row(same&&button('Скопировать и открыть чат',()=>openTelegramDraft(c,attempt.text),'subtle'),
      button('Закрыть попытку',()=>{
        if(ui.busy.has('telegram-'+c.id))throw Error('Дождись завершения отправки');
        modal('Закрыть попытку отправки',form=>{
          form.append(text(attempt.delivery==='not-sent'
            ?'Попытка исчезнет из карточки. Отправку можно будет начать заново.'
            :'Если сообщение уже есть в чате, повторять его не нужно. Закрытие попытки не отмечает сообщение отправленным.'));
          return ()=>commit(s=>{
            if(s.settings.pendingTelegram?.[c.id]?.key===attempt.key)delete s.settings.pendingTelegram[c.id];
          });
        },{saveLabel:'Закрыть попытку'});
      },'subtle')));
}

function telegramPanel(c){
  const panel=el('section',null,'stack telegram-panel'),bound=!!c.telegram?.peerId;
  const pending=state().settings.pendingTelegram?.[c.id];
  if(bound){
    panel.append(text('Переписка привязана','telegram-linked small'),el('div',(c.telegram.displayName||'Telegram')+(c.telegram.username?' · @'+c.telegram.username:''),'telegram-recipient'),...detailsUI.telegramOptions(c));
    panel.append(append(el('div',null,'row telegram-controls'),
      button('Изменить получателя',()=>bindTelegram(c),'subtle'),
      button('Отвязать переписку',()=>unbindTelegram(c),'subtle')));
  }else{
    append(panel,text('Переписка ещё не привязана'),button('Привязать переписку',()=>bindTelegram(c),'subtle'));
    if(pending)panel.append(telegramAttemptPanel(c,pending));
    return panel;
  }
  const connected=!!state().settings.serviceURL;
  if(!connected)panel.append(text('Заготовку можно скопировать и отправить в Telegram.'));
  const replies=C.clientTasks(state(),c.id).filter(t=>t.needsReply&&visibleTask(t)),linked=select([['','Без привязки к задаче'],...replies.map(t=>[t.id,t.title])],'');
  if(connected&&replies.length)panel.append(field('Ожидать ответ по задаче',linked));
  const list=el('div',null,'telegram-templates');
  panel.append(text(connected?'Заготовки · нажатие отправит сообщение':'Заготовки · открыть в Telegram'));
  for(const template of C.TEMPLATES){
    const retry=connected&&pending?.text===template;
    const send=button(retry?'Повторить · '+template:template,()=>connected
      ?sendTelegramTemplate(c,template,linked.value||null):openTelegramDraft(c,template),'template-button');
    send.disabled=Boolean(pending&&(!sameTelegramDestination(c.telegram,pending)
      ||pending.delivery!=='not-sent'&&(!connected||pending.text!==template)));
    send.setAttribute('aria-label',(connected?'Отправить в Telegram: ':'Подготовить в Telegram: ')+template);
    list.append(send);
  }
  append(panel,list,pending&&telegramAttemptPanel(c,pending));return panel;
}
async function unbindTelegram(c){
  if(ui.busy.has('telegram-'+c.id))throw Error('Дождись завершения отправки');
  const previous=C.clone(state().clients[c.id].telegram);
  await commit(s=>C.setTelegramBinding(s,c.id,null));
  message('Переписка отвязана',false,{label:'Вернуть',run:async()=>{
    if(state().clients[c.id].telegram)throw Error('Получатель уже изменён');
    await commit(s=>C.setTelegramBinding(s,c.id,previous));
  }});
}
async function bindTelegram(c){
  if(ui.busy.has('telegram-'+c.id))throw Error('Дождись завершения отправки');
  if(!state().settings.serviceURL)throw Error('Сначала подключи личный сервис в настройках');
  if(state().settings.pendingTelegram?.[c.id])throw Error('Сначала проверь предыдущую неподтверждённую отправку');
  const status=await service('/telegram/status',{});
  if(!status.connected)throw Error('Сервис доступен, но личный аккаунт Telegram ещё не авторизован');
  modal('Переписка в Telegram',(form,setSaveEnabled)=>{
    const query=input('search',c.telegram?.username?'@'+c.telegram.username:c.telegramHint||c.name,'Имя, @username или +381…');
    query.maxLength=120;query.enterKeyHint='search';query.autocomplete='off';
    const results=el('fieldset',null,'recipient-results'),legend=el('legend','Результаты поиска');
    const selection=text('Найди и выбери получателя. Сообщение при привязке не отправляется.');
    selection.setAttribute('role','status');selection.setAttribute('aria-live','polite');
    let renderedContacts=null;
    const find=button('Найти в Telegram',()=>picker.find());
    const picker=createRecipientSearch({search:value=>service('/telegram/search',{query:value}),onChange:({contacts,selected,busy,error,searched})=>{
      setSaveEnabled(!!selected&&!busy);
      find.disabled=busy;find.textContent=busy?'Ищу…':'Найти в Telegram';
      selection.textContent=error||(busy?'Ищу…':selected?'Выбран: '+selected.displayName+(selected.username?' · @'+selected.username:''):contacts.length?'Нажми на нужного человека:':!searched?'Найди и выбери получателя. Сообщение при привязке не отправляется.':'Не найдено. Имя в карточке может отличаться от имени в Telegram. Попробуй имя из переписки, @username или номер с кодом страны.');
      selection.className=error?'danger-text small':selected?'recipient-confirmation':'muted small';
      if(renderedContacts!==contacts){
        renderedContacts=contacts;results.replaceChildren(legend);results.hidden=!contacts.length;
        for(const contact of contacts){
          const option=input('radio');option.name='telegram-recipient';option.value=contact.peerId;
          option.addEventListener('change',()=>{if(option.checked)picker.select(contact.peerId);});
          const label=append(el('label',null,'recipient-option'),option,append(el('span'),el('strong',contact.displayName),text((contact.username?'@'+contact.username+' · ':'')+'ID '+contact.peerId)));
          results.append(label);
        }
      }
      for(const option of results.querySelectorAll('input[type=radio]')){option.checked=option.value===selected?.peerId;option.closest('label').classList.toggle('selected',option.checked);}
    }});
    setSaveEnabled(false);results.hidden=true;picker.setQuery(query.value);
    // Use input only for real edits. Mobile IMEs may emit the same value on blur.
    query.addEventListener('input',()=>picker.setQuery(query.value));
    query.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();find.click();}});
    dialog.addEventListener('close',()=>picker.dispose(),{once:true});
    append(form,text('Твой аккаунт: '+status.account.displayName+(status.account.username?' · @'+status.account.username:'')),field('Получатель',query),find,selection,results);
    const phones=[...new Set([c.profile?.phone,c.profile?.secondPhone].filter(Boolean))];
    if(phones.length)form.append(row(...phones.map((phone,index)=>button(phones.length===1?'Искать по номеру':'Искать по номеру '+(index+1),()=>{
      query.value=phone;picker.setQuery(phone);return picker.find();
    },'subtle'))));
    if(c.telegram)form.append(text('Текущий получатель: '+(c.telegram.displayName||'ID '+c.telegram.peerId)));
    return async()=>{
      const selected=picker.selected();
      if(!selected)throw Error('Выбери получателя из результатов поиска');
      await commit(s=>C.setTelegramBinding(s,c.id,{...selected,accountPeerId:status.account.peerId,verifiedAt:new Date().toISOString()}));
      message('Переписка привязана. Сообщений не отправлено.');
    };
  });
}
function connectionCodePanel(){
  const panel=el('div',null,'stack'),code=input('password','','Вставь весь текст из QR-кода на Mac'),preview=text('');
  code.autocomplete='off';code.maxLength=6000;
  code.addEventListener('input',()=>{try{preview.textContent='Адрес: '+parseConnection(code.value).serviceURL;}catch{preview.textContent='';}});
  append(panel,el('h3','Подключить с Mac'),text('Отсканируй QR подключения обычной камерой телефона, скопируй распознанный текст и вставь сюда. Это личный код доступа к сервису.'),field('Код подключения',code),preview,button('Применить подключение',async()=>{
    if(!window.TrailNative?.native)throw Error('Доступно в установленном Android-приложении');
    const value=parseConnection(code.value);
    await window.TrailNative.setSecret('serviceToken','');
    await commit(s=>{s.settings.serviceURL=value.serviceURL;s.settings.agentEnabled=false;});
    await window.TrailNative.setSecret('serviceToken',value.key);
    code.value='';
    const status=await service('/telegram/status',{});
    if(!status.connected)throw Error('Настройки сохранены, но Telegram ещё не авторизован на Mac');
    message('Подключён Telegram: '+status.account.displayName+(status.account.username?' · @'+status.account.username:''));
  },'primary'));
  return panel;
}
function telegramConnectionCheck(){
  const wrap=el('div',null,'stack'),result=text('');
  append(wrap,button('Проверить подключение Telegram',async()=>{
    result.textContent='Проверяю…';
    try{const status=await service('/telegram/status',{});result.textContent=status.connected?'Подключён: '+status.account.displayName+(status.account.username?' · @'+status.account.username:''):'Личный аккаунт Telegram ещё не авторизован в сервисе';}
    catch(error){result.textContent=error.message;throw error;}
  }),result);return wrap;
}
function importDatabase(ledgerOnly=false){const picker=input('file');picker.hidden=true;document.body.append(picker);picker.addEventListener('cancel',()=>picker.remove(),{once:true});picker.accept='.json,application/json';picker.addEventListener('change',()=>run(async()=>{const file=picker.files?.[0];picker.remove();if(!file)return;if(file.size>8*1024*1024)throw Error('Файл превышает 8 МБ');const raw=await file.text();const parsed=JSON.parse(raw);
if(parsed?.format===LEDGER_FORMAT||ledgerOnly){const ledger=parseLedgerImport(parsed);
  if(state().ledger?.datasetId===ledger.datasetId){message('Этот файл учёта уже загружен');return;}
  modal('Импорт учёта за 2026 год',form=>{
    form.append(text('Будут обновлены имена и добавлена история из бухгалтерии. Ручные оплаты и существующие привязки Telegram сохранятся.'));
    return async()=>{const result=await commit(s=>applyLedger(s,ledger,{createClient:C.createClient,setTelegramBinding:C.setTelegramBinding}));
      if(result)message('Загружено строк: '+result.rows+' · Telegram: '+result.bound);};
  });return;
}
const incoming=C.parseImport(raw);modal('Импорт базы',form=>{const mode=select([['merge','Добавить отсутствующие, сохранить мои правки'],['replace','Заменить базу из резервной копии']],'merge');append(form,text('В файле: '+Object.keys(incoming.clients).length+' человек, '+Object.keys(incoming.tasks).length+' задач.'),field('Как перенести',mode));return async()=>{if(mode.value==='replace'){await backup();incoming.settings.serviceURL=state().settings.serviceURL||'';await store.replace(incoming);}else await commit(s=>Object.assign(s,C.mergeState(s,incoming)));ui.drafts=C.clone(state().settings.drafts||{});message('База импортирована');render();};});}));picker.click();}
async function backup(){await saveDrafts();const content=C.exportState(state());if(window.TrailNative?.native)await window.TrailNative.exportJSON(content);else{const blob=new Blob([content],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='THE-TRAIL-Clients-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}
const appearanceChoices = {
  palette: [['graphite','Графит'], ['cobalt','Кобальт'], ['terracotta','Терракота'], ['plum','Слива']],
  mode: [['light','Светлая'], ['dark','Тёмная']]
};

function currentAppearance(settings = state().settings) {
  return Object.fromEntries(Object.entries(appearanceChoices).map(([key, choices]) => {
    const saved = settings.appearance?.[key];
    return [key, choices.some(([value]) => value === saved) ? saved : choices[0][0]];
  }));
}

function applyAppearance({ retryLauncher = false } = {}) {
  const { palette, mode } = currentAppearance();
  const html = document.documentElement;
  const paletteChanged = html.dataset.palette !== palette;
  if (paletteChanged || html.dataset.appearance !== mode) {
    html.dataset.palette = palette;
    html.dataset.appearance = mode;
    document.querySelector('meta[name="color-scheme"]').content = mode;
    document.querySelector('meta[name="theme-color"]').content = getComputedStyle(html).getPropertyValue('--panel').trim();
  }
  if (paletteChanged || retryLauncher) {
    window.TrailNative?.setLauncherPalette?.(palette)?.catch(() => {
      if (currentAppearance().palette === palette) message('Не удалось сменить значок Android. Попробуй выбрать палитру ещё раз.',true);
    });
  }
}

function appearancePanel() {
  const panel = el('section',null,'stack settings-section');

  function updateSelection() {
    const current = currentAppearance();
    for (const option of panel.querySelectorAll('button')) {
      option.setAttribute('aria-pressed',String(current[option.dataset.setting] === option.dataset.value));
    }
  }

  for (const [key, label] of [['palette','Палитра'], ['mode','Режим']]) {
    const options = el('div',null,'segmented appearance-options');
    const caption = el('h3',label);
    caption.id = 'appearance-' + key;
    options.setAttribute('role','group');
    options.setAttribute('aria-labelledby',caption.id);
    for (const [value, name] of appearanceChoices[key]) {
      const option = button(name, async () => {
        await commit(s => {
          s.settings.appearance = { ...currentAppearance(s.settings), [key]:value };
        },false);
        applyAppearance({ retryLauncher:key === 'palette' });
        updateSelection();
      });
      option.dataset.setting = key;
      option.dataset.value = value;
      if (key === 'palette') {
        const swatch = el('span',null,'appearance-swatch');
        swatch.setAttribute('aria-hidden','true');
        option.prepend(swatch);
      }
      options.append(option);
    }
    panel.append(caption,options);
  }
  updateSelection();
  return panel;
}
function renderSettings(){
  const page=el('div',null,'stack-lg');
  const update=el('section',null,'stack settings-section');update.id='update-panel';
  const appearance=appearancePanel();
  const data=append(el('div',null,'stack'),text(Object.keys(state().clients).length+' человек · '+Object.keys(state().records).length+' записей · версия базы '+state().schemaVersion),
    row(button('Импортировать базу',()=>importDatabase()),button('Экспортировать резервную копию',()=>backup())),
    text('Резервная копия содержит клиентские сведения. Ключи подключений в неё не входят. При обновлении интерфейса база сохраняется.'));
  const cloudPanel=el('div',null,'stack');cloudPanel.id='cloud-panel';
  const wait=input('number',state().settings.waitDays);wait.min=1;wait.max=30;
  const taskDefaults=append(el('div',null,'stack'),field('Дней до проверки ответа в новых задачах',wait),
    button('Сохранить',()=>commit(s=>{
      const n=Number(wait.value);if(!Number.isInteger(n)||n<1||n>30)throw Error('Укажи от 1 до 30 дней');s.settings.waitDays=n;
    })),text('Интервалы уже созданных задач сохраняются.'));
  const services=el('div',null,'stack'),url=input('url',currentServiceOrigin(state().settings.serviceURL)||'','https://…'),token=input('password','','Новый ключ сервиса');
  token.autocomplete='off';
  const agentEnabled=input('checkbox');agentEnabled.checked=!!state().settings.agentEnabled;
  append(services,field('Адрес твоего сервиса',url),field('Ключ доступа · оставить пустым, чтобы сохранить прежний',token),
    append(el('label',null,'checkbox'),agentEnabled,el('span','Использовать AI-разбор записей')),
    button('Сохранить подключение',async()=>{
      if(!window.TrailNative?.native)throw Error('Подключения доступны в установленном приложении');
      let base='';
      if(url.value.trim()){
        const parsed=new URL(url.value.trim());
        if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash)throw Error('Укажи HTTPS-адрес без ключей в ссылке');
        base=currentServiceOrigin(parsed.origin);
      }
      if(base!==(currentServiceOrigin(state().settings.serviceURL)||''))await window.TrailNative.setSecret('serviceToken','');
      await commit(s=>{s.settings.serviceURL=base;s.settings.agentEnabled=agentEnabled.checked;});
      if(token.value)await window.TrailNative.setSecret('serviceToken',token.value.trim());
      message('Настройки подключения сохранены');
    }),text('Агент и голос работают через твой Mac. Способ обработки указан в проверке ниже. При выключенном AI записи, цели и задачи сохраняются локально.'),
    agentConnectionCheck(),connectionCodePanel(),telegramConnectionCheck());
  if(ui.pendingVoice)services.append(text('Есть сохранённая голосовая запись для '+(state().clients[ui.pendingVoice.clientId]?.name||'клиента')),
    row(button('Открыть запись',()=>ui.pendingVoice.clientId===assistantKey?navigate('#assistant'):openClient(ui.pendingVoice.clientId)),button('Удалить аудиочерновик',async()=>{
      if(window.TrailNative?.native)await window.TrailNative.clearVoice();ui.pendingVoice=null;render();
    })));
  return append(page,el('h1','Настройки'),update,
    append(el('div',null,'reference-sections settings-folds'),
      section('Оформление','settings-appearance',[appearance]),
      section('Данные на устройстве','settings-device',[data]),
      section('Синхронизация','settings-cloud',[cloudPanel]),
      section('Задачи','settings-tasks',[taskDefaults]),
      section('Напоминания об оплате','settings-accounting',[accountingUI.settingsPanel()]),
      section('Агент и Telegram','settings-services',[services])));
}
function renderUpdate(){const panel=document.getElementById('update-panel');if(!panel)return;panel.textContent='';const u=updater.state(),errors={save:'Не удалось сохранить базу перед обновлением. Повтори после освобождения места.', 'asset-id':'Не удалось прочитать ID архива обновления. Нужен исправленный APK.', 'rate-limit':'GitHub временно ограничил загрузку. Попробуй другую сеть или повтори позже.', forbidden:'GitHub отклонил загрузку. Проверь, открывается ли выпуск в браузере.',storage:'Недостаточно места для обновления. Освободи место и повтори.',timeout:'Сервер обновлений не ответил вовремя. Повтори загрузку.','download-timeout':'Android не закончил подготовку архива. Нажми «Обновить сейчас», чтобы продолжить.',apply:'Новая версия не открылась. Нажми «Обновить сейчас», чтобы повторить запуск.',tls:'Не удалось установить защищённое соединение с сервером обновлений.',native:'Обновление интерфейса доступно в установленном Android-приложении.',manifest:'Не удалось проверить сведения об обновлении. Текущая версия сохранена.','native-required':'Для этой версии нужен новый APK. Установи его поверх приложения.','github-auth':'GitHub отклонил запрос обновления. Проверь доступ к выпуску.','release-missing':'Готовый выпуск не найден или к нему временно нет доступа.',checksum:'Архив не прошёл проверку целостности. Текущая версия сохранена.',network:'Не удалось загрузить обновление. Проверь интернет и повтори.'},labels={idle:'Проверка по нажатию',checking:'Проверяю обновление…',current:'Установлена актуальная версия',available:'Доступна версия '+u.latest,downloading:u.step==='save'?'Сохраняю данные…':'Загружаю · '+Math.round(u.progress)+'%',applying:'Открываю новую версию…',error:errors[u.error]||'Обновление не выполнено'};append(panel,el('h2','Данные и обновления'),text('THE.TRAIL Clients · '+VERSION),text(labels[u.status],u.status==='error'?'danger-text small':'muted small'));if(u.status==='error')panel.append(text('Этап: '+({save:'сохранение базы',release:'проверка выпуска',compatibility:'совместимость APK',download:'получение архива',apply:'запуск обновления'}[u.step]||'проверка')+' · код '+u.error));const progress=el('progress');progress.max=100;progress.value=u.progress;progress.hidden=u.status!=='downloading'||u.step==='save';panel.append(progress);const update=button('Обновить сейчас',()=>updater.update(),'primary');update.disabled=['checking','downloading','applying'].includes(u.status);panel.append(update);panel.append(text('Обновление сохраняет базу и черновики. При неудачном запуске возвращается предыдущая рабочая версия. Новые системные возможности могут потребовать нового APK.'));}
function render(){
  if(!store)return;
  checkGarminConnection=null;
  applyAppearance();renderRoleSwitch();
  const raw=location.hash||'#todo';
  const weekRoute=raw===TRAINING_WEEK_ROUTE||raw.startsWith(TRAINING_WEEK_ROUTE+'/');
  const pastOverview=raw===CALENDAR_ARCHIVE_ROUTE||raw.startsWith(CALENDAR_ARCHIVE_ROUTE+'/')&&raw.split('/').length<5;
  if(pastOverview)ui.open.add(CALENDAR_ARCHIVE_SECTION);
  const hash=pastOverview||weekRoute&&!canReadGroupWeek()?scheduleRoute:previewRoute(raw,roleContext());
  const athlete=isAthlete(ui.role),person=athlete?ownAthlete():null;
  ui.scheduleDay=hash===scheduleRoute?C.localDate():null;
  if(hash!==raw)history.replaceState(null,'',hash);
  if(ui.focusRoute!==hash)ui.focusRoute=null;
  const openCard=hash.startsWith('#client/')?hash.split('/')[1]:null;
  if(ui.openCard!==openCard){ui.recentlyCompleted.clear();ui.openCard=openCard;}
  const birthdayRoute=route=>['#todo/birthdays','#clients/birthdays'].includes(route);
  const sectionTab=route=>birthdayRoute(route)||route.startsWith('#todo/')||route==='#assistant'?'#todo':route==='#partners'||route.startsWith('#partners/')||route.startsWith('#admin/')?'#admin':route.startsWith('#clients/')?'#clients':route;
  const activeTab=sectionTab(
    athlete&&hash==='#account'?'#profile':hash.startsWith('#client/')?(athlete?'#profile':ui.returnTo):hash
  );
  root.replaceChildren();
  document.querySelectorAll('.app-nav a, .gear-link').forEach(a=>a.setAttribute('aria-current',a.hash===activeTab?'page':'false'));
  if(hash==='#profile')root.append(person?renderClient(person.id):text('Выбери карточку спортсмена в меню под логотипом.'));
  else if(hash.startsWith('#client/')){
    const [,id,type,target]=hash.split('/');
    if(type==='goal'&&ui.focusRoute!==hash&&ui.goalFilters)ui.goalFilters[id]='';
    const client=state().clients[id];
    if(type==='sources'){
      if(athlete&&person?.id===id&&isOwnerPerson(person))root.append(athleteSourcesPage(person));
      else navigate(athlete?'#profile':'#client/'+id);
    }
    else if(type==='training-plan'){
      if(previewTrainingVisible(state(),client,roleContext()))root.append(trainingCalendarUI.page(client,{
        back:athlete?'#profile':'#client/'+client.id,canImport:ui.role==='superadmin'
      }));
      else navigate(athlete?'#profile':'#client/'+id);
    }
    else if(type==='restriction'&&target&&hasAthleteCard(client)&&!client.mergedInto)root.append(restrictionCard(client,target));
    else if(type==='training'&&target&&client?.athlete&&!client.mergedInto)root.append(athleteUI.entry(client,target));
    else if(hasAthleteCard(client)&&!client.mergedInto&&['load','recovery'].includes(type))root.append(athleteUI.logPage(client,type));
    else if(hasAthleteCard(client)&&!client.mergedInto&&type==='metric'&&['restHr','lt1','lthr','zones'].includes(target))
      root.append(athleteUI.metricPage(client,target));
    else {
      if(type==='training')ui.open.add(id+'-zones');
      root.append(renderClient(id,type,target));
    }
  }else if(birthdayRoute(hash))root.append(renderTodo('birthdays'));
  else if(hash==='#todo/payments')root.append(renderTodo('payments'));
  else if(hash===scheduleRoute)root.append(renderTodo('schedule'));
  else if(weekRoute)root.append(trainingWeekUI.page(hash,{canImport:ui.role==='superadmin'}));
  else if(hash.startsWith(CALENDAR_ARCHIVE_ROUTE+'/')){
    const [month,eventId,extra]=hash.slice(CALENDAR_ARCHIVE_ROUTE.length+1).split('/');
    if(!eventId||extra||!C.validDate(month+'-01')||month>C.localDate().slice(0,7))navigate(CALENDAR_ARCHIVE_ROUTE);
    else try{root.append(calendarUI.session(decodeURIComponent(eventId),month));}
    catch{navigate(CALENDAR_ARCHIVE_ROUTE);}
  }
  else if(hash.startsWith(scheduleRoute+'/')){
    try{root.append(calendarUI.session(decodeURIComponent(hash.slice(scheduleRoute.length+1))));}
    catch{navigate(scheduleRoute);}
  }
  else if(hash==='#clients'||hash.startsWith('#clients/')){
    const view=hash.split('/')[1];root.append(renderCatalog(Object.hasOwn(catalogViews,view)?view:'active'));renderCatalogResults();
  }else if(hash==='#calendar'){
    if(athlete)root.append(person?trainingCalendarUI.page(person,{calendar:true}):text('Выбери карточку спортсмена в меню под логотипом.'));
    else root.append(canReadGroupWeek()?trainingWeekUI.page(TRAINING_WEEK_ROUTE,{canImport:false,calendar:true}):
      append(el('div',null,'stack'),el('h1','Календарь'),text('У этого тренера пока нет загруженной недели группы.')));
  }
  else if(hash==='#account')root.append(athlete?(person?accountingUI.clientPanel(person,{readOnly:true})
    :text('Выбери карточку спортсмена в меню под логотипом.')):accountingUI.page());
  else if(hash==='#races')root.append(detailsUI.races(athlete?{participantId:person?.id||null}:undefined));
  else if(hash==='#admin')root.append(adminUI.page({athlete,person}));
  else if(hash.startsWith('#admin/team/'))root.append(adminUI.card(hash.split('/')[2]));
  else if(hash==='#partners'){ui.open.add('admin-partners');root.append(adminUI.page());}
  else if(hash.startsWith('#partners/')){const [,id,,taskId]=hash.split('/');root.append(partnersUI.card(id,taskId));}
  else if(hash==='#assistant')root.append(renderAssistant());
  else if(hash==='#settings'){
    root.append(renderSettings());renderUpdate();renderCloudPanel();
    if(ui.focusCloudPanel){ui.focusCloudPanel=false;queueMicrotask(()=>document.getElementById('cloud-panel')?.closest('details')?.scrollIntoView({block:'start'}));}
  }
  else root.append(renderTodo());
  void refreshGarmin(garminRouteClient(hash));
}
async function migrateSavedServiceOrigin() {
  const saved=state().settings.serviceURL;
  const current=currentServiceOrigin(saved);
  if(current===saved)return;
  try {
    await store.mutate(s=>{s.settings.serviceURL=current;});
  } catch {
    message('Используется новый адрес сервиса. Сохранить его на устройстве пока не удалось.',true);
  }
}
async function start(){
  const bridge=window.TrailNative;
  try{
    bindHeaderControls();
    store=await createStore(bridge?.native?bridge.adapter:browserAdapter());
    if(bridge?.native)await migrateSavedServiceOrigin();
    applyAppearance();
    ui.drafts=C.clone(state().settings.drafts||{});
    if(bridge?.native){
      try{ui.pendingVoice=await bridge.loadVoice();}
      catch{message('Голосовой черновик не удалось прочитать. База клиентов доступна.',true);}
    }
    updater=createUpdater({version:VERSION,bridge,flush:async()=>{await saveDrafts();await store.flush();},onChange:u=>{
      renderUpdate();
      const link=document.querySelector('.gear-link');
      if(link){
        link.classList.toggle('has-update',u.status==='available');
        link.setAttribute('aria-label',u.status==='available'?'Настройки · доступно обновление':'Настройки');
      }
    }});
    if(!location.hash)history.replaceState(null,'','#todo');
    bindClientsTab();
    window.addEventListener('hashchange',()=>{render();window.scrollTo({top:0});});
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden)run(()=>saveDrafts());
      else if(ui.scheduleDay&&ui.scheduleDay!==C.localDate())render();
    });
    startCloud();
    render();
    renderCloudStatus();
    if(await bridge?.ready(VERSION))message('Обновлено до '+VERSION);
    if(bridge?.native){
      void refreshMicrophonePermission().then(()=>{
        if(!ui.recorder&&!ui.voiceStartingClientId&&!ui.voiceSavingClientId&&
          (location.hash.startsWith('#client/')||location.hash==='#assistant'||location.hash==='#settings'))render();
      });
      setTimeout(()=>updater.check(),1500);
    }
  }catch(e){
    root.textContent='';
    append(root,el('h1','Не удалось открыть базу'),text(e.message,'danger-text'),
      text('Не удаляй приложение: данные могут оставаться на устройстве.'),button('Повторить',()=>location.reload()));
  }
}
start();
