import * as C from './core.js';
import {createStore,browserAdapter} from './store.js';
import {createUpdater} from './updates.js';
import {parseConnection} from './connection.js';
import {createRecipientSearch} from './telegram-picker.js';
import {microphoneAccess,microphoneState} from './microphone.js';
const VERSION=__APP_VERSION__;
const root=document.getElementById('app'),notice=document.getElementById('notice'),dialog=document.getElementById('editor');
let store,updater,noticeTimer,draftTimer;
const ui={filters:{query:'',status:'Активный',format:'all',basis:'all',level:'all',personal:'all',role:'Клиент'},limit:12,taskFilter:'all',returnTo:'#clients',open:new Set(),drafts:{},sendAck:{},recordResults:{},busy:new Set(),update:{status:'idle'}};
const state=()=>store.state();
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined&&text!==null)node.textContent=text;if(className)node.className=className;return node;}
function append(parent,...children){parent.append(...children.filter(Boolean));return parent;}
function button(text,fn,className=''){const b=el('button',text,className);b.type='button';b.addEventListener('click',()=>run(async()=>{b.disabled=true;try{await fn();}finally{if(b.isConnected)b.disabled=false;}}));return b;}
function message(text,error=false){clearTimeout(noticeTimer);notice.textContent=text;notice.className='notice'+(error?' error':'');notice.hidden=false;noticeTimer=setTimeout(()=>{notice.hidden=true;},error?9000:4500);}
async function run(fn){try{await fn();}catch(e){message(e.message||'Операция не выполнена',true);}}
async function commit(fn,redraw=true){document.getElementById('save-status').textContent='Сохраняю…';try{const value=await store.mutate(fn);document.getElementById('save-status').textContent='На устройстве';if(redraw)render();return value;}catch(e){document.getElementById('save-status').textContent='Не сохранено';throw e;}}
function row(...items){return append(el('div',null,'row'),...items);}
function text(text,className='muted small'){return el('div',text,className);}
function field(label,input){return append(el('label',label),input);}
function input(type='text',value='',placeholder=''){const i=el('input');i.type=type;i.value=value;i.placeholder=placeholder;return i;}
function select(values,value){const s=el('select');for(const item of values){const [v,label]=Array.isArray(item)?item:[item,item],o=el('option',label);o.value=v;s.append(o);}s.value=value;return s;}
function chips(c){const list=el('span',null,'row');for(const value of c.role==='Тренер'?['Тренер']:[c.status,c.currentFormat||c.format,'Основа: '+c.basis])list.append(el('span',value,'chip'));if(c.level==='Премиум')list.append(el('span','Премиум','chip emphasis'));if(['gym','outside'].includes(c.personal))list.append(el('span',c.personal==='gym'?'Персональный зал с Сергеем':'Персонально с Сергеем · улица','chip emphasis'));return list;}
function formatDate(iso,withTime=false){if(!iso)return '';return new Intl.DateTimeFormat('ru-RU',{timeZone:C.TIMEZONE,day:'numeric',month:'short',...(withTime?{hour:'2-digit',minute:'2-digit'}:{})}).format(new Date(iso.length===10?iso+'T12:00:00Z':iso));}
function section(title,key,children){const d=el('details',null,'fold'),summary=el('summary',title);d.open=ui.open.has(key);d.addEventListener('toggle',()=>{if(d.open)ui.open.add(key);else ui.open.delete(key);});append(d,summary,append(el('div',null,'fold-body stack'),...children));return d;}
function navigate(hash){location.hash=hash;}
function openClient(clientId){ui.returnTo=location.hash.startsWith('#client/')?ui.returnTo:location.hash||'#todo';navigate('#client/'+clientId);}
function modal(title,build){
  dialog.textContent='';
  const form=el('form'),heading=el('h2',title),error=text('','form-error');
  heading.id='editor-title';error.setAttribute('role','alert');form.append(heading);
  let save;
  const saveControl=button('Сохранить',async()=>{try{await save();dialog.close();}catch(e){error.textContent=e.message;}},'primary');
  save=build(form,enabled=>{saveControl.disabled=!enabled;error.textContent='';});
  const controls=row(button('Отмена',()=>dialog.close()),saveControl);
  form.addEventListener('submit',e=>{e.preventDefault();if(!saveControl.disabled)saveControl.click();});
  append(form,error,controls);dialog.append(form);dialog.showModal();
}
function editClient(clientId=null){const c=clientId?state().clients[clientId]:null;modal(c?'Данные клиента':'Новый клиент',form=>{const name=input('text',c?.name||'');name.maxLength=180;form.append(field('Имя',name));const controls={role:select(['Клиент','Тренер'],c?.role||'Клиент'),status:select(C.STATUSES,c?.status||'Активный'),format:select(['Очно','Дистанционно','Уточнить'],c?.format||'Уточнить'),basis:select(C.BASES,c?.basis||'Сейчас плана нет'),level:select(['Обычное','Премиум'],c?.level||'Обычное'),group:select(['Да','Нет','Уточнить'],c?.group||'Уточнить'),personal:select([['none','Нет'],['gym','В зале'],['outside','На улице'],['unknown','Нужно уточнить']],c?.personal||'unknown'),currentFormat:select([['','Нет временного изменения'],['Очно','Временно очно'],['Дистанционно','Временно онлайн']],c?.currentFormat||'')};const labels={role:'Роль',status:'Статус сотрудничества',format:'Обычный формат',basis:'Основа плана',level:'Ведение',group:'Групповые с Сергеем',personal:'Персональные с Сергеем',currentFormat:'Формат сейчас'};for(const [key,control] of Object.entries(controls))form.append(field(labels[key],control));return async()=>{const values={name:name.value.trim(),...Object.fromEntries(Object.entries(controls).map(([k,v])=>[k,v.value]))};values.currentFormat=values.currentFormat||null;if(!values.name)throw Error('Введи имя');await commit(s=>c?C.editClient(s,c.id,values):C.createClient(s,values));};});}
function renderCatalog(){const page=el('div',null,'stack');page.append(append(el('div',null,'page-title'),el('h1','Клиенты'),button('Добавить клиента',()=>editClient())));if(!Object.keys(state().clients).length){page.append(emptyDatabase());return page;}const search=input('search',ui.filters.query,'Имя или фамилия');search.setAttribute('aria-label','Поиск по имени');search.maxLength=80;search.addEventListener('input',()=>{ui.filters.query=search.value;ui.limit=12;renderCatalogResults();});page.append(field('Поиск',search));const filters=el('div',null,'filters');for(const [key,label,values] of [['status','Статус',[['all','Все статусы'],...C.STATUSES]],['format','Формат сейчас',[['all','Любой'],['Очно','Очно'],['Дистанционно','Онлайн'],['Уточнить','Нужно уточнить']]]])filters.append(filterControl(key,label,values));page.append(filters);const extra=el('div',null,'filters');for(const [key,label,values] of [['basis','Основа плана',[['all','Любая'],...C.BASES]],['level','Ведение',[['all','Любое'],'Обычное','Премиум']],['personal','Персональные с Сергеем',[['all','Любые'],['gym','В зале'],['outside','На улице'],['none','Нет'],['unknown','Нужно уточнить']]],['role','Роль',[['Клиент','Клиенты'],['Тренер','Тренеры'],['all','Все люди']]]])extra.append(filterControl(key,label,values));page.append(section('Ещё фильтры','catalog-filters',[extra]));const count=text('');count.id='catalog-count';page.append(append(el('div',null,'row between'),count,button('Сбросить',()=>{ui.filters={query:'',status:'Активный',format:'all',basis:'all',level:'all',personal:'all',role:'Клиент'};ui.limit=12;render();})));const tiles=el('div',null,'tiles');tiles.id='client-tiles';page.append(tiles);const more=button('Ещё 12',()=>{ui.limit+=12;renderCatalogResults();});more.id='more-clients';page.append(more);return page;}
function filterControl(key,label,values){const control=select(values,ui.filters[key]);control.addEventListener('change',()=>{ui.filters[key]=control.value;if(key==='role'&&control.value==='Тренер'){ui.filters.status='all';render();}else{ui.limit=12;renderCatalogResults();}});return field(label,control);}
function renderCatalogResults(){const tiles=document.getElementById('client-tiles');if(!tiles)return;const rows=C.filterClients(state(),ui.filters);tiles.textContent='';document.getElementById('catalog-count').textContent='Найдено: '+rows.length+' · показано '+Math.min(rows.length,ui.limit);for(const c of rows.slice(0,ui.limit)){const tile=button('',()=>openClient(c.id),'client-tile');tile.setAttribute('aria-label','Открыть клиента: '+c.name);append(tile,el('span',c.name,'client-tile-name'),chips(c));tiles.append(tile);}if(!rows.length)tiles.append(text('По этим условиям никого нет. Измени фильтры.'));const more=document.getElementById('more-clients');more.hidden=rows.length<=ui.limit;more.textContent='Ещё '+Math.min(12,Math.max(0,rows.length-ui.limit));}
function emptyDatabase(){return append(el('div',null,'empty'),el('h2','Твоя клиентская база'),el('p','Импортируй подготовленный файл или добавь первого клиента. База хранится на этом устройстве.'),row(button('Импортировать базу',()=>importDatabase(),'primary'),button('Добавить клиента',()=>editClient())));}
function taskStateLabel(t){if(!t.needsReply)return 'Моё действие';if(t.phase==='todo')return 'Нужно написать клиенту';return (t.checkOn<=C.localDate()?'Проверить переписку':'Жду ответа клиента')+' · '+formatDate(t.checkOn);}
function renderTodo(){const page=el('div',null,'stack-lg'),tasks=C.openTasks(state());page.append(append(el('div',null,'page-title'),el('h1','ToDo'),text(tasks.length+' открыто')));if(!Object.keys(state().clients).length){page.append(emptyDatabase());return page;}const filters=el('div',null,'segmented');for(const [value,label] of [['all','Все'],['mine','Мои действия'],['reply','Нужен ответ']]){const count=C.openTasks(state(),{filter:value}).length,b=button(label+' · '+count,()=>{ui.taskFilter=value;render();});b.setAttribute('aria-pressed',String(ui.taskFilter===value));filters.append(b);}page.append(filters);const list=el('div',null,'stack');const shown=C.openTasks(state(),{filter:ui.taskFilter});if(!shown.length)list.append(text('Открытых задач в этом разделе нет.'));for(const t of shown){const b=button('',()=>openClient(t.clientId),'task-tile');append(b,el('span',state().clients[t.clientId].name,'client-tile-name'),el('span',t.title),text((t.phase==='waiting'?'':(t.due?formatDate(t.due):'Без срока')+' · ')+taskStateLabel(t)));const w=C.taskWarning(t);if(w)b.append(text(w.text,w.level==='danger'?'danger-text small':'warning-text small'));list.append(b);}page.append(list);const discussions=C.openTasks(state(),{lane:'discussion'});page.append(section('Обсудить с клиентами · '+discussions.length,'discussions-global',discussions.length?discussions.map(t=>discussion(t,true)):[text('Тем для обсуждения пока нет.')]));return page;}
function task(t){const wrap=el('div',null,'task');if(t.phase==='done'){append(wrap,text('Выполнено · '+formatDate(t.closedAt,true)),el('div',t.title),button('Вернуть в работу',()=>commit(s=>C.completeTask(s,t.id,false))));return wrap;}if(!t.needsReply){const checkbox=input('checkbox');checkbox.checked=false;checkbox.addEventListener('change',()=>run(()=>commit(s=>C.completeTask(s,t.id,true))));const label=el('label',null,'checkbox');append(label,checkbox,el('span',t.title));wrap.append(label);}else wrap.append(el('div',t.title,'task-title'));wrap.append(text((t.due&&t.phase==='todo'?formatDate(t.due)+' · ':'')+taskStateLabel(t)));if(t.lastSentAt)wrap.append(text('Последняя отметка: '+formatDate(t.lastSentAt,true)+' · проверка '+formatDate(t.checkOn)));if(t.needsReply){const controls=el('div',null,'task-actions'),ack=ui.sendAck[t.id]===t.lastSentAt&&t.checkOn>C.localDate(),label=ack?(t.outboundCount>1?'Я написал клиенту повторно, жду ответа':'Я написал клиенту, жду ответа'):(t.lastSentAt?'Написать клиенту повторно':'Написать клиенту');controls.append(button(label,async()=>{const at=new Date().toISOString();await commit(s=>C.markSent(s,t.id,at),false);ui.sendAck[t.id]=state().tasks[t.id].lastSentAt;render();},ack?'sent':''),button('Закрыть задачу',()=>commit(s=>C.completeTask(s,t.id,true))));wrap.append(controls);const warning=C.taskWarning(t);if(warning)wrap.append(text(warning.text,warning.level==='danger'?'danger-text small':'warning-text small'));}const delay=input('number',t.waitDays);delay.min=1;delay.max=30;const due=input('date',t.due||'');const options=[field('Дата действия',due),button('Сохранить дату',()=>commit(s=>{if(due.value&&!C.validDate(due.value))throw Error('Проверь дату');s.tasks[t.id].due=due.value||null;C.event(s,'task-date-edited',t.clientId,t.id);} ))];if(t.needsReply)options.push(field('Дней до проверки после сообщения',delay),button('Сохранить интервал',()=>commit(s=>C.setWait(s,t.id,Number(delay.value)))),button('Использовать этот интервал для новых задач',()=>commit(s=>C.setWait(s,t.id,Number(delay.value),true))));wrap.append(section('Настройки задачи',t.id+'-settings',options));return wrap;}
function discussion(t,withClient=false){const wrap=el('div',null,'task'),date=input('date');wrap.append(withClient?button(state().clients[t.clientId].name+' · '+t.title,()=>openClient(t.clientId),'subtle'):el('div',t.title));append(wrap,field('Когда обсудить',date),row(button('Добавить в ToDo',()=>commit(s=>C.scheduleTask(s,t.id,date.value))),button('Закрыть тему',()=>commit(s=>C.completeTask(s,t.id,true)))));return wrap;}
function editGoal(goal){modal('Редактировать цель',form=>{const title=input('text',goal.title),status=select(goal.status==='Рабочая цель тренера'?['Рабочая цель тренера']:C.GOAL_STATUSES.filter(s=>s!=='Рабочая цель тренера'),goal.status);title.maxLength=500;append(form,field('Цель',title),field('Плашка',status));return ()=>commit(s=>C.editGoal(s,goal.id,title.value,status.value));});}
function goalRow(g){const wrap=el('div',null,'goal');append(wrap,row(el('span',g.title),el('span',g.status,'chip')));const controls=el('div',null,'goal-controls');if(g.deletedAt)controls.append(button('Восстановить',()=>commit(s=>C.deleteGoal(s,g.id,false))));else controls.append(button('Редактировать',()=>editGoal(g)),button('Удалить',async()=>{await commit(s=>C.deleteGoal(s,g.id,true));message('Цель удалена. Её можно восстановить ниже.');},'danger'));wrap.append(controls);return wrap;}
function editFeature(clientId){modal('Важная особенность',form=>{const note=el('textarea'),kind=select(['Сейчас','Постоянно учитывать','На этой неделе'],'Сейчас');append(form,field('Суть',note),field('Когда учитывать',kind));return ()=>commit(s=>C.addFeature(s,clientId,note.value,kind.value));});}
function renderClient(clientId){const c=state().clients[clientId];if(!c){navigate('#clients');return el('div');}const page=el('div',null,'stack-lg');page.append(button(ui.returnTo==='#todo'?'← К ToDo':'← К списку клиентов',()=>navigate(ui.returnTo),'back subtle'));const header=el('header',null,'stack');append(header,append(el('div',null,'page-title'),el('h1',c.name),button('Изменить',()=>editClient(c.id))),chips(c),text(c.lastContact?'Последний контакт: '+formatDate(c.lastContact.at,!c.lastContact.dateOnly)+' · '+c.lastContact.channel:'Последний контакт пока не указан'));page.append(header);const tasks=C.openTasks(state(),{clientId}),done=Object.values(state().tasks).filter(t=>t.clientId===clientId&&t.phase==='done');if(tasks.length||done.length){const box=el('section',null,'panel action-panel');append(box,el('h2','Действия по клиенту'),...tasks.map(task));if(done.length)box.append(section('Выполнено · '+done.length,clientId+'-done',done.map(task)));page.append(box);}const featureBox=el('section',null,'stack');append(featureBox,row(el('h2','Важные особенности'),button('Добавить',()=>editFeature(c.id),'subtle')));const active=c.features.filter(f=>f.active!==false);if(!active.length)featureBox.append(text('Пока не зафиксированы'));for(const f of active){const item=el('div',null,'feature');append(item,text(f.kind),el('div',f.text),button('Уже не актуально',()=>commit(s=>C.setFeatureActive(s,c.id,f.id,false)),'subtle'));featureBox.append(item);}const past=c.features.filter(f=>f.active===false);if(past.length)featureBox.append(section('Прежние особенности · '+past.length,c.id+'-old-features',past.map(f=>append(el('div',null,'feature'),el('div',f.text),button('Снова актуально',()=>commit(s=>C.setFeatureActive(s,c.id,f.id,true)))))));page.append(featureBox,telegramPanel(c));const zones=[];if(c.zones){zones.push(text(c.zones.status));if(c.zones.lthr)zones.push(text('LTHR в сохранённых настройках: '+c.zones.lthr+' уд/мин'));if(c.zones.rows?.length){const grid=el('div',null,'zones');for(const [name,min,max] of c.zones.rows)grid.append(append(el('div'),text(name),el('div',min+'–'+max)));zones.push(grid);}zones.push(text(c.zones.source||''));}else zones.push(text('Зоны не внесены. Численные значения не назначались.'));page.append(section('Пульсовые зоны · бег',c.id+'-zones',zones));const goals=Object.values(state().goals).filter(g=>g.clientId===c.id),current=goals.filter(g=>!g.deletedAt&&g.status!=='Рабочая цель тренера'),work=goals.filter(g=>!g.deletedAt&&g.status==='Рабочая цель тренера');const goalBody=[button('Добавить цель',()=>{const draft=getDraft(c.id);draft.kind='goal';const form=document.getElementById('compose');form.querySelectorAll('[data-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.kind==='goal')));document.getElementById('goal-status-field').hidden=false;document.getElementById('task-fields').hidden=true;form.scrollIntoView({behavior:'smooth',block:'start'});document.getElementById('client-note').focus({preventScroll:true});saveDraftSoon();}),...current.map(goalRow)];if(!current.length)goalBody.push(text('Пока не внесены'));if(work.length)goalBody.push(el('h3','Рабочие цели тренера'),...work.map(goalRow));const removed=goals.filter(g=>g.deletedAt);if(removed.length)goalBody.push(section('Удалённые цели · '+removed.length,c.id+'-deleted-goals',removed.map(goalRow)));page.append(section('Цели клиента · '+current.length,c.id+'-goals',goalBody));const discussions=C.openTasks(state(),{clientId,lane:'discussion'});if(discussions.length)page.append(section('Обсудить с клиентом',c.id+'-discussions',discussions.map(t=>discussion(t))));page.append(section('Кемпы и история участия',c.id+'-camps',c.camps?.length?c.camps.map(camp=>text(camp.name+' · '+camp.status,' ')):[text('История участия пока не восстановлена')]));const system=el('dl',null,'system');for(const [name,value] of [['Роль',c.role],['Статус сотрудничества',c.status],['Обычный формат',c.format],['Формат сейчас',c.currentFormat||'Без временного изменения'],['Основа плана',c.basis],['Групповые с Сергеем',c.group],['Персональные с Сергеем',({gym:'В зале',outside:'На улице',none:'Нет',unknown:'Нужно уточнить'})[c.personal]],['Ведение',c.level]])system.append(append(el('div'),el('dt',name),el('dd',value)));page.append(section('Системные данные и подгруппы',c.id+'-system',[system,...(c.context?[text(c.context)]:[]),el('h3','Регулярные правила плана'),...(c.rules.length?c.rules.map(r=>el('div',r)):[text('Пока не внесены')]),button('Изменить правила',()=>editRules(c))]));const history=el('ol',null,'history');const events=state().events.filter(e=>e.clientId===c.id).slice().reverse().slice(0,100);for(const e of events){const record=state().records[e.entityId],goal=state().goals[e.entityId],t=state().tasks[e.entityId],title=record?.text||goal?.title||t?.title||e.text||eventLabel(e.type);history.append(append(el('li'),text(e.sourceMeta||formatDate(e.at,true)+' · '+eventLabel(e.type)),el('div',title)));}if(!events.length)history.append(text('Записей пока нет'));page.append(section('История записей',c.id+'-history',[history]),compose(c));return page;}
function eventLabel(type){return ({'record-created':'Запись Сергея','goal-created':'Цель добавлена','goal-edited':'Цель изменена','goal-deleted':'Цель удалена','goal-restored':'Цель восстановлена','task-created':'Задача создана','task-closed':'Задача закрыта','task-reopened':'Задача возвращена','outbound':'Исходящее сообщение','task-scheduled':'Разговор назначен','client-edited':'Данные клиента изменены','client-created':'Клиент добавлен','feature-created':'Особенность добавлена','feature-archived':'Особенность снята с актуального','feature-restored':'Особенность снова актуальна','contact':'Контакт с клиентом','source-note':'Сведения от Сергея'})[type]||'Изменение';}
function editRules(c){modal('Регулярные правила плана',form=>{const area=el('textarea');area.value=c.rules.join('\n');form.append(field('Одно правило на строку',area));return ()=>commit(s=>{s.clients[c.id].rules=area.value.split('\n').map(x=>x.trim()).filter(Boolean);C.event(s,'rules-edited',c.id,c.id);});});}
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
  const goalField=field('Плашка цели',status);goalField.id='goal-status-field';goalField.hidden=d.kind!=='goal';
  for(const [kind,label] of [['record','Без пометки'],['task','Задача'],['goal','Цель']]){
    const b=button(label,()=>{d.kind=kind;modes.querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===b)));taskFields.hidden=kind!=='task';goalField.hidden=kind!=='goal';updateAction();saveDraftSoon();});
    b.dataset.kind=kind;b.setAttribute('aria-pressed',String(d.kind===kind));modes.append(b);
  }
  const send=el('button','','primary'),hint=text(''),extra=button('Надиктовать ещё',()=>recordVoice(c.id));send.type='submit';
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
async function submitRecord(c,d){const data={...d};const pending=state().records[d.pendingRecordId];const record=pending&&pending.text===data.text.trim()&&pending.kind===data.kind?pending:await commit(s=>C.saveRecord(s,c.id,data.text,data.kind),false);d.pendingRecordId=record.id;await saveDrafts();let result;if(state().settings.serviceURL&&state().settings.agentEnabled){try{const response=await service('/records/parse',{client:{...state().clients[c.id]},goals:Object.values(state().goals).filter(g=>g.clientId===c.id&&!g.deletedAt),openTasks:C.openTasks(state(),{clientId:c.id}),record,timezone:C.TIMEZONE,waitDays:state().settings.waitDays,needsReply:data.needsReply});if(response.question){ui.recordResults[c.id]='Нужно уточнить: '+response.question;render();return;}result=await commit(s=>C.applyAgentResult(s,record.id,response),false);}catch(e){ui.recordResults[c.id]='Запись сохранена. Обработка не завершена: '+e.message;render();return;}}else result=await commit(s=>C.processManualRecord(s,record.id,{due:data.due||null,needsReply:data.needsReply,goalStatus:data.goalStatus}),false);ui.recordResults[c.id]=result.changes.length?result.changes.map(x=>(x.type==='task'?'Задача: ':x.type==='goal'?'Цель: ':'Особенность: ')+x.title).join('\n'):result.mode==='agent'?'Запись сохранена. Агент не выделил задач, целей или особенностей.':'Запись сохранена в истории';ui.drafts[c.id]={text:'',kind:'record',needsReply:false,due:'',goalStatus:'Желание клиента'};await saveDrafts();render();}
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
function telegramPanel(c){const panel=el('section',null,'stack');panel.append(el('h2','Сообщения в Telegram'));const connected=!!(state().settings.serviceURL&&c.telegram?.peerId);panel.append(text(connected?'Получатель: '+(c.telegram.displayName||'Telegram')+(c.telegram.username?' · @'+c.telegram.username:'')+' · ID '+c.telegram.peerId:'Telegram не подключён или клиент ещё не привязан'));const replies=C.openTasks(state(),{clientId:c.id}).filter(t=>t.needsReply),linked=select([['','Без привязки к задаче'],...replies.map(t=>[t.id,t.title])],'');if(replies.length)panel.append(field('Ожидать ответ по задаче',linked));const list=el('div',null,'stack');for(const template of C.TEMPLATES)list.append(button(template,async()=>{if(!connected){message('Не отправлено: сначала подключи Telegram и привяжи клиента.');return;}if(ui.busy.has('telegram-'+c.id))return;ui.busy.add('telegram-'+c.id);const pending=state().settings.pendingTelegram||{};if(pending[c.id]&&pending[c.id].text!==template){ui.busy.delete('telegram-'+c.id);throw Error('Предыдущая отправка не подтверждена. Сначала повтори её заготовку.');}const operation=pending[c.id]||{key:C.id('message'),text:template,taskId:linked.value||null};try{await commit(s=>{s.settings.pendingTelegram={...s.settings.pendingTelegram,[c.id]:operation};},false);const result=await service('/telegram/send',{peerId:c.telegram.peerId,accountPeerId:c.telegram.accountPeerId||null,text:template,idempotencyKey:operation.key});if(!result.messageId||!result.sentAt||!Number.isFinite(Date.parse(result.sentAt)))throw Error('Сервис не подтвердил отправку');await commit(s=>{const messageKey=c.telegram.peerId+':'+result.messageId;C.confirmedContact(s,c.id,{at:result.sentAt,messageKey,source:'telegram-api'});const task=s.tasks[operation.taskId];if(task?.clientId===c.id&&task.needsReply&&task.phase!=='done'){C.markSent(s,task.id,result.sentAt,messageKey);ui.sendAck[task.id]=result.sentAt;}if(s.settings.pendingTelegram)delete s.settings.pendingTelegram[c.id];});message('Отправлено · '+formatDate(result.sentAt,true));}finally{ui.busy.delete('telegram-'+c.id);}}));append(panel,list,button('Привязать переписку',()=>bindTelegram(c),'subtle'));return panel;}
async function bindTelegram(c){
  if(!state().settings.serviceURL)throw Error('Сначала подключи личный сервис в настройках');
  if(state().settings.pendingTelegram?.[c.id])throw Error('Сначала проверь предыдущую неподтверждённую отправку');
  const status=await service('/telegram/status',{});
  if(!status.connected)throw Error('Сервис доступен, но личный аккаунт Telegram ещё не авторизован');
  modal('Переписка в Telegram',(form,setSaveEnabled)=>{
    const query=input('search',c.telegram?.username?'@'+c.telegram.username:c.name,'Имя в Telegram или @username');
    query.maxLength=120;query.enterKeyHint='search';query.autocomplete='off';
    const results=el('fieldset',null,'recipient-results'),legend=el('legend','Результаты поиска');
    const selection=text('Найди и выбери получателя. Сообщение при привязке не отправляется.');
    selection.setAttribute('role','status');selection.setAttribute('aria-live','polite');
    let renderedContacts=null;
    const find=button('Найти в Telegram',()=>picker.find());
    const picker=createRecipientSearch({search:value=>service('/telegram/search',{query:value}),onChange:({contacts,selected,busy,error,searched})=>{
      setSaveEnabled(!!selected&&!busy);
      find.disabled=busy;find.textContent=busy?'Ищу…':'Найти в Telegram';
      selection.textContent=error||(busy?'Ищу…':selected?'Выбран: '+selected.displayName+(selected.username?' · @'+selected.username:''):contacts.length?'Нажми на нужного человека:':!searched?'Найди и выбери получателя. Сообщение при привязке не отправляется.':'Не найдено. Имя в карточке может отличаться от имени в Telegram. Попробуй имя из контактов или @username.');
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
    if(c.telegram)append(form,text('Текущая привязка: '+(c.telegram.displayName||'ID '+c.telegram.peerId)),button('Убрать привязку',async()=>{await commit(s=>{s.clients[c.id].telegram=null;});dialog.close();}));
    return async()=>{
      const selected=picker.selected();
      if(!selected)throw Error('Выбери получателя из результатов поиска');
      await commit(s=>{s.clients[c.id].telegram={...selected,accountPeerId:status.account.peerId,verifiedAt:new Date().toISOString()};});
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
function importDatabase(){const picker=input('file');picker.hidden=true;document.body.append(picker);picker.addEventListener('cancel',()=>picker.remove(),{once:true});picker.accept='.json,application/json';picker.addEventListener('change',()=>run(async()=>{const file=picker.files?.[0];picker.remove();if(!file)return;if(file.size>8*1024*1024)throw Error('Файл превышает 8 МБ');const incoming=C.parseImport(await file.text());modal('Импорт базы',form=>{const mode=select([['merge','Добавить отсутствующие, сохранить мои правки'],['replace','Заменить базу из резервной копии']],'merge');append(form,text('В файле: '+Object.keys(incoming.clients).length+' человек, '+Object.keys(incoming.tasks).length+' задач.'),field('Как перенести',mode));return async()=>{if(mode.value==='replace'){await backup();incoming.settings.serviceURL=state().settings.serviceURL||'';await store.replace(incoming);}else await commit(s=>Object.assign(s,C.mergeState(s,incoming)));ui.drafts=C.clone(state().settings.drafts||{});message('База импортирована');render();};});}));picker.click();}
async function backup(){await saveDrafts();const content=C.exportState(state());if(window.TrailNative?.native)await window.TrailNative.exportJSON(content);else{const blob=new Blob([content],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='THE-TRAIL-Clients-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}
function renderSettings(){const page=el('div',null,'stack-lg');append(page,el('h1','Настройки'));const data=el('section',null,'stack settings-section');append(data,el('h2','Данные на устройстве'),text(Object.keys(state().clients).length+' человек · '+Object.keys(state().records).length+' записей · версия базы '+state().schemaVersion),row(button('Импортировать базу',()=>importDatabase()),button('Экспортировать резервную копию',()=>backup())),text('Резервная копия содержит клиентские сведения. Ключи подключений в неё не входят. При обновлении интерфейса база сохраняется.'));page.append(data);const update=el('section',null,'stack settings-section');update.id='update-panel';page.append(update);const wait=input('number',state().settings.waitDays);wait.min=1;wait.max=30;const taskDefaults=el('section',null,'stack settings-section');append(taskDefaults,el('h2','Задачи'),field('Дней до проверки ответа в новых задачах',wait),button('Сохранить',()=>commit(s=>{const n=Number(wait.value);if(!Number.isInteger(n)||n<1||n>30)throw Error('Укажи от 1 до 30 дней');s.settings.waitDays=n;})),text('Интервалы уже созданных задач сохраняются.'));page.append(taskDefaults);const services=el('section',null,'stack settings-section'),url=input('url',state().settings.serviceURL||'','https://…'),token=input('password','','Новый ключ сервиса');token.autocomplete='off';const agentEnabled=input('checkbox');agentEnabled.checked=!!state().settings.agentEnabled;append(services,el('h2','Агент и Telegram'),field('Адрес твоего сервиса',url),field('Ключ доступа · оставить пустым, чтобы сохранить прежний',token),append(el('label',null,'checkbox'),agentEnabled,el('span','Использовать AI-разбор записей')),button('Сохранить подключение',async()=>{if(!window.TrailNative?.native)throw Error('Подключения доступны в установленном приложении');let base='';if(url.value.trim()){const parsed=new URL(url.value.trim());if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash)throw Error('Укажи HTTPS-адрес без ключей в ссылке');base=parsed.origin;}if(base!==(state().settings.serviceURL||''))await window.TrailNative.setSecret('serviceToken','');await commit(s=>{s.settings.serviceURL=base;s.settings.agentEnabled=agentEnabled.checked;});if(token.value)await window.TrailNative.setSecret('serviceToken',token.value.trim());message('Настройки подключения сохранены');}),text('Агент и голос работают через твой Mac. Способ обработки указан в проверке ниже. При выключенном AI записи, цели и задачи сохраняются локально.'));services.append(agentConnectionCheck(),connectionCodePanel(),telegramConnectionCheck());if(ui.pendingVoice)services.append(text('Есть сохранённая голосовая запись для '+(state().clients[ui.pendingVoice.clientId]?.name||'клиента')),row(button('Открыть запись',()=>openClient(ui.pendingVoice.clientId)),button('Удалить аудиочерновик',async()=>{if(window.TrailNative?.native)await window.TrailNative.clearVoice();ui.pendingVoice=null;render();})) );page.append(services);return page;}
function renderUpdate(){const panel=document.getElementById('update-panel');if(!panel)return;panel.textContent='';const u=updater.state(),errors={save:'Не удалось сохранить базу перед обновлением. Повтори после освобождения места.', 'asset-id':'Не удалось прочитать ID архива обновления. Нужен исправленный APK.', 'rate-limit':'GitHub временно ограничил число запросов. Повтори позже.', forbidden:'GitHub отклонил запрос обновления. Проверь доступ или удали неверный ключ ниже.',storage:'Недостаточно места для обновления. Освободи место и повтори.',timeout:'Сервер обновлений не ответил вовремя. Повтори загрузку.',tls:'Не удалось установить защищённое соединение с сервером обновлений.',native:'Обновление интерфейса доступно в установленном Android-приложении.',manifest:'Не удалось проверить сведения об обновлении. Текущая версия сохранена.','native-required':'Для этой версии нужен новый APK. Установи его поверх приложения.','github-auth':'GitHub временно ограничил запросы или отклонил сохранённый ключ. Повтори позже; неверный ключ можно удалить ниже.','release-missing':'Готовый выпуск не найден или к нему временно нет доступа.',checksum:'Архив не прошёл проверку целостности. Текущая версия сохранена.',network:'Не удалось загрузить обновление. Проверь интернет и повтори.'},labels={idle:'Проверка по нажатию',checking:'Проверяю обновление…',current:'Установлена актуальная версия',available:'Доступна версия '+u.latest,downloading:'Загружаю · '+Math.round(u.progress)+'%',applying:'Открываю новую версию…',error:errors[u.error]||'Обновление не выполнено'};append(panel,el('h2','Данные и обновления'),text('THE.TRAIL Clients · '+VERSION),text(labels[u.status],u.status==='error'?'danger-text small':'muted small'));if(u.status==='error')panel.append(text('Этап: '+({save:'сохранение базы',release:'проверка выпуска',compatibility:'совместимость APK',download:'получение архива',apply:'запуск обновления'}[u.step]||'проверка')+' · код '+u.error));const progress=el('progress');progress.max=100;progress.value=u.progress;progress.hidden=u.status!=='downloading';panel.append(progress);const update=button('Обновить сейчас',()=>updater.update(),'primary');update.disabled=['checking','downloading','applying'].includes(u.status);panel.append(update);const token=input('password','','Необязательный ключ GitHub');token.autocomplete='off';panel.append(section('Дополнительный доступ GitHub','github-access',[text('Обновления доступны без ключа GitHub. Оставь поле пустым. Необязательный ключ чтения может использоваться при ограничении числа запросов; он шифруется на устройстве и не входит в экспорт.'),field('Ключ GitHub',token),button('Сохранить ключ',async()=>{if(!window.TrailNative?.native)throw Error('Доступно в Android-приложении');await window.TrailNative.setSecret('githubToken',token.value.trim());token.value='';message('Ключ сохранён на устройстве');}),button('Удалить ключ',async()=>{if(window.TrailNative?.native)await window.TrailNative.setSecret('githubToken','');message('Ключ удалён');})]));panel.append(text('Обновление сохраняет базу и черновики. При неудачном запуске возвращается предыдущая рабочая версия. Новые системные возможности могут потребовать нового APK.'));}
function render(){if(!store)return;const hash=location.hash||'#todo';root.textContent='';document.querySelectorAll('.app-nav a').forEach(a=>a.setAttribute('aria-current',a.hash===(hash.startsWith('#client/')?(ui.returnTo||'#clients'):hash)?'page':'false'));if(hash.startsWith('#client/'))root.append(renderClient(hash.slice(8)));else if(hash==='#clients'){root.append(renderCatalog());renderCatalogResults();}else if(hash==='#settings'){root.append(renderSettings());renderUpdate();}else root.append(renderTodo());}
async function start(){try{store=await createStore(window.TrailNative?.native?window.TrailNative.adapter:browserAdapter());ui.drafts=C.clone(state().settings.drafts||{});if(window.TrailNative?.native){try{ui.pendingVoice=await window.TrailNative.loadVoice();}catch{message('Голосовой черновик не удалось прочитать. База клиентов доступна.',true);}}updater=createUpdater({version:VERSION,bridge:window.TrailNative,flush:async()=>{await saveDrafts();await store.flush();},onChange:u=>{renderUpdate();const link=document.querySelector('.app-nav a[href="#settings"]');if(link)link.textContent=u.status==='available'?'Настройки · обновление':'Настройки';}});if(!location.hash)history.replaceState(null,'','#todo');window.addEventListener('hashchange',()=>{render();window.scrollTo({top:0});});document.addEventListener('visibilitychange',()=>{if(document.hidden)run(()=>saveDrafts());});await refreshMicrophonePermission();render();document.getElementById('save-status').textContent='На устройстве';await window.TrailNative?.ready();if(window.TrailNative?.native)setTimeout(()=>updater.check(),1500);}catch(e){root.textContent='';append(root,el('h1','Не удалось открыть базу'),text(e.message,'danger-text'),text('Не удаляй приложение: данные могут оставаться на устройстве.'),button('Повторить',()=>location.reload()));}}
start();
