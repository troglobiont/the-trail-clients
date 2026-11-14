import * as C from './core.js';
import { assistantKind, mentionsCompletedSession, suggestAssistantClients } from './assistant.js';
import { CURRENCIES, PACKAGES, activeService, amountMinor, clientServices, matchingTariffClients, serviceBalance } from './accounting.js';
import {createStore,browserAdapter} from './store.js';
import {createUpdater} from './updates.js';
import {parseConnection} from './connection.js';
import {createRecipientSearch} from './telegram-picker.js';
import {microphoneAccess,microphoneState} from './microphone.js';
import {createAccountingUI} from './accounting-ui.js';
import {applyLedger, LEDGER_FORMAT, parseLedgerImport} from './ledger-import.js';
import {createCloudAPI} from './cloud-api.js';
import {createCloudSync} from './cloud-sync.js';
import {createClientDetailsUI} from './client-details-ui.js';
import {birthdayReminders,telegramReminders,GOAL_TYPES} from './client-details.js';
import {cloudConfig} from './cloud-config.js';
const VERSION=__APP_VERSION__;
const root=document.getElementById('app'),notice=document.getElementById('notice'),dialog=document.getElementById('editor');
let store,updater,cloud,noticeTimer,draftTimer;
const catalogViews = { active:'Клиенты', occasional:'Разовые', paused:'На паузе', archive:'Архив', team:'Команда', pending:'До старта' };
const CATALOG_PAGE_SIZE = 12;
const defaultFilters=()=>({query:'',format:'all',quick:'all',basis:'all',level:'all',personal:'all',
  packageFilter:'all',tariffCurrency:'all',paymentCurrency:'all',paymentMonth:C.localDate().slice(0,7)});
const ui={filters:defaultFilters(),catalogScope:'active',pauseFilter:null,catalogLimit:CATALOG_PAGE_SIZE,
  contactOrder:false, recentlyCompleted:new Set(), taskFilter:'all',returnTo:'#clients',open:new Set(),drafts:{},sendAck:{},recordResults:{},busy:new Set(),update:{status:'idle'}};
const state=()=>store.state();
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined&&text!==null)node.textContent=text;if(className)node.className=className;return node;}
function append(parent,...children){parent.append(...children.filter(Boolean));return parent;}
function button(text,fn,className=''){const b=el('button',text,className);b.type='button';b.addEventListener('click',()=>run(async()=>{b.disabled=true;try{await fn();}finally{if(b.isConnected)b.disabled=false;}}));return b;}
function message(value,error=false,action=null){
  clearTimeout(noticeTimer);notice.replaceChildren(el('span',value));notice.className='notice'+(error?' error':'');
  if(action)notice.append(button(action.label,async()=>{await action.run();clearTimeout(noticeTimer);notice.hidden=true;},'notice-action'));
  notice.hidden=false;noticeTimer=setTimeout(()=>{notice.hidden=true;},action||error?9000:4500);
}
async function run(fn){try{await fn();}catch(e){message(e.message||'Операция не выполнена',true);}}
async function commit(fn,redraw=true){document.getElementById('save-status').textContent='Сохраняю…';try{const value=await store.mutate(fn);renderCloudStatus();if(redraw)render();return value;}catch(e){document.getElementById('save-status').textContent='Не сохранено';throw e;}}
function row(...items){return append(el('div',null,'row'),...items);}
function text(text,className='muted small'){return el('div',text,className);}
function field(label,input){return append(el('label',label),input);}
function input(type='text',value='',placeholder=''){const i=el('input');i.type=type;i.value=value;i.placeholder=placeholder;return i;}
function select(values,value){const s=el('select');for(const item of values){const [v,label]=Array.isArray(item)?item:[item,item],o=el('option',label);o.value=v;s.append(o);}s.value=value;return s;}
function clientStatus(c) {
  if (c.role !== 'Клиент') return C.clientRole(c);
  if (C.clientSection(c) === 'occasional') return 'Разово';
  if (c.status === 'На паузе') return 'На паузе · ' + C.PAUSE_KINDS[C.pauseKind(c)].toLowerCase();
  return c.status;
}
function chips(c){const list=el('span',null,'row');for(const value of c.role==='Клиент'?[clientStatus(c),c.format,'Основа: '+c.basis]:[C.clientRole(c)])list.append(el('span',value,'chip'));if(c.level==='Премиум')list.append(el('span','Премиум','chip emphasis'));if(['gym','outside'].includes(c.personal))list.append(el('span',c.personal==='gym'?'Персональный зал с Сергеем':'Персонально с Сергеем · улица','chip emphasis'));return list;}
function formatDate(iso,withTime=false){if(!iso)return '';return new Intl.DateTimeFormat('ru-RU',{timeZone:C.TIMEZONE,day:'numeric',month:'short',...(withTime?{hour:'2-digit',minute:'2-digit'}:{})}).format(new Date(iso.length===10?iso+'T12:00:00Z':iso));}
function section(title,key,children){const d=el('details',null,'fold'),summary=el('summary',title);d.open=ui.open.has(key);d.addEventListener('toggle',()=>{if(d.open)ui.open.add(key);else ui.open.delete(key);});append(d,summary,append(el('div',null,'fold-body stack'),...children));return d;}
function navigate(hash){location.hash=hash;}
function openClient(clientId,type,target){ui.returnTo=location.hash.startsWith('#client/')?ui.returnTo:location.hash||'#todo';navigate('#client/'+clientId+(type?'/'+type+(target?'/'+target:''):''));}
const detailsUI=createClientDetailsUI({state,ui,el,append,button,row,field,input,select,text,section,modal,commit,render,formatDate,openClient,message});
const accountingUI=createAccountingUI({state,el,append,button,row,field,input,select,text,section,modal,commit,render,formatDate,navigate,message,importLedger:()=>importDatabase(true),
  searchClients:query=>C.filterClients(state(),{query,role:'Клиент'}),
  activateClient:(s,id,day)=>C.editClient(s,id,{status:'Активный',engagement:null,pause:null},day),
  openClient(clientId){ui.open.add(clientId+'-account');openClient(clientId);}
});
function modal(title,build,{saveLabel='Сохранить',onSaved}={}){
  dialog.textContent='';
  const form=el('form'),heading=el('h2',title),error=text('','form-error');
  heading.id='editor-title';error.setAttribute('role','alert');form.append(heading);
  let save;
  const saveControl=saveLabel&&button(saveLabel,async()=>{
    try{await save();dialog.close();onSaved?.();}catch(e){error.textContent=e.message;}
  },'primary');
  save=build(form,enabled=>{if(saveControl)saveControl.disabled=!enabled;error.textContent='';});
  const controls=row(button('Отмена',()=>dialog.close()),saveControl);
  form.addEventListener('submit',e=>{e.preventDefault();if(saveControl&&!saveControl.disabled)saveControl.click();});
  append(form,error,controls);dialog.append(form);
  if(dialog.open)(form.querySelector('[autofocus]')||form.querySelector('select,input,button'))?.focus();
  else dialog.showModal();
}

const cloudLabels={working:'Синхронизация…',synced:'Синхронизировано',pending:'Ждёт синхронизации',conflict:'Нужно выбрать версию',error:'Ждёт синхронизации'};
function renderCloudStatus(){
  const view=cloud?.state();
  const pending=state().cloudSync&&Object.keys(state().cloudSync.pending).length;
  document.getElementById('save-status').textContent=pending&&view?.status==='synced'?'Ждёт синхронизации':cloudLabels[view?.status]||'На устройстве';
  renderCloudPanel();
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
  const retry=()=>cloud.sync();
  window.addEventListener('online',retry);
  window.addEventListener('trail-app-active',retry);
  setInterval(()=>{if(!document.hidden)retry();},45000);
  renderCloudStatus();
  run(()=>cloud.restore());
}
function editClient(clientId=null) {
  const c = clientId ? state().clients[clientId] : null;
  modal(c ? 'Данные клиента' : 'Новый клиент', form => {
    const name = input('text', c?.name || '');
    name.maxLength = 180;
    const role = select(['Клиент','Тренер','Организатор'], c ? C.clientRole(c) : 'Клиент');
    const status = select([...C.STATUSES, ['occasional','Разово']], c?.engagement === 'occasional' ? 'occasional' : C.STATUSES.includes(c?.status) ? c.status : 'Активный');
    const pauseType = select(Object.entries(C.PAUSE_KINDS), c ? C.pauseKind(c) : 'open');
    const returnWindow = input('text', c?.pause?.returnWindow || '', 'Например, в январе');
    returnWindow.maxLength = 140;
    const contactOn = input('date', c?.pause?.contactOn || '');
    const pauseFields = append(el('div',null,'stack'), field('Вид паузы',pauseType), field('Ориентир возврата',returnWindow), field('Связаться',contactOn));
    const date = input('date', C.localDate());
    date.max = C.localDate();
    const effective = field('Дата изменения статуса',date);
    const statusField = field('Статус сотрудничества',status);
    form.append(field('Фамилия Имя',name));
    const classification=el('div',null,'stack');
    append(classification,field('Роль',role),statusField,pauseFields);
    const controls = {
      format:select(['Очно','Дистанционно','Уточнить'],c?.format||'Уточнить'),
      basis:select(C.BASES,c?.basis||'Сейчас плана нет'),
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
    const actualStatus = () => status.value === 'occasional' ? 'Активный' : status.value;
    const syncFields = () => {
      const isClient = role.value === 'Клиент';
      statusField.hidden = !isClient;
      pauseFields.hidden = !isClient || status.value !== 'На паузе';
      effective.hidden = !isClient || c?.role === 'Клиент' && actualStatus() === c.status;
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
        pause:!pauseFields.hidden ? {kind:pauseType.value,returnWindow:returnWindow.value.trim(),contactOn:contactOn.value || null} : null
      };
      if (!values.name) throw Error('Введи имя');
      return commit(s=>c ? C.editClient(s,c.id,values,date.value) : C.createClient(s,values,date.value));
    };
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
    scope === 'active' && Object.keys(state().clients).length && button('Добавить клиента',()=>editClient(),'subtle')));
  if (!Object.keys(state().clients).length) {
    page.append(emptyDatabase());
    return page;
  }

  const search = input('search',ui.filters.query,'Поиск (фамилия имя)');
  search.setAttribute('aria-label','Поиск (фамилия имя)');
  search.maxLength = 100;
  search.addEventListener('input',()=>{
    ui.filters.query = search.value;
    ui.catalogLimit = CATALOG_PAGE_SIZE;
    renderCatalogResults();
  });
  page.append(scope === 'active' ? activeCatalogFilters(search) : search);
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
  filters.setAttribute('aria-label','Вид паузы');
  const paused = C.filterClients(state(),{ section:'paused' });
  for (const [key,label] of Object.entries(C.PAUSE_KINDS)) {
    const count = paused.filter(c=>C.pauseKind(c) === key).length;
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

function activeCatalogFilters(search) {
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
  const extra = el('div',null,'filters');
  const currencyOptions = [['all','Любая'],...CURRENCIES];
  for (const [key,label,values] of [
    ['packageFilter','Пакет',[['all','Любой'],['all-online','Весь онлайн'],...Object.entries(PACKAGES),['personal-gym','Персональная тренировка · зал']]],
    ['tariffCurrency','Валюта тарифа',currencyOptions],
    ['paymentCurrency','Валюта поступления',currencyOptions],
    ['format','Формат сейчас',[['all','Любой'],['Очно','Очно'],['Дистанционно','Онлайн'],['Уточнить','Нужно уточнить']]],
    ['basis','Основа плана',[['all','Любая'],...C.BASES]],
    ['level','Ведение',[['all','Любое'],'Обычное','Премиум']],
    ['personal','Персональные с Сергеем',[['all','Любые'],['gym','В зале'],['outside','На улице'],['none','Нет'],['unknown','Нужно уточнить']]]
  ]) extra.append(filterControl(key,label,values));
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
  extra.append(monthField);
  const advanced = append(el('div',null,'stack catalog-advanced'),
    extra,button('Сбросить фильтры',()=>{
      ui.filters = {...defaultFilters(),query:ui.filters.query};
      ui.contactOrder = false;
      ui.catalogLimit = CATALOG_PAGE_SIZE;
      render();
    },'subtle')
  );
  advanced.id='catalog-filters';
  advanced.hidden=!ui.open.has(advanced.id);
  const toggle=button('Фильтры',()=>{
    advanced.hidden=!advanced.hidden;
    if(advanced.hidden)ui.open.delete(advanced.id);
    else ui.open.add(advanced.id);
    toggle.setAttribute('aria-expanded',String(!advanced.hidden));
  });
  toggle.setAttribute('aria-controls',advanced.id);
  toggle.setAttribute('aria-expanded',String(!advanced.hidden));
  return append(el('div',null,'stack catalog-options'),append(el('div',null,'catalog-search'),search,toggle),quick,advanced);
}

function filterControl(key,label,values) {
  const control = select(values,ui.filters[key]);
  control.addEventListener('change',()=>{
    ui.filters[key] = control.value;
    ui.catalogLimit = CATALOG_PAGE_SIZE;
    if (key === 'paymentCurrency') document.getElementById('catalog-payment-month').hidden = control.value === 'all';
    renderCatalogResults();
  });
  return field(label,control);
}

function renderCatalogResults() {
  const list = document.getElementById('client-tiles');
  if (!list) return;
  const scope = ui.catalogScope;
  const tariffs = scope === 'active' ? matchingTariffClients(state(),ui.filters) : null;
  const clients = C.filterClients(state(),{ ...ui.filters,section:scope,pauseKind:ui.pauseFilter })
    .filter(c=>!tariffs || tariffs.has(c.id));
  const byContact=scope==='active'&&ui.contactOrder;
  if(byContact)clients.sort((a,b)=>(a.lastContact?.at||'').localeCompare(b.lastContact?.at||''));
  const accountingClients = accountingUI.activeClientIds();
  list.replaceChildren();
  for (const c of clients.slice(0,ui.catalogLimit)) {
    const item = button(c.name,()=>openClient(c.id),'client-directory-item');
    item.setAttribute('aria-label','Открыть клиента: '+c.name);
    const detail = scope === 'paused' ? c.pause?.returnWindow || (c.pause?.contactOn && 'Связаться ' + formatDate(c.pause.contactOn))
      : scope === 'team' ? C.clientRole(c) : byContact ? c.lastContact?.at ? 'Контакт '+formatDate(c.lastContact.at)+' '+c.lastContact.at.slice(0,4) : 'Контакт не записан' : '';
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
function renderBirthdays(){
  const today=C.localDate();
  const days=ui.birthdayDays||30;
  const birthdays=birthdayReminders(state(),today,days);
  const periods=el('div',null,'row catalog-quick');
  periods.setAttribute('role','group');
  periods.setAttribute('aria-label','Период');
  for(const count of [30,90]){
    const control=button(count+' дней',()=>{ui.birthdayDays=count;render();});
    control.setAttribute('aria-pressed',String(count===days));
    periods.append(control);
  }
  const list=el('div',null,'client-directory');
  for(const {client,day} of birthdays){
    const dayLabel=day===today?'Сегодня · '+formatDate(day):formatDate(day);
    const entry=button(client.name,()=>openClient(client.id,'profile'),'client-directory-item');
    entry.append(text(dayLabel));
    list.append(append(el('div',null,'directory-row'),entry));
  }
  return append(el('div',null,'stack catalog-page'),
    button('← К ToDo',()=>navigate('#todo'),'back subtle'),
    el('h1','Дни рождения'),periods,
    birthdays.length?list:text('На ближайшие '+days+' дней нет записанных дней рождения.'));
}

function renderTodo(){
  const page=el('div',null,'stack-lg');
  const tasks=C.clientTasks(state()).map(t=>({
    name:state().clients[t.clientId].name,title:t.title,due:C.taskDate(t),
    next:taskStateLabel(t),reply:t.needsReply,warning:C.taskWarning(t),open:()=>openClient(t.clientId,'task',t.id)
  }));
  const payment=accountingUI.todoItems();
  const birthday=birthdayReminders(state()).map(({client,day})=>({
    name:client.name,title:'День рождения',due:day,next:'Можно поздравить',reminder:true,open:()=>openClient(client.id,'profile')
  }));
  const telegram=telegramReminders(state()).map(({client,day})=>({
    name:client.name,title:'Давно не открывал переписку',due:day,next:'Проверить Telegram',reminder:true,open:()=>openClient(client.id,'telegram')
  }));
  const entries=[...tasks,...payment,...birthday,...telegram].sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999'));
  const birthdays=button('DR',()=>navigate('#todo/birthdays'),'subtle');
  birthdays.setAttribute('aria-label','DR — Дни рождения');
  append(page,append(el('div',null,'page-title'),el('h1','ToDo'),row(text(entries.length+' в списке'),birthdays)));
  if(!Object.keys(state().clients).length){page.append(emptyDatabase());return page;}
  const filters=el('div',null,'row catalog-quick');
  const matches=(value,e)=>value==='all'||(value==='reply'?e.reply:value==='reminders'?e.reminder:!e.reminder&&!e.reply);
  for(const [value,label] of [['all','Все'],['mine','Мои действия'],['reply','Нужен ответ'],['reminders','Напоминания']]){
    const b=button(label+' · '+entries.filter(e=>matches(value,e)).length,()=>{ui.taskFilter=value;render();});
    b.setAttribute('aria-pressed',String(ui.taskFilter===value));filters.append(b);
  }
  const list=el('div',null,'stack');
  for(const item of entries.filter(e=>matches(ui.taskFilter,e))){
    const b=button('',item.open,'task-tile');
    append(b,el('span',item.name,'task-client-name'),item.payment&&el('span','◈ Оплата','chip payment-chip'),el('span',item.title,'task-title'),
      text((item.due?formatDate(item.due):'Без срока')+' · '+item.next));
    if(item.warning)b.append(text(item.warning.text,item.warning.level==='danger'?'danger-text small':'warning-text small'));
    list.append(b);
  }
  append(page,filters,list.children.length?list:text('Открытых задач в этом разделе нет.'));
  return page;
}
function editTask(t){
  modal('Редактировать задачу',form=>{
    const title=el('textarea'),due=input('date',t.due||'');title.value=t.title;title.maxLength=1000;
    const goals=Object.values(state().goals).filter(g=>g.clientId===t.clientId&&!g.deletedAt);
    const goal=select([['','Не связана'],...goals.map(g=>[g.id,g.title])],C.taskGoal(state(),t)?.id||'');
    append(form,!t.pauseContact&&field('Что сделать',title),field('Когда сделать · можно оставить пустым',due),
      !t.pauseContact&&goals.length&&field('Связанная цель',goal));
    if(t.phase==='waiting')form.append(text('Проверка ответа остаётся '+formatDate(t.checkOn)+'. Её интервал меняется в настройках задачи.'));
    return ()=>commit(s=>{
      if(t.pauseContact){
        const c=s.clients[t.clientId];
        C.editClient(s,c.id,{pause:{...c.pause,contactOn:due.value||null}});
      }else C.editTask(s,t.id,title.value,due.value||null,goals.length?goal.value||null:undefined);
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
  if(t.phase==='done'){
    wrap.classList.add('task-completed');
    return append(wrap,el('div',t.title,'task-title'),row(el('span','Выполнено','chip'),
      button('Вернуть в работу',()=>commit(s=>C.completeTask(s,t.id,false)),'subtle')));
  }
  wrap.append(append(el('div',null,'task-heading'),el('div',t.title,'task-title'),button('Изменить',()=>editTask(t),'subtle')));
  wrap.append(text((t.due&&t.phase==='todo'?formatDate(t.due)+' · ':'')+taskStateLabel(t)));
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
  modal(feature ? 'Изменить особенность' : 'Добавить особенность', form => {
    const note = el('textarea');
    note.value = feature?.text ?? '';
    note.rows = 5;
    const kinds = ['Сейчас', 'Постоянно учитывать', 'На этой неделе'];
    if (feature?.kind && !kinds.includes(feature.kind)) kinds.push(feature.kind);
    const kind = select(kinds, feature?.kind || kinds[0]);
    append(form, field('Суть', note), field('Когда учитывать', kind));
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

function renderFeatures(client) {
  const active=client.features.filter(f=>f.active!==false);
  return append(el('section',null,'stack feature-section'),
    append(el('div',null,'row between feature-heading'),el('h2','Особенности','block-heading'),
      button('+ Добавить',()=>editFeature(client.id),'feature-add')),
    ...active.map(f=>featureRow(client.id,f)),
    !active.length&&text('Пока не зафиксированы'));
}

function pauseDetails(client) {
  if (!['paused','archive'].includes(C.clientSection(client))) return null;
  return append(el('section',null,'stack'),
    client.pause?.returnWindow&&text('Ориентир возврата · '+client.pause.returnWindow),
    row(button('Возобновить',()=>accountingUI.resumeClient(client))));
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
  const features=new Map(c.features.map(f=>[f.id,f]));
  const past=Object.values(state().tasks).filter(t=>t.clientId===c.id&&t.phase==='done');
  for(const t of past.sort((a,b)=>(b.closedAt||'').localeCompare(a.closedAt||''))){
    history.append(append(el('li'),text('Выполнено'+(t.closedAt?' · '+formatDate(t.closedAt,true):'')),el('div',t.title),
      button('Вернуть в работу',async()=>{await commit(s=>C.completeTask(s,t.id,false));focusCard('task',t.id);},'subtle')));
  }
  for(const f of features.values())if(f.active===false) {
    history.append(append(el('li'),text('Прежняя особенность'),el('div',f.text,'feature-copy'),
      button('Снова актуально',async()=>{await commit(s=>C.setFeatureActive(s,c.id,f.id,true));focusCard('feature',f.id);},'subtle')));
  }
  const events=state().events.filter(e=>e.clientId===c.id).slice().reverse()
    .filter(e=>!(e.type==='task-closed'&&state().tasks[e.entityId]?.phase==='done')&&!(e.type==='feature-archived'&&features.get(e.entityId)?.active===false)).slice(0,100);
  const lastPause=events.find(e=>e.type==='pause-contact-completed');
  for(const e of events){
    const record=state().records[e.entityId],goal=state().goals[e.entityId],t=state().tasks[e.entityId],f=features.get(e.entityId);
    const title=e.text||record?.text||goal?.title||t?.title||f?.text;
    const entry=append(el('li'),text([e.sourceMeta||formatDate(e.at,true),eventLabel(e.type)].filter(Boolean).join(' · ')),
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

function renderClient(clientId,targetType,targetId){
  const c=state().clients[clientId];
  if(!c||c.mergedInto){navigate('#clients');return el('div');}
  const page=el('div',null,'stack-lg client-page');
  const backLabel={'#todo':'← К ToDo','#account':'← К учёту','#races':'← К стартам','#todo/birthdays':'← К дням рождения'}[ui.returnTo]||'← К списку клиентов';
  page.append(button(backLabel,()=>navigate(ui.returnTo),'back subtle'));
  const header=el('header',null,'stack client-header');
  append(header,append(el('div',null,'page-title'),el('h1',c.name),button('Изменить',()=>editClient(c.id),'subtle')),chips(c),
    text(c.lastContact?'Последний контакт: '+formatDate(c.lastContact.at,!c.lastContact.dateOnly)+' · '+c.lastContact.channel:'Последний контакт пока не указан'));
  const followUp=pauseDetails(c);
  append(page,header,followUp);
  const tasks=[...C.clientTasks(state(),clientId),...Array.from(ui.recentlyCompleted,id=>state().tasks[id])
    .filter(t=>t?.clientId===clientId&&t.phase==='done')];
  if(tasks.length)page.append(append(el('section',null,'panel action-panel'),el('h2','Действия по клиенту','block-heading'),...tasks.map(task)));
  page.append(renderFeatures(c));
  if(c.role==='Клиент')page.append(accountingUI.clientPanel(c));
  const reference=el('div',null,'reference-sections');
  const telegram=section('Сообщения в Telegram',c.id+'-telegram',[telegramPanel(c)]);
  telegram.id='telegram-client-panel';telegram.tabIndex=-1;
  const profile=section('О клиенте',c.id+'-profile',detailsUI.profile(c));
  profile.id='profile-client-panel';profile.tabIndex=-1;
  reference.append(telegram,profile,section('Тренировочные данные · пульсовые зоны',c.id+'-zones',detailsUI.training(c)));
  reference.append(detailsUI.goals(c,()=>{
    const draft=getDraft(c.id);draft.kind='goal';
    const form=document.getElementById('compose');
    form.querySelectorAll('[data-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.kind==='goal')));
    document.getElementById('goal-status-field').hidden=false;
    document.getElementById('task-fields').hidden=true;
    form.scrollIntoView({behavior:'smooth',block:'start'});
    document.getElementById('client-note').focus({preventScroll:true});
    saveDraftSoon();
  }));
  reference.append(section('Кемпы и история участия',c.id+'-camps',c.camps?.length?c.camps.map(camp=>text(camp.name+' · '+camp.status,' ')):[text('История участия пока не восстановлена')]));
  reference.append(section('История записей',c.id+'-history',[renderHistory(c)]));
  page.append(reference,compose(c));
  if(targetType&&ui.focusRoute!==location.hash){
    ui.focusRoute=location.hash;
    if(targetType==='goal'){
      ui.open.add(c.id+'-goals');
    }
    focusCard(targetType,targetId);
  }
  return page;
}
function eventLabel(type){return ({'pause-contact-completed':'Связь после паузы отмечена','telegram-opened':'Открыта переписка в Telegram','profile-edited':'Обновлены сведения о клиенте','training-edited':'Обновлены тренировочные данные','record-created':'Запись Сергея','goal-created':'Цель добавлена','goal-edited':'Цель изменена','goal-deleted':'Цель удалена','goal-restored':'Цель восстановлена','task-created':'Задача создана','task-edited':'Задача изменена','telegram-linked':'Переписка привязана','telegram-unlinked':'Переписка отвязана','task-closed':'Задача закрыта','task-reopened':'Задача возвращена','outbound':'Исходящее сообщение','task-scheduled':'Разговор назначен','client-edited':'Данные клиента изменены','client-created':'Клиент добавлен','client-movement':'Статус сотрудничества изменён','feature-created':'Особенность добавлена','feature-edited':'Особенность изменена','feature-archived':'Особенность снята с актуального','feature-restored':'Особенность снова актуальна','contact':'Контакт с клиентом','source-note':'Сведения от Сергея'})[type]||'Изменение';}
function getDraft(clientId){return ui.drafts[clientId]||(ui.drafts[clientId]={text:'',kind:'record',needsReply:false,due:'',goalStatus:'Желание клиента'});}
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
  const status=select(C.GOAL_STATUSES,d.goalStatus||'Желание клиента');
  status.addEventListener('change',()=>{d.goalStatus=status.value;saveDraftSoon();});
  const type=select([['','Без типа'],...Object.entries(GOAL_TYPES)],d.goalType||'');
  type.addEventListener('change',()=>{d.goalType=type.value;saveDraftSoon();});
  const goalField=append(el('div',null,'stack'),field('Статус цели',status),field('Тип цели',type));goalField.id='goal-status-field';goalField.hidden=d.kind!=='goal';
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
    send.textContent=submitting?'Обрабатываю запись…':starting?'Подключаю микрофон…':saving?'Сохраняю аудио…':recognizing?'Распознаю голос…':recording?'Остановить и распознать':pending?'Распознать сохранённую запись':d.text.trim()?(state().settings.serviceURL&&!state().settings.agentEnabled?'Включить агента и обработать':state().settings.serviceURL?'Передать запись в чат':d.kind==='task'?'Создать задачу':d.kind==='goal'?'Добавить цель':'Сохранить запись'):(microphoneLabel||(state().settings.serviceURL&&!state().settings.agentEnabled?'Включить агента и надиктовать':'Надиктовать запись'));
    hint.textContent=recognizing?'Расшифровываю голос на Mac…':recording?'Идёт запись. Говори, затем нажми «Остановить и распознать».':pending?'Аудио сохранено на устройстве. Нажми кнопку для повторной расшифровки.':otherRecording?'Сначала останови запись в карточке другого клиента.':d.text.trim()?'Проверь текст. Кнопка передаст его на обработку.':permission?.settingsRequired?'Android больше не показывает запрос. Кнопка откроет настройки THE.TRAIL Clients: Разрешения → Микрофон.':microphoneLabel?'Нажми кнопку и разреши микрофон в системном окне Android. После разрешения начнётся запись.':'Текст вводить не нужно: нажми кнопку ниже и говори.';
    extra.hidden=!d.text.trim()||!!recording||pending||recognizing||starting||saving;extra.disabled=submitting;
    localSave.hidden=!d.text.trim()||state().settings.agentEnabled||!state().settings.serviceURL||!!recording||pending||recognizing||starting||saving;localSave.disabled=submitting;
    localSave.textContent=d.kind==='task'?'Создать задачу без агента':d.kind==='goal'?'Добавить цель без агента':'Сохранить без агента';
  }
  note.addEventListener('input',()=>{d.text=note.value;d.pendingRecordId=null;updateAction();saveDraftSoon();});
  append(form,modes,note,taskFields,goalField,hint,send,extra,localSave);
  if(!state().settings.serviceURL)form.append(text('Для диктовки подключи Mac в настройках. Текст можно сохранить на устройстве.'));
  else if(!state().settings.agentEnabled)form.append(text('AI-разбор включится при нажатии кнопки после проверки подключения.'));
  if(ui.recordResults[c.id])form.append(text(ui.recordResults[c.id],'record-result'));
  form.addEventListener('submit',e=>{e.preventDefault();run(async()=>{
    if(send.disabled)return;
    if(ui.pendingVoice?.clientId===c.id){await transcribeVoice(ui.pendingVoice);return;}
    if(ui.recorder||!d.text.trim()){await recordVoice(c.id);return;}
    submitting=true;updateAction();
    try{if(state().settings.serviceURL&&!state().settings.agentEnabled)await ensureAgent(false);await submitRecord(c,d);}
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
async function submitRecord(c,d){const data={...d};const pending=state().records[d.pendingRecordId];const record=pending&&pending.text===data.text.trim()&&pending.kind===data.kind?pending:await commit(s=>C.saveRecord(s,c.id,data.text,data.kind),false);d.pendingRecordId=record.id;await saveDrafts();let result;if(state().settings.serviceURL&&state().settings.agentEnabled){try{const response=await service('/records/parse',{client:agentClient(state().clients[c.id]),goals:Object.values(state().goals).filter(g=>g.clientId===c.id&&!g.deletedAt),openTasks:C.clientTasks(state(),c.id).filter(t=>!t.pauseContact),record,timezone:C.TIMEZONE,waitDays:state().settings.waitDays,needsReply:data.needsReply});if(response.question){ui.recordResults[c.id]='Нужно уточнить: '+response.question;render();return;}result=await commit(s=>C.applyAgentResult(s,record.id,response,{goalType:data.goalType}),false);}catch(e){ui.recordResults[c.id]='Запись сохранена. Обработка не завершена: '+e.message;render();return;}}else result=await commit(s=>C.processManualRecord(s,record.id,{due:data.due||null,needsReply:data.needsReply,goalStatus:data.goalStatus,goalType:data.goalType}),false);ui.recordResults[c.id]=result.changes.length?result.changes.map(x=>(x.type==='task'?'Задача: ':x.type==='goal'?'Цель: ':'Особенность: ')+x.title).join('\n'):result.mode==='agent'?'Запись сохранена. Агент не выделил задач, целей или особенностей.':'Запись сохранена в истории';ui.drafts[c.id]={text:'',kind:'record',needsReply:false,due:'',goalStatus:'Желание клиента'};await saveDrafts();render();}
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
  return append(page,el('h1','Ассистент'),note,row(voice,review));
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
      form.append(button([service.oneOff?'Разовое занятие · '+formatDate(service.startsOn):PACKAGES[service.package||service.kind],
        service.place,service.currency].filter(Boolean).join(' · '),()=>open(choice)));
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
async function service(path,body){const base=state().settings.serviceURL;if(!base)throw Error('Подключи сервис в настройках');const address=new URL(path,base);if(address.protocol!=='https:')throw Error('Нужен HTTPS-адрес сервиса');if(window.TrailNative?.native){const res=await window.TrailNative.request(address.href,'POST',body);return JSON.parse(res.body);}throw Error('Подключение сервиса доступно в установленном Android-приложении');}
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
function telegramPanel(c){
  const panel=el('section',null,'stack telegram-panel'),bound=!!c.telegram?.peerId;
  if(bound){
    panel.append(text('Переписка привязана','telegram-linked small'),el('div',(c.telegram.displayName||'Telegram')+(c.telegram.username?' · @'+c.telegram.username:''),'telegram-recipient'),...detailsUI.telegramOptions(c));
    panel.append(append(el('div',null,'row telegram-controls'),
      button('Изменить получателя',()=>bindTelegram(c),'subtle'),
      button('Отвязать переписку',()=>unbindTelegram(c),'subtle')));
  }else{
    append(panel,text('Переписка ещё не привязана'),button('Привязать переписку',()=>bindTelegram(c),'subtle'));
    return panel;
  }
  const connected=!!state().settings.serviceURL;
  if(!connected)panel.append(text('Для отправки подключи сервис в настройках. Привязка получателя сохранена.'));
  const replies=C.clientTasks(state(),c.id).filter(t=>t.needsReply),linked=select([['','Без привязки к задаче'],...replies.map(t=>[t.id,t.title])],'');
  if(replies.length)panel.append(field('Ожидать ответ по задаче',linked));
  const list=el('div',null,'telegram-templates');
  panel.append(text('Заготовки · нажатие отправит сообщение'));
  for(const template of C.TEMPLATES){
    const send=button(template,async()=>{
      if(!connected)throw Error('Сначала подключи сервис в настройках');
      if(ui.busy.has('telegram-'+c.id))return;
      ui.busy.add('telegram-'+c.id);
      const pending=state().settings.pendingTelegram||{};
      if(pending[c.id]&&pending[c.id].text!==template){ui.busy.delete('telegram-'+c.id);throw Error('Предыдущая отправка не подтверждена. Сначала повтори её заготовку.');}
      const operation=pending[c.id]||{key:C.id('message'),text:template,taskId:linked.value||null};
      try{
        await commit(s=>{s.settings.pendingTelegram={...s.settings.pendingTelegram,[c.id]:operation};},false);
        const result=await service('/telegram/send',{peerId:c.telegram.peerId,accountPeerId:c.telegram.accountPeerId||null,text:template,idempotencyKey:operation.key});
        if(!result.messageId||!result.sentAt||!Number.isFinite(Date.parse(result.sentAt)))throw Error('Сервис не подтвердил отправку');
        await commit(s=>{
          const messageKey=c.telegram.peerId+':'+result.messageId;
          C.confirmedContact(s,c.id,{at:result.sentAt,messageKey,source:'telegram-api'});
          const task=s.tasks[operation.taskId];
          if(task?.clientId===c.id&&task.needsReply&&task.phase!=='done'){C.markSent(s,task.id,result.sentAt,messageKey);ui.sendAck[task.id]=result.sentAt;}
          if(s.settings.pendingTelegram)delete s.settings.pendingTelegram[c.id];
        });message('Отправлено · '+formatDate(result.sentAt,true));
      }finally{ui.busy.delete('telegram-'+c.id);}
    },'template-button');
    send.disabled=!connected;send.setAttribute('aria-label','Отправить в Telegram: '+template);list.append(send);
  }
  panel.append(list);return panel;
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
  const services=el('div',null,'stack'),url=input('url',state().settings.serviceURL||'','https://…'),token=input('password','','Новый ключ сервиса');
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
        base=parsed.origin;
      }
      if(base!==(state().settings.serviceURL||''))await window.TrailNative.setSecret('serviceToken','');
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
function renderUpdate(){const panel=document.getElementById('update-panel');if(!panel)return;panel.textContent='';const u=updater.state(),errors={save:'Не удалось сохранить базу перед обновлением. Повтори после освобождения места.', 'asset-id':'Не удалось прочитать ID архива обновления. Нужен исправленный APK.', 'rate-limit':'GitHub временно ограничил загрузку. Попробуй другую сеть или повтори позже.', forbidden:'GitHub отклонил загрузку. Проверь, открывается ли выпуск в браузере.',storage:'Недостаточно места для обновления. Освободи место и повтори.',timeout:'Сервер обновлений не ответил вовремя. Повтори загрузку.',tls:'Не удалось установить защищённое соединение с сервером обновлений.',native:'Обновление интерфейса доступно в установленном Android-приложении.',manifest:'Не удалось проверить сведения об обновлении. Текущая версия сохранена.','native-required':'Для этой версии нужен новый APK. Установи его поверх приложения.','github-auth':'GitHub отклонил запрос обновления. Проверь доступ к выпуску.','release-missing':'Готовый выпуск не найден или к нему временно нет доступа.',checksum:'Архив не прошёл проверку целостности. Текущая версия сохранена.',network:'Не удалось загрузить обновление. Проверь интернет и повтори.'},labels={idle:'Проверка по нажатию',checking:'Проверяю обновление…',current:'Установлена актуальная версия',available:'Доступна версия '+u.latest,downloading:'Загружаю · '+Math.round(u.progress)+'%',applying:'Открываю новую версию…',error:errors[u.error]||'Обновление не выполнено'};append(panel,el('h2','Данные и обновления'),text('THE.TRAIL Clients · '+VERSION),text(labels[u.status],u.status==='error'?'danger-text small':'muted small'));if(u.status==='error')panel.append(text('Этап: '+({save:'сохранение базы',release:'проверка выпуска',compatibility:'совместимость APK',download:'получение архива',apply:'запуск обновления'}[u.step]||'проверка')+' · код '+u.error));const progress=el('progress');progress.max=100;progress.value=u.progress;progress.hidden=u.status!=='downloading';panel.append(progress);const update=button('Обновить сейчас',()=>updater.update(),'primary');update.disabled=['checking','downloading','applying'].includes(u.status);panel.append(update);panel.append(text('Обновление сохраняет базу и черновики. При неудачном запуске возвращается предыдущая рабочая версия. Новые системные возможности могут потребовать нового APK.'));}
function render(){
  if(!store)return;
  applyAppearance();const hash=location.hash||'#todo';
  if(ui.focusRoute!==hash)ui.focusRoute=null;
  const openCard=hash.startsWith('#client/')?hash.split('/')[1]:null;
  if(ui.openCard!==openCard){ui.recentlyCompleted.clear();ui.openCard=openCard;}
  const birthdayRoute=route=>['#todo/birthdays','#clients/birthdays'].includes(route);
  const sectionTab=route=>birthdayRoute(route)?'#todo':route.startsWith('#clients/')?'#clients':route;
  const activeTab=sectionTab(hash.startsWith('#client/')?ui.returnTo:hash);
  root.replaceChildren();
  document.querySelectorAll('.app-nav a, .gear-link').forEach(a=>a.setAttribute('aria-current',a.hash===activeTab?'page':'false'));
  if(hash.startsWith('#client/')){
    const [,id,type,target]=hash.split('/');
    if(type==='goal'&&ui.focusRoute!==hash&&ui.goalFilters)ui.goalFilters[id]='';
    root.append(renderClient(id,type,target));
  }else if(birthdayRoute(hash))root.append(renderBirthdays());
  else if(hash==='#clients'||hash.startsWith('#clients/')){
    const view=hash.split('/')[1];root.append(renderCatalog(Object.hasOwn(catalogViews,view)?view:'active'));renderCatalogResults();
  }else if(hash==='#account')root.append(accountingUI.page());
  else if(hash==='#races')root.append(detailsUI.races());
  else if(hash==='#assistant')root.append(renderAssistant());
  else if(hash==='#settings'){root.append(renderSettings());renderUpdate();renderCloudPanel();}
  else root.append(renderTodo());
}
async function start(){try{store=await createStore(window.TrailNative?.native?window.TrailNative.adapter:browserAdapter());applyAppearance();ui.drafts=C.clone(state().settings.drafts||{});if(window.TrailNative?.native){try{ui.pendingVoice=await window.TrailNative.loadVoice();}catch{message('Голосовой черновик не удалось прочитать. База клиентов доступна.',true);}}updater=createUpdater({version:VERSION,bridge:window.TrailNative,flush:async()=>{await saveDrafts();await store.flush();},onChange:u=>{renderUpdate();const link=document.querySelector('.gear-link');if(link){link.classList.toggle('has-update',u.status==='available');link.setAttribute('aria-label',u.status==='available'?'Настройки · доступно обновление':'Настройки');}}});if(!location.hash)history.replaceState(null,'','#todo');window.addEventListener('hashchange',()=>{render();window.scrollTo({top:0});});document.addEventListener('visibilitychange',()=>{if(document.hidden)run(()=>saveDrafts());});await refreshMicrophonePermission();render();document.getElementById('save-status').textContent='На устройстве';await window.TrailNative?.ready();startCloud();if(window.TrailNative?.native)setTimeout(()=>updater.check(),1500);}catch(e){root.textContent='';append(root,el('h1','Не удалось открыть базу'),text(e.message,'danger-text'),text('Не удаляй приложение: данные могут оставаться на устройстве.'),button('Повторить',()=>location.reload()));}}
start();
