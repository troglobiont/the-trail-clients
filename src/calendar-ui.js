import {addDays, localDate, TIMEZONE} from './model-utils.js';
import {linkCalendarTask, normalizeSearch} from './core.js';
import {accounting, activeService, clientServices, money, serviceBalance, tariffLabel} from './accounting.js';

const clock = new Intl.DateTimeFormat('ru-RU', {timeZone:TIMEZONE, hour:'2-digit', minute:'2-digit'});
const monthName = new Intl.DateTimeFormat('ru-RU', {timeZone:TIMEZONE,month:'long'});
const hasEnded = event => Date.parse(event.end) <= Date.now();

export function isSchedulingTask(task) {
  return !task.pauseContact && (task.calendarEvent ||
    /согласов|назнач|договор/u.test(task.title.toLowerCase()) && /заняти|трениров/u.test(task.title.toLowerCase()));
}

export function taskCalendarChoices(events, clients, task, tasks) {
  const reserved = new Set(Object.values(tasks).filter(t => t.id !== task.id).map(t => t.calendarEvent?.id));
  return events.filter(event => !reserved.has(event.id) && calendarClient(event,clients)?.id === task.clientId);
}

const calendarName = event => event.title.split('·')[1]?.trim() || event.title;

export function calendarClient(event, clients, linkedId) {
  const available = client => client && !client.mergedInto && (!client.role || client.role === 'Клиент');
  if (linkedId || event.clientId) {
    const direct = clients[linkedId || event.clientId];
    const client = direct?.mergedInto ? clients[direct.mergedInto] : direct;
    return available(client) ? client : undefined;
  }
  const words = name => name.trim().split(/\s+/u).map(normalizeSearch).filter(Boolean);
  const signature = parts => [...parts].sort().join(' ');
  const person = words(calendarName(event)), target = signature(person);
  if (!person.length) return;
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

export function createCalendarUI({state, service, el, append, button, row, field, input, select, text, section, modal, commit, formatDate,
    navigate, openClient, message, searchClients, scheduledSession, addScheduledTariff}) {
  let cached, loading;
  const selectedClients = new Map();
  const aligning = new Set();
  const readCalendar = async (from,to) => {
    const value = await service('/calendar/list', {from,to});
    if (value.error) throw Error(value.error);
    if (!Array.isArray(value.events)) throw Error('Не удалось прочитать расписание');
    return value;
  };
  const load = (force = false) => {
    if (loading) return loading;
    const today = localDate(), firstDay = today.slice(0,7)+'-01';
    if (!force && cached?.today === today && cached.until > Date.now()) return Promise.resolve(cached.value);
    loading = Promise.all([
      readCalendar(today,addDays(today,30)),
      readCalendar(firstDay,addDays(today,1)).catch(error=>({events:[],error:error.message}))
    ]).then(([upcoming,history]) => {
      const events = new Map([...history.events,...upcoming.events].map(event=>[event.id,event]));
      const value = {...upcoming,events:[...events.values()].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)),historyError:history.error};
      cached = {value,today,until:Date.now() + 60_000};
      return value;
    }).finally(() => { loading = null; });
    return loading;
  };
  const timeRange = event => clock.format(new Date(event.start)) + '–' + clock.format(new Date(event.end));
  const eventLink = (event, label) => {
    if (!/^https:\/\/calendar\.google\.com\/calendar\/event\?eid=[A-Za-z0-9_-]+$/u.test(event.url||'')) return null;
    const link = el('a', label, 'calendar-link');
    link.href = event.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    return link;
  };
  const modeHint = data => data.mode === 'snapshot'
    ? 'Снимок календаря · '+formatDate(data.asOf)+'. Автообновление пока не подключено.'
    : data.mode === 'not-connected' ? 'Google Календарь ещё не подключён.' : '';

  function resolveClient(event, clientId) {
    const s = state();
    const task = Object.values(s.tasks).find(item=>item.calendarEvent?.id===event.id);
    return calendarClient(event,s.clients,clientId || selectedClients.get(event.id) || event.clientId || task?.clientId);
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

  function schedule() {
    const list = el('div', null, 'stack'), status = text(''), box = el('section', null, 'stack');
    status.setAttribute('role', 'status');
    const update = async force => {
      status.textContent = 'Загружаю расписание…';
      list.replaceChildren();
      try {
        const data = await load(force);
        const entries = data.events.map(event=>({event,client:resolveClient(event)}));
        const upcoming = entries.filter(({event})=>!hasEnded(event));
        const month = localDate().slice(0,7);
        const past = entries.filter(({event})=>hasEnded(event) && localDate(new Date(event.start)).startsWith(month)).reverse();
        const operations = accounting(state()).operations;
        await Promise.all(past.map(async item=>{
          const operation = operations[(await sessionIds(item.event.id)).sessionId];
          item.recorded = Boolean(operation && !operation.voided);
        }));
        status.textContent = modeHint(data);
        const monthLabel = monthName.format(new Date(month+'-15T12:00:00Z'));
        const pastSection = section('Прошлые · '+monthLabel,'calendar-past-'+month,
          data.historyError ? [text(data.historyError,'danger-text small')] : past.length ? [
            text('В расписании · '+past.length+'  /  Отмечено через расписание · '+past.filter(item=>item.recorded).length),
            calendarEntries(past,true)
          ] : [text('В этом месяце прошедших тренировок в расписании нет.')]);
        append(list,pastSection,upcoming.length ? calendarEntries(upcoming) :
          data.mode === 'live' && text('На ближайшие 30 дней персональных тренировок нет.'));
        for (const {event,client} of upcoming) {
          if (!list.isConnected) break;
          await align(event,client).catch(()=>{
            status.textContent = 'Имена в приложении актуальны. Обновить названия в Google Календаре можно повторным нажатием «Обновить».';
          });
        }
      } catch(error) {
        status.textContent = error.message;
      }
    };
    append(box,append(el('div',null,'page-title'),el('h2','Персональные тренировки'),button('Обновить',()=>update(true),'subtle')),status,list);
    void update(false);
    return box;
  }

  function calendarEntries(entries, past = false) {
    const list = el('div',null,'stack');
    let previousDay;
    for (const {event,client,recorded} of entries) {
      const day = localDate(new Date(event.start));
      if (day !== previousDay) list.append(el('h3',formatDate(day),'calendar-day'));
      previousDay = day;
      list.append(append(button('',()=>navigate('#todo/schedule/'+encodeURIComponent(event.id)),'panel calendar-event'),
        text(timeRange(event),'calendar-time'),
        append(el('div'),el('strong',client?.name || calendarName(event)),event.location&&text(event.location),
          past&&el('span',recorded?'Проведена':'Без отметки','chip'))));
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
    cached = null;
    if (Object.values(state().tasks).some(task=>task.calendarEvent?.id===event.id)) await commit(s=>{
      for (const task of Object.values(s.tasks)) if (task.calendarEvent?.id===event.id) {
        if (action==='cancel') task.calendarEvent.cancelled = true;
        else {
          const {id,start,end,location,url} = response.event;
          task.calendarEvent = {id,start,end,location,url};
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

  function cancelEvent(event) {
    modal('Отменить тренировку',form=>{
      append(form,text([formatDate(localDate(new Date(event.start))),timeRange(event)].join(' · ')),
        text('Встреча будет убрана из расписания и Google Календаря.'));
      return ()=>changeEvent(event,'cancel');
    },{saveLabel:'Отменить тренировку',saveClass:'danger',cancelLabel:'Назад',onSaved:()=>{
      navigate('#todo/schedule');message('Тренировка отменена');
    }});
  }

  function session(eventId) {
    const content = el('section',null,'stack-lg');
    const page = append(el('div',null,'stack-lg'),button('← К расписанию',()=>navigate('#todo/schedule'),'back subtle'),content);
    const display = (event, ids, mode) => {
      const s = state(), date = localDate(new Date(event.start));
      const {services,operations} = accounting(s);
      const operation = operations[ids.sessionId];
      const recorded = operation && !operation.voided;
      const existingClientId = operation && services[operation.serviceId]?.clientId;
      const client = resolveClient(event,existingClientId);
      const place = calendarPlace(event.location);
      const tariffs = client ? clientServices(s,client.id).filter(tariff=>tariff.kind==='personal' && !tariff.oneOff
        && activeService(tariff,date) && (!place || tariff.place===place)) : [];
      const tariff = recorded ? services[operation.serviceId] : tariffs.length===1 ? tariffs[0] : null;
      const credit = tariff && serviceBalance(s,tariff.id).balance;
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
            button('Отменить тренировку',()=>cancelEvent(event),'subtle danger'))));
      if (!client) return;
      const actions = el('section',null,'stack calendar-actions');
      append(actions,tariff && append(el('div',null,'row between'),el('h2',tariffLabel(tariff)),
        el('strong',money(recorded?operation.amount:tariff.rate,tariff.currency),'money-amount')),
        credit > 0 && text('Остаток аванса · '+money(credit,tariff.currency)),
        recorded && credit < 0 && text('К оплате по тарифу · '+money(-credit,tariff.currency)));
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
    void Promise.all([load(),sessionIds(eventId)]).then(([data,ids])=>{
      const event = data.events.find(item=>item.id===eventId);
      if (!event) throw Error('Тренировка не найдена в расписании');
      display(event,ids,data.mode);
    }).catch(error=>content.replaceChildren(text(error.message)));
    return page;
  }

  function book(task, onSaved) {
    const client = state().clients[task.clientId];
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
        choices = taskCalendarChoices(data.events.filter(event=>!hasEnded(event)), s.clients, task, s.tasks);
        const items = choices.map(event => [event.id, [formatDate(event.start), timeRange(event), event.location].filter(Boolean).join(' · ')]);
        if (data.mode === 'live') items.push(['new','Создать в Google Календаре']);
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
          cached = null;
        }
        if (!event) throw Error('Выбери тренировку');
        await commit(s => linkCalendarTask(s, task.id, event),false);
      };
    },{saveLabel:'Подтвердить и завершить задачу',onSaved});
  }

  function linked(task) {
    if (!Number.isFinite(Date.parse(task.calendarEvent?.start))) return null;
    const event = task.calendarEvent;
    return append(el('div',null,'row'),text(formatDate(event.start,true)+(event.cancelled?' · Тренировка отменена':' · Тренировка')),
      !event.cancelled&&eventLink(event,'Календарь'));
  }

  return {schedule, session, book, linked};
}
