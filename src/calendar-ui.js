import {addDays, localDate, TIMEZONE} from './model-utils.js';
import {linkCalendarTask, normalizeSearch} from './core.js';
import {accounting, activeService, availablePersonalAdvance, clientServices, money, personalVisitSettlements, serviceBalance, tariffLabel} from './accounting.js';
import {createCalendarData} from './calendar-data.js';
import {assignedCoach,calendarGroupCoach,coachContact,groupCoach,OWNER_COACH,previewCoaches,previewGroupScheduleVisible,previewScheduleVisible} from './role-preview.js';
import {GROUP_REPORT,groupCompletion,groupEventReference,groupRecords,saveGroupCompletion} from './coach-accounting.js';
import {createGroupStaffingUI,GROUP_STAFFING_ROUTE} from './group-staffing-ui.js';

const clock = new Intl.DateTimeFormat('ru-RU', {timeZone:TIMEZONE, hour:'2-digit', minute:'2-digit'});
const monthFormat = new Intl.DateTimeFormat('ru-RU', {timeZone:TIMEZONE, month:'long', year:'numeric'});
const hasEnded = event => Date.parse(event.end) <= Date.now();
const historyPageSize = 6;

export function isSchedulingTask(task) {
  return !task.pauseContact && (task.calendarEvent ||
    /согласов|назнач|договор/u.test(task.title.toLowerCase()) && /заняти|трениров/u.test(task.title.toLowerCase()));
}

export function taskCalendarChoices(events, clients, task, tasks) {
  const reserved = new Set(Object.values(tasks).filter(t => t.id !== task.id).map(t => t.calendarEvent?.id));
  return events.filter(event => !reserved.has(event.id) && calendarClient(event,clients)?.id === task.clientId);
}

const calendarName = event => event.title.split('·')[1]?.trim() || event.title;

export function calendarClient(event, clients, linkedId, {allowFirstName=true}={}) {
  if(event.kind==='group')return;
  const available = client => client && !client.mergedInto && (!client.role || client.role === 'Клиент');
  if (linkedId || event.clientId) {
    const direct = clients[linkedId || event.clientId];
    const client = direct?.mergedInto ? clients[direct.mergedInto] : direct;
    return available(client) ? client : undefined;
  }
  const words = name => name.trim().split(/\s+/u).map(normalizeSearch).filter(Boolean);
  const signature = parts => [...parts].sort().join(' ');
  const person = words(calendarName(event)), target = signature(person);
  if (!person.length || person.length===1&&!allowFirstName) return;
  const matches = Object.values(clients).filter(client => available(client) && [client.name,...(client.aliases || [])].some(name => {
    const parts = words(name);
    return person.length > 1 ? signature(parts) === target : parts.includes(person[0]);
  }));
  return matches.length === 1 ? matches[0] : undefined;
}

async function sessionIds(eventId) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(eventId)));
  const key = Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
  return {sessionId:'calendar-session-'+key,paymentId:'calendar-payment-'+key};
}

export function calendarPlace(location) {
  const name = location?.toLowerCase() || '';
  if (/\bgym\b|teretana|(^|\s)зал(\s|$)|fitness|фитнес/u.test(name)) return 'Зал';
  if (/кал[еи]мегдан|kalemegdan|улица|outdoor|\bpark\b|парк|ада циганлия|ada ciganlija/u.test(name)) return 'Улица';
  return null;
}

export const TRAINING_KIND_LABELS = {group:'Группа',gym:'Зал',outside:'Улица'};
const personalKind = place => place==='Зал'?'gym':place==='Улица'?'outside':null;
const calendarKind = event => event.kind==='group'?'group':personalKind(calendarPlace(event.location));

export function matchesScheduleKind(event, kind) {
  return !kind || calendarKind(event)===kind;
}

export function athleteScheduleKinds(state, clientId, day) {
  const client = state.clients[clientId];
  if (client?.role!=='Клиент' || client.mergedInto) return [];
  const kinds = new Set(clientServices(state,clientId).filter(service=>activeService(service,day))
    .map(service=>service.kind==='belgrade'?'group':service.kind==='personal'?personalKind(service.place):null));
  return Object.keys(TRAINING_KIND_LABELS).filter(kind=>kinds.has(kind));
}

export function personalWeekMeetings(state, clientId, events) {
  const client = state.clients[clientId];
  if (client?.role!=='Клиент' || client.mergedInto) return [];
  const tariffs = clientServices(state,clientId).filter(service=>service.kind==='personal');
  if (!tariffs.length) return [];
  const links = new Map();
  for (const task of Object.values(state.tasks)) {
    if (!task.calendarEvent?.id || task.calendarEvent.cancelled) continue;
    const eventId = task.calendarEvent.id;
    if (!links.has(eventId)) links.set(eventId,[]);
    links.get(eventId).push(task.clientId);
  }
  return [...new Map(events.map(event=>[event.id,event])).values()]
    .filter(event=>event.kind!=='group')
    .sort((a,b)=>Date.parse(a.start)-Date.parse(b.start))
    .flatMap(event=>{
      const day = localDate(new Date(event.start)), place = calendarPlace(event.location);
      if (!place || !tariffs.some(tariff=>tariff.place===place&&activeService(tariff,day))) return [];
      const ids = [...(links.get(event.id) || [])];
      if (event.clientId) ids.push(event.clientId);
      const named = calendarClient({...event,clientId:null},state.clients,undefined,{allowFirstName:false});
      const matches = ids.length ? (!named || named.id===clientId)
        && ids.every(id=>id&&calendarClient(event,state.clients,id)?.id===clientId) : named?.id===clientId;
      return matches ? [{event,day,place}] : [];
    });
}

export function athleteScheduleEntries(state, clientId, events) {
  const client = state.clients[clientId];
  if (client?.role!=='Клиент' || client.mergedInto) return [];
  const groupTariffs = clientServices(state,clientId).filter(service=>service.kind==='belgrade');
  const coachId = assignedCoach(state,client);
  const own = new Map(personalWeekMeetings(state,clientId,events).map(entry=>[entry.event.id,entry]));
  return events.flatMap(event=>{
    if (event.kind!=='group') {
      const meeting = own.get(event.id);
      return meeting ? [{event,client,day:meeting.day}] : [];
    }
    const day = localDate(new Date(event.start));
    return groupTariffs.some(tariff=>activeService(tariff,day)) &&
      calendarGroupCoach({...event,coachName:event.rosterCoachName||event.coachName},state)===coachId
      ? [{event,day}] : [];
  });
}

export const CALENDAR_ARCHIVE_ROUTE = '#todo/schedule/past';
export const CALENDAR_ARCHIVE_SECTION = 'calendar-past';
export const CALENDAR_UPCOMING_SECTION = 'calendar-upcoming';

export function createCalendarUI({state, service, readCalendar, writeGroupCalendar, saveCalendar, roleContext=()=>({role:'superadmin'}), el, append, button, row, field, input, select, text, section, modal, commit, formatDate,
    navigate, openClient, message, searchClients, scheduledSession, addScheduledTariff, groupProtocol}) {
  const dataSource = createCalendarData({read:readCalendar,saved:()=>state().settings.calendarCache,save:saveCalendar});
  const selectedClients = new Map();
  const aligning = new Set();
  let archiveView,staffingWeek;
  const copiedGroupWeeks=new Set();
  const load = dataSource.load;
  const timeRange = event => clock.format(new Date(event.start)) + '–' + clock.format(new Date(event.end));
  async function personalWeek(clientId, weekStart) {
    if (!clientServices(state(),clientId).some(service=>service.kind==='personal')) return {sessions:[]};
    const data = await dataSource.loadWeek(weekStart);
    const sessions = personalWeekMeetings(state(),clientId,data.events).map(({event,day,place})=>({
      id:'calendar:'+event.id, day, kind:personalKind(place), title:'Персональная · '+place,
      subtitle:[timeRange(event),event.location].filter(Boolean).join(' · ')
    }));
    return {sessions, saved:data.mode==='saved'};
  }
  const eventLink = (event, label) => {
    if (!/^https:\/\/calendar\.google\.com\/calendar\/event\?eid=[A-Za-z0-9_-]+$/u.test(event.url||'')) return null;
    const link = el('a', label, 'calendar-link');
    link.href = event.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    return link;
  };
  const modeHint = data => data.mode === 'saved'
    ? 'Сохранено на устройстве · '+formatDate(data.asOf,true)+'. '+
      (data.coversToday ? 'Проверь обновления при появлении связи.' : 'Сохранённый период закончился. Нужно обновить расписание.')
    : data.mode === 'snapshot'
    ? 'Снимок календаря · '+formatDate(data.asOf)+'. Автообновление пока не подключено.'
    : data.mode === 'not-connected' ? 'Google Календарь ещё не подключён.' : '';

  function resolveClient(event, clientId) {
    const s = state();
    const task = Object.values(s.tasks).find(item=>item.calendarEvent?.id===event.id);
    return calendarClient(event,s.clients,clientId || selectedClients.get(event.id) || event.clientId || task?.clientId);
  }
  const visible=(event,client,context)=>event.kind==='group'?previewGroupScheduleVisible(event,state(),context):
    previewScheduleVisible(event,client,Object.values(state().tasks).find(task=>task.calendarEvent?.id===event.id),context);
  function scheduleEntries(events, kind, context) {
    const candidates = events.filter(event=>matchesScheduleKind(event,kind));
    if (context.role==='athlete') return athleteScheduleEntries(state(),context.athleteId,candidates);
    return candidates.map(event=>({event,client:resolveClient(event),day:localDate(new Date(event.start))}))
      .filter(({event,client})=>visible(event,client,context));
  }

  async function align(event, client) {
    if (!client || !event.canAlign || aligning.has(event.id)) return;
    const title = 'Персональная · '+client.name+' · Сергей';
    if (event.title===title && event.clientId===client.id) return;
    aligning.add(event.id);
    try {
      const response = await service('/calendar/align',{eventId:event.id,clientId:client.id,clientName:client.name,expectedTitle:event.title});
      if (response.error) throw Error(response.error);
      if (response.status==='changed' || response.status==='unchanged') {
        event.title = title;
        event.clientId = client.id;
      }
    } finally {
      aligning.delete(event.id);
    }
  }

  function schedule(kind) {
    const context=roleContext();
    const list = el('div', null, 'stack'), status = text('','muted small calendar-load-status'), box = el('section', null, 'stack');
    const archive = pastSchedule(kind,context);
    const upcomingSection = section('Ближайшие тренировки',CALENDAR_UPCOMING_SECTION,[list]);
    status.setAttribute('role', 'status');
    const display = async data => {
        const upcoming = scheduleEntries(data.events.filter(event=>!hasEnded(event)),kind,context);
        status.textContent = modeHint(data);
        archive.display(data);
        list.replaceChildren();
        const empty = {group:'групповых тренировок',gym:'тренировок в зале',outside:'тренировок на улице'};
        append(list,upcoming.length ? calendarEntries(upcoming) :
          data.mode === 'live' && text('На ближайшие 30 дней '+(empty[kind] || 'тренировок')+' нет.'));
        for (const {event,client} of context.role==='superadmin'&&data.mode==='live' ? upcoming : []) {
          if (!list.isConnected) break;
          try { await align(event,client); }
          catch { break; } // Name alignment on the Mac must not hide a working cloud schedule.
        }
    };
    const update = async force => {
      const snapshot = dataSource.snapshot();
      if (snapshot && !list.children.length) await display(snapshot);
      status.textContent = snapshot ? modeHint(snapshot)+' Обновляю…' : 'Загружаю расписание…';
      try {
        await display(await load(force));
      } catch(error) {
        status.textContent = error.message;
      }
    };
    const staffing=(!kind||kind==='group')&&['coach','superadmin'].includes(context.role)
      && button('Расписание групповых',()=>{staffingWeek=null;navigate(GROUP_STAFFING_ROUTE);},'subtle');
    append(box,append(el('div',null,'page-title calendar-heading'),el('h2','Тренировки'),
      button('Обновить',()=>update(true),'subtle')),staffing&&row(staffing),status,append(el('div'),archive.fold,upcomingSection));
    void update(false);
    return box;
  }

  function groupSchedule(){
    return createGroupStaffingUI({state,context:roleContext,el,append,text,button,row,field,input,modal,section,formatDate,timeRange,
      navigate,commit,message,loadWeek:dataSource.loadWeek,initialWeek:staffingWeek,copiedWeeks:copiedGroupWeeks,onWeekChange:day=>{staffingWeek=day;},
      writeCalendar:async action=>{
        try{return await writeGroupCalendar(action);}
        finally{dataSource.invalidate();}
      },
      eventKey:async event=>(await sessionIds('staffing:'+groupEventReference(event))).sessionId});
  }

  function pastSchedule(kind, context) {
    const month = localDate().slice(0,7);
    const key = [month,kind,context.role,context.coachId,context.athleteId].join('|');
    if (archiveView?.key!==key) archiveView = {key,limit:historyPageSize,months:new Map()};
    const view = archiveView;
    const status = text('','muted small calendar-history-status'), list = el('div',null,'stack');
    status.setAttribute('role','status');
    let current, entries = [], rendering = 0;
    const more = button('Показать ещё',async()=>{
      const shown = Math.min(entries.length,view.limit);
      if (shown===entries.length) {
        const oldest = [...view.months.keys()].at(-1) || month;
        const previous = addDays(oldest+'-01',-1).slice(0,7);
        status.textContent = 'Загружаю более ранние тренировки…';
        try {
          const data = await dataSource.loadHistory(previous);
          view.months.set(previous,data);
          const found = scheduleEntries(data.events.filter(hasEnded),kind,context).length;
          const period = monthFormat.format(new Date(previous+'-15T12:00:00Z'));
          status.textContent = found ? '' : 'Нет тренировок за '+period;
          if (data.mode==='saved') status.textContent = [status.textContent,'Показаны сохранённые данные.'].filter(Boolean).join(' ');
        } catch(error) {
          status.textContent = error.message;
          return;
        }
      } else status.textContent = '';
      view.limit = shown+historyPageSize;
      await draw();
    },'subtle');
    more.hidden = true;
    const fold = section('Прошлые тренировки',CALENDAR_ARCHIVE_SECTION,[list,status,more]);
    fold.classList.add('calendar-history');
    async function draw() {
      if (!fold.open || !current) return;
      const run = ++rendering;
      const past = [...view.months.values()].flatMap(data=>data.events);
      past.push(...current.events.filter(event=>localDate(new Date(event.start)).startsWith(month+'-')));
      const newestFirst = [...new Map(past.filter(hasEnded).map(event=>[event.id,event])).values()]
        .sort((a,b)=>Date.parse(b.start)-Date.parse(a.start));
      entries = scheduleEntries(newestFirst,kind,context);
      const visibleEntries = entries.slice(0,view.limit);
      const operations = accounting(state()).operations;
      await Promise.all(visibleEntries.filter(item=>item.event.kind!=='group').map(async item=>{
        const operation = operations[(await sessionIds(item.event.id)).sessionId];
        item.recorded = Boolean(operation && !operation.voided);
      }));
      if (run!==rendering) return;
      list.replaceChildren(visibleEntries.length ? calendarEntries(visibleEntries,true) : text('В загруженном периоде тренировок нет.'));
      const remaining = entries.length-visibleEntries.length;
      more.textContent = 'Показать ещё'+(remaining?' · '+remaining:'');
      more.hidden = false;
    }
    fold.addEventListener('toggle',()=>void draw());
    return {fold,display(data){current=data;void draw();}};
  }

  function calendarEntries(entries, past = false) {
    const list = el('div',null,'stack');
    const athlete = roleContext().role==='athlete';
    const completed=new Map(groupRecords(state()).filter(e=>e.calendarRef).map(e=>[e.calendarRef,e]));
    let previousDay;
    for (const {event,client,day,recorded} of entries) {
      const group=event.kind==='group';
      if (day !== previousDay) list.append(el('h3',formatDate(day),'calendar-day'));
      previousDay = day;
      const kind = calendarKind(event);
      const completion=group&&completed.get(groupEventReference(event));
      const responsible=group&&(state().clients[completion?.clientId]?.name||
        coachContact(state(),groupCoach(event,state()))?.name||event.coachName||'требует уточнения');
      const title = group ? (event.location?'Групповая · '+event.location:'Групповая тренировка') :
        athlete?'Персональная · '+TRAINING_KIND_LABELS[kind]:client?.name || calendarName(event);
      const route = past ? CALENDAR_ARCHIVE_ROUTE+'/'+day.slice(0,7) : '#todo/schedule';
      const card = button('',()=>navigate(route+'/'+encodeURIComponent(event.id)),'panel calendar-event');
      if (kind) card.dataset.kind = kind;
      list.append(append(card,
        text(timeRange(event),'calendar-time'),
        append(el('div'),el('strong',title),
          group?text('Ответственный · '+responsible):event.location&&text(event.location),
          past&&el('span',group&&completion?.voided?'Не проведена':group&&completion?.type===GROUP_REPORT?'Проведена · отчёт':(group?completion:recorded)?'Проведена':'Без отметки','chip'))));
    }
    return list;
  }

  async function changeEvent(event, action, changes) {
    const {start,end,location} = event;
    const response = await service('/calendar/change',{eventId:event.id,action,expected:{start,end,location:location||''},...changes});
    if (response.error) throw Error(response.error);
    if (action==='edit' && response.event?.id!==event.id || action==='cancel' && response.status!=='cancelled') {
      throw Error('Не удалось сохранить изменения в календаре');
    }
    dataSource.invalidate();
    if (archiveView) for (const data of archiveView.months.values()) {
      data.events = data.events.filter(item=>item.id!==event.id);
      if (action==='edit' && localDate(new Date(response.event.start)).startsWith(data.from.slice(0,7)+'-')) data.events.push(response.event);
    }
    if (Object.values(state().tasks).some(task=>task.calendarEvent?.id===event.id)) await commit(s=>{
      for (const task of Object.values(s.tasks)) if (task.calendarEvent?.id===event.id) {
        if (action==='cancel') task.calendarEvent.cancelled = true;
        else {
          const {id,start,end,location,url} = response.event;
          const coachId=response.event.coachId||task.calendarEvent.coachId;
          task.calendarEvent = {id,start,end,location,url,...(coachId&&{coachId})};
        }
      }
    },false);
    return response.event;
  }

  function editEvent(event, onSaved) {
    let updated;
    modal('Изменить тренировку',form=>{
      const date = input('date',localDate(new Date(event.start)));
      const time = input('time',clock.format(new Date(event.start)));
      const minutes = input('number',String(Math.round((Date.parse(event.end)-Date.parse(event.start))/60_000)));
      const location = input('text',event.location||'');
      date.required = time.required = minutes.required = true;
      minutes.min = '1'; minutes.max = '1440'; location.maxLength = 180;
      append(form,row(field('Дата',date),field('Время Белграда',time)),field('Длительность, мин',minutes),field('Место',location));
      return async()=>{
        if (!form.reportValidity()) throw Error('Проверь дату, время и длительность');
        updated = await changeEvent(event,'edit',{day:date.value,time:time.value,minutes:Number(minutes.value),location:location.value});
      };
    },{onSaved:()=>{onSaved(updated);message('Тренировка обновлена в календаре');}});
  }

  function cancelEvent(event, back) {
    modal('Отменить тренировку',form=>{
      append(form,text([formatDate(localDate(new Date(event.start))),timeRange(event)].join(' · ')),
        text('Встреча будет убрана из расписания и Google Календаря.'));
      return ()=>changeEvent(event,'cancel');
    },{saveLabel:'Отменить тренировку',saveClass:'danger',cancelLabel:'Назад',onSaved:()=>{
      navigate(back);message('Тренировка отменена');
    }});
  }

  function session(eventId, month) {
    const context=roleContext();
    const athlete=context.role==='athlete', restricted=athlete||context.role==='coach';
    const back = month ? CALENDAR_ARCHIVE_ROUTE : '#todo/schedule';
    const content = el('section',null,'stack-lg');
    const page = append(el('div',null,'stack-lg'),button(month?'← К прошлым тренировкам':'← К расписанию',()=>navigate(back),'back subtle'),content);
    const display = async (event, ids, mode) => {
      const s = state(), date = localDate(new Date(event.start));
      if (athlete && !athleteScheduleEntries(s,context.athleteId,[event]).length) {
        content.replaceChildren(text('Тренировка недоступна в этом режиме.'));
        return;
      }
      if(event.kind==='group'){
        if(!athlete&&!visible(event,null,context)){
          content.replaceChildren(text('Тренировка недоступна в этом режиме.'));
          return;
        }
        const calendarRef=groupEventReference(event);
        const hash=await sessionIds('group:'+calendarRef);
        if(!content.isConnected)return;
        const entry=groupCompletion(state(),hash.sessionId,calendarRef);
        const matched=groupCoach(event,state()),expectedCoach=matched&&coachContact(state(),matched);
        const actual=state().clients[entry?.clientId]||expectedCoach;
        const complete=(memberId,voided=false)=>commit(draft=>{
          const currentContext=roleContext();
          const actor=coachContact(draft,currentContext.coachId)?.id;
          if(currentContext.role==='coach'&&coachContact(draft,groupCoach(event,draft))?.id!==actor)
            throw Error('Тренировка закреплена за другим тренером');
          return saveGroupCompletion(draft,hash.sessionId,event,memberId,{...currentContext,coachId:actor},voided);
        });
        const correct=()=>modal(entry&&!entry.voided?'Исправить проведение':'Подтвердить проведение',form=>{
          const choices=previewCoaches(state()).map(([id,name])=>[coachContact(state(),id)?.id,name]).filter(([id])=>id);
          const choice=select([['','Выбери тренера'],...choices],actual?.id||'');
          form.append(field('Кто провёл тренировку',choice));
          return ()=>complete(choice.value);
        });
        const canManage=roleContext().role==='superadmin';
        const canComplete=mode==='live'&&hasEnded(event);
        const actions=canComplete&&!athlete&&append(el('div',null,'row'),
          !entry&&expectedCoach&&button('Провёл',()=>complete(expectedCoach.id),'primary'),
          canManage&&(!expectedCoach||entry)&&button(entry&&!entry.voided?'Исправить проведение':'Подтвердить проведение',correct,'subtle'),
          canManage&&entry&&!entry.voided&&button('Снять отметку',()=>modal('Снять отметку о проведении',form=>{
            form.append(text('Начисление за это занятие будет снято.'));
            return ()=>complete(entry.clientId,true);
          },{saveLabel:'Снять отметку'}),'subtle'));
        content.replaceChildren(el('h1','Групповая тренировка'),append(el('section',null,'panel stack calendar-detail'),
          event.location&&el('h2',event.location),text('Ответственный · '+(actual?.name||event.coachName||'требует уточнения')),
          entry&&el('span',entry.voided?'Не проведена':entry.type===GROUP_REPORT?'Проведена · отчёт':'Проведена','chip'),
          !athlete&&entry?.source&&text(entry.source),
          !athlete&&event.coachName&&(calendarGroupCoach(event,state())!==matched||entry&&expectedCoach?.id!==actual?.id)
            &&text('В Google Календаре · '+event.coachName),
          text([formatDate(date),timeRange(event)].join(' · '),'calendar-time'),
          !athlete&&eventLink(event,'Открыть в Google Календаре'),actions?.children?.length&&actions),...(athlete?[]:[groupProtocol(date)]));
        return;
      }
      const {services,operations} = accounting(s);
      const operation = operations[ids.sessionId];
      const recorded = operation && !operation.voided;
      const existingClientId = operation && services[operation.serviceId]?.clientId;
      const client = athlete?s.clients[context.athleteId]:resolveClient(event,restricted?null:existingClientId);
      if(!visible(event,client,context)){
        content.replaceChildren(text('Тренировка недоступна в этом режиме.'));
        return;
      }
      if(restricted){
        content.replaceChildren(el('h1','Персональная тренировка'),append(el('section',null,'panel stack calendar-detail'),
          client&&(context.role==='coach'?button(client.name,()=>openClient(client.id),'calendar-client'):el('h2',client.name)),
          text([formatDate(date),timeRange(event)].join(' · '),'calendar-time'),event.location&&el('p',event.location),
          recorded&&el('span','Проведена','chip')));
        return;
      }
      const place = calendarPlace(event.location);
      const tariffs = client ? clientServices(s,client.id).filter(tariff=>tariff.kind==='personal' && !tariff.oneOff
        && activeService(tariff,date) && (!place || tariff.place===place)) : [];
      const tariff = recorded ? services[operation.serviceId] : tariffs.length===1 ? tariffs[0] : null;
      const settlement = recorded && personalVisitSettlements(s,client?.id).get(operation.id);
      const credit = tariff && (recorded && !settlement?.fromOtherAdvance
        ? serviceBalance(s,tariff.id).balance : availablePersonalAdvance(s,tariff,recorded?undefined:date));
      const started = Date.parse(event.start) <= Date.now();
      const pickClient = () => modal('Выбрать клиента',form=>{
        const query = input('search',calendarName(event),'Поиск (фамилия имя)');
        query.setAttribute('aria-label','Поиск (фамилия имя)');
        const matches = el('div',null,'stack');
        const update = () => {
          const found = searchClients(query.value).slice(0,10);
          matches.replaceChildren(...found.map(person=>button(person.name,async()=>{
            selectedClients.set(event.id,person.id);
            form.closest('dialog').close();display(event,ids,mode);
            await align(event,person);
          },'client-tile')), ...(!found.length?[text('Клиенты не найдены')]:[]));
        };
        query.addEventListener('input',update);update();append(form,query,matches);
      },{saveLabel:null});

      content.replaceChildren(el('h1','Персональная тренировка'),
        append(el('section',null,'panel stack calendar-detail'),
          append(el('div',null,'row between'),
            client ? button(client.name,()=>openClient(client.id),'calendar-client') : el('h2',calendarName(event)),
            recorded && el('span','Проведена','chip')),
          text([date===localDate()?'Сегодня':null,formatDate(date),timeRange(event)].filter(Boolean).join(' · '),'calendar-time'),
          event.location && el('p',event.location),
          !client && button('Выбрать клиента',pickClient,'subtle'),
          eventLink(event,'Открыть в Google Календаре'),
          !recorded && mode==='live' && event.canEdit && row(
            button('Изменить',()=>editEvent(event,updated=>display(updated,ids,mode)),'subtle'),
            button('Отменить тренировку',()=>cancelEvent(event,back),'subtle danger'))));
      if (!client) return;
      const actions = el('section',null,'stack calendar-actions');
      append(actions,tariff && append(el('div',null,'row between'),el('h2',tariffLabel(tariff)),
        el('strong',money(recorded?operation.amount:tariff.rate,tariff.currency),'money-amount')),
        credit > 0 && text('Остаток аванса · '+money(credit,tariff.currency)),
        settlement?.fromOtherAdvance > 0 && text('Зачтено из аванса · '+money(settlement.fromOtherAdvance,tariff.currency)),
        settlement?.remaining > 0 && text('К оплате за занятие · '+money(settlement.remaining,tariff.currency)));
      if (!recorded) {
        if (tariffs.length) {
          const complete = button('Тренировка состоялась',()=>scheduledSession(client.id,{...ids,date},tariffs),'primary');
          complete.disabled = !started;
          append(actions,tariffs.length>1&&text('Тариф можно выбрать при записи'),complete);
        } else if (started) {
          append(actions,text('На дату тренировки нет подходящего персонального тарифа'),
            button('Добавить тариф',()=>addScheduledTariff(client.id,{date,place}),'subtle'));
        }
      }
      if (actions.children.length) content.append(actions);
    };
    content.append(text('Загружаю тренировку…'));
    const snapshot = month ? dataSource.historySnapshot(month) : dataSource.snapshot();
    const savedEvent = snapshot?.events.find(item=>item.id===eventId);
    const identifiers = sessionIds(eventId);
    if (savedEvent && savedEvent.kind!=='group') void identifiers.then(ids=>display(savedEvent,ids,'saved'));
    void Promise.all([month?dataSource.loadHistory(month):load(),identifiers]).then(([data,ids])=>{
      const event = data.events.find(item=>item.id===eventId);
      if (!event) throw Error('Тренировка не найдена в расписании');
      return display(event,ids,data.mode);
    }).catch(error=>content.replaceChildren(text(error.message)));
    return page;
  }

  function book(task, onSaved) {
    const client = state().clients[task.clientId];
    const context=roleContext();
    modal('Назначить тренировку', (form, enable) => {
      const status = text('Загружаю расписание…'), options = select([], ''), liveForm = el('div',null,'stack');
      status.setAttribute('role','status');
      const choiceField = field('Тренировка', options);
      choiceField.hidden = true; liveForm.hidden = true;
      const today = localDate(), day = input('date', today), time = input('time');
      const minutes = input('number', '60'), place = input('text', '', 'Место тренировки');
      day.min = today; minutes.min = '15'; minutes.max = '180'; place.maxLength = 180;
      append(liveForm, row(field('Дата',day), field('Время Белграда',time)), field('Длительность, мин',minutes), field('Место',place));
      append(form, text(client.name,'task-title'), status, choiceField, liveForm);
      let choices = [], ready = false;
      const refresh = () => {
        liveForm.hidden = options.value !== 'new';
        enable(ready && !!options.value && (liveForm.hidden || day.value && time.value && minutes.value && minutes.validity.valid));
      };
      form.addEventListener('input',refresh);
      queueMicrotask(refresh);
      void load().then(data => {
        const s = state();
        choices = taskCalendarChoices(data.events.filter(event=>!hasEnded(event)&&visible(event,resolveClient(event),context)), s.clients, task, s.tasks);
        const items = choices.map(event => [event.id, [formatDate(event.start), timeRange(event), event.location].filter(Boolean).join(' · ')]);
        if (data.mode === 'live'&&(context.role!=='coach'||context.coachId===OWNER_COACH)) items.push(['new','Создать в Google Календаре']);
        for (const [value,label] of items) {
          const option = el('option',label); option.value = value; options.append(option);
        }
        choiceField.hidden = !items.length;
        status.textContent = [modeHint(data), choices.length ? 'Можно связать задачу с уже записанной тренировкой.' :
          data.mode === 'live' ? 'Выбери дату и время.' : 'Подходящей тренировки в расписании пока нет.'].filter(Boolean).join(' ');
        ready = !!items.length;
        refresh();
      }).catch(error => { status.textContent = error.message; });
      return async () => {
        let event = choices.find(item => item.id === options.value);
        if (options.value === 'new') {
          const response = await service('/calendar/book', {taskId:task.id, clientId:client.id, clientName:client.name,
            day:day.value, time:time.value, minutes:Number(minutes.value), location:place.value});
          if (response.error) throw Error(response.error);
          event = response.event;
          dataSource.invalidate();
        }
        if (!event) throw Error('Выбери тренировку');
        await commit(s => linkCalendarTask(s, task.id, event),false);
      };
    },{saveLabel:'Подтвердить и завершить задачу',onSaved});
  }

  function linked(task) {
    if (!Number.isFinite(Date.parse(task.calendarEvent?.start))) return null;
    const event = task.calendarEvent;
    if(!previewScheduleVisible(event,state().clients[task.clientId],task,roleContext()))return null;
    return append(el('div',null,'row'),text(formatDate(event.start,true)+(event.cancelled?' · Тренировка отменена':' · Тренировка')),
      !event.cancelled&&eventLink(event,'Календарь'));
  }

  return {schedule, groupSchedule, session, book, linked, personalWeek,preload:()=>dataSource.refresh().catch(()=>{})};
}
