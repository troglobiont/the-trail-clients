import {addDays,localDate,TIMEZONE} from './model-utils.js';
import {normalizeSearch} from './core.js';
import {athleteScheduleKinds} from './calendar-ui.js';
import {
  applyTrainingAssignment,ASSIGNMENT_MAX_BYTES,parseTrainingAssignment,previewTrainingAssignment,trainingAssignmentFor
} from './training-assignment.js';

const dayFormat=new Intl.DateTimeFormat('ru-RU',{timeZone:TIMEZONE,weekday:'short'});
const dateFormat=new Intl.DateTimeFormat('ru-RU',{timeZone:TIMEZONE,weekday:'long',day:'numeric',month:'long'});
const dateObject=day=>new Date(day+'T12:00:00Z');

export function athletePlanSessions(state,clientId,sessions,groupWeek){
  const matching=new Set((groupWeek?.sessions||[]).map(session=>session.day+'|'+normalizeSearch(session.title)));
  return sessions.map(session=>matching.has(session.day+'|'+normalizeSearch(session.title))
    && athleteScheduleKinds(state,clientId,session.day).includes('group')?{...session,kind:'group'}:session);
}

export function createTrainingCalendarUI({state,el,append,text,button,row,section,formatDate,modal,navigate,save,message,readWeek,publishWeek,readPersonalWeek,readGroupWeek}){
  const range=week=>formatDate(week.weekStart)+' — '+formatDate(addDays(week.weekStart,6))+' · '+week.weekStart.slice(0,4);

  function weekPanel(week,{preferredId,preferredDay,weekList,individualDots=false,onSelect,describe=session=>session.description,emptyDay=()=> 'Тренировка не назначена'}={}){
    const today=localDate();
    const dates=Array.from({length:7},(_,index)=>addDays(week.weekStart,index));
    const dayBar=el('div',null,'training-calendar-days');
    dayBar.setAttribute('role','group');
    dayBar.setAttribute('aria-label','Дни недели');
    const list=el('div',null,'stack training-calendar-list');
    const detail=el('article',null,'panel stack training-calendar-detail');
    detail.setAttribute('aria-live','polite');
    detail.setAttribute('aria-label','Детали тренировки');
    const selected=week.sessions.find(session=>session.id===preferredId);
    const dayControls=[],sessionControls=[];

    function show(day,session){
      onSelect?.(day,session?.id);
      for(const [date,control] of dayControls)control.setAttribute('aria-pressed',String(date===day));
      for(const [item,control] of sessionControls)control.setAttribute('aria-pressed',String(item===session));
      const workouts=weekList?week.sessions.filter(item=>item.day===day):session?[session]:[];
      const sections=workouts.map(item=>{
        const description=describe(item);
        return append(el('section',null,'stack training-calendar-workout'),el('h2',item.title),
          item.subtitle&&text(item.subtitle),description&&el('p',description,'training-calendar-description'));
      });
      detail.replaceChildren(
        text(dateFormat.format(dateObject(day))+(day===today?' · Сегодня':'')),
        ...(sections.length?sections:[el('h2',emptyDay(day))])
      );
      return sections[workouts.indexOf(session)]||detail;
    }

    for(const day of dates){
      const workouts=week.sessions.filter(session=>session.day===day),first=workouts[0];
      const dots=el('span',null,'training-calendar-dots');
      dots.setAttribute('aria-hidden','true');
      for(const workout of individualDots?workouts:workouts.slice(0,1)){
        const dot=el('span',null,'training-calendar-dot');
        if(workout.kind)dot.dataset.kind=workout.kind;
        dots.append(dot);
      }
      const control=append(button('',()=>show(day,first),'training-calendar-date'),
        el('span',dayFormat.format(dateObject(day))),el('strong',String(Number(day.slice(-2)))),dots);
      control.setAttribute('aria-label',dateFormat.format(dateObject(day))+(day===today?', сегодня':'')+(first?', тренировок: '+workouts.length:''));
      if(day===today)control.setAttribute('aria-current','date');
      dayControls.push([day,control]);
      dayBar.append(control);
    }
    for(const session of week.sessions){
      const control=append(button('',()=>{
        const selectedWorkout=show(session.day,session);
        if(weekList)selectedWorkout.scrollIntoView({block:'start'});
      },'training-calendar-session'),
        text(formatDate(session.day)),el('strong',session.title),
        el('span','›','training-calendar-chevron'));
      control.lastChild.setAttribute('aria-hidden','true');
      sessionControls.push([session,control]);
      list.append(control);
    }
    if(!week.sessions.length)list.append(text('На эту неделю нет тренировок.'));
    const initialDay=selected?.day||preferredDay||(dates.includes(today)?today:week.sessions[0]?.day||week.weekStart);
    show(initialDay,selected||week.sessions.find(session=>session.day===initialDay));
    return append(el('div',null,'stack'),dayBar,weekList?detail:append(el('div',null,'training-calendar-layout'),list,detail),
      weekList&&weekList(list));
  }

  function checkedPublication(remote,client){
    if(!remote?.published)return null;
    const week=parseTrainingAssignment(JSON.stringify(remote.published));
    if(week.athleteId!==client.athlete?.trainingPeaksId)throw Error('Привязка облачной недели изменилась.');
    return week;
  }

  function athleteCalendar(client){
    const today=localDate(),weekday=dateObject(today).getUTCDay();
    const weekStart=addDays(today,-((weekday+6)%7)),connected=Boolean(client.athlete?.trainingPeaksId);
    const local=trainingAssignmentFor(state(),client);
    let plan=local?.weekStart===weekStart?local:null,sessions=[],groupWeek=null,preferredDay,preferredId;
    const notices=el('div',null,'stack athlete-calendar-notices'),content=el('div',null,'stack');
    notices.setAttribute('aria-live','polite');
    const page=append(el('div',null,'stack-lg'),append(el('header',null,'stack'),el('h1','Календарь'),
      text(range({weekStart}))),content,notices);

    function draw(){
      const fromPlan=athletePlanSessions(state(),client.id,plan?.sessions||[],groupWeek);
      const calendarSessions=[...fromPlan,...sessions].sort((a,b)=>a.day.localeCompare(b.day));
      content.replaceChildren(weekPanel({weekStart,sessions:calendarSessions},{preferredId,preferredDay,individualDots:true,
        weekList:list=>section('Тренировки недели','athlete-week-list-'+client.id,[list]),
        emptyDay:()=> 'На этот день тренировки не назначены',
        onSelect:(day,id)=>{preferredDay=day;preferredId=id;}}));
    }

    async function refresh(){
      notices.replaceChildren(text('Загружаю тренировки недели…'));
      const hasGroup=connected&&Array.from({length:7},(_,i)=>addDays(weekStart,i))
        .some(day=>athleteScheduleKinds(state(),client.id,day).includes('group'));
      const [published,personal,group]=await Promise.allSettled([
        connected?readWeek(client.id,false).then(value=>checkedPublication(value,client)):null,
        readPersonalWeek(client.id,weekStart),hasGroup?readGroupWeek(weekStart):null
      ]);
      if(!page.isConnected)return;
      if(published.status==='fulfilled'&&published.value?.weekStart===weekStart)plan=published.value;
      if(personal.status==='fulfilled')sessions=personal.value.sessions;
      if(group.status==='fulfilled')groupWeek=group.value;
      notices.replaceChildren();
      append(notices,published.status==='rejected'?text('Не удалось обновить план недели.','warning-text small'):
        !plan&&text('План на эту неделю пока не опубликован.'),
        personal.status==='rejected'?text('Не удалось обновить персональные встречи.','warning-text small'):
          personal.value.saved&&text('Персональные встречи показаны из сохранённого расписания.'),
        (published.status==='rejected'||personal.status==='rejected')&&row(button('Повторить',refresh,'subtle')));
      draw();
    }

    if(plan)draw();
    void refresh();
    return page;
  }

  function load(client){
    modal('Загрузить тренировки', (form,enable)=>{
      const picker=el('input');picker.type='file';picker.accept='.json,application/json';
      const status=el('div',null,'stack');
      status.setAttribute('aria-live','polite');
      append(form,append(el('label','Файл личной недели'),picker),status);
      let candidate=null;
      enable(false);
      picker.addEventListener('change',async()=>{
        const file=picker.files[0];
        candidate=null;
        enable(false);
        status.replaceChildren();
        if(!file)return;
        try{
          if(file.size>ASSIGNMENT_MAX_BYTES)throw Error('Размер файла недели превышает 128 КБ.');
          const contents=await file.text();
          if(picker.files[0]!==file||!picker.isConnected)return;
          const week=parseTrainingAssignment(contents);
          const changed=previewTrainingAssignment(state(),client.id,week);
          append(status,el('strong',client.name+' · '+range(week)),
            ...week.sessions.map(session=>text(formatDate(session.day)+' · '+session.title)),
            !week.sessions.length&&text('В файле нет тренировок на эту неделю.'),
            !changed&&text('Эта неделя уже сохранена.'));
          if(changed){candidate=week;enable(true);}
        }catch(error){
          if(picker.files[0]===file&&picker.isConnected)status.append(text(error.message,'danger-text small'));
        }
      });
      return async()=>{
        if(!candidate)throw Error('Сначала выбери файл недели.');
        picker.disabled=true;
        try{
          const changed=await save(draft=>applyTrainingAssignment(draft,client.id,candidate));
          message(changed?'Тренировки сохранены на этом устройстве.':'Эта неделя уже сохранена.');
        }finally{picker.disabled=false;}
      };
    },{saveLabel:'Сохранить неделю'});
  }

  function page(client,{calendar=false,canImport=false,back}={}){
    if(calendar)return athleteCalendar(client);
    const local=trainingAssignmentFor(state(),client);
    const heading=text('');
    const publication=el('div',null,'stack');
    publication.setAttribute('aria-live','polite');
    const content=el('div',null,'stack');
    const out=append(el('div',null,'stack-lg'),
      back&&row(button('← К профилю',()=>navigate(back),'subtle')),
      append(el('header',null,'stack'),el('h1','Детали тренировок'),heading),
      publication,content,canImport&&row(button('Загрузить файл на устройство',()=>load(client),'subtle')));
    function showWeek(week,loading=false){
      heading.textContent=[client?.name,week&&range(week)].filter(Boolean).join(' · ');
      content.replaceChildren(week?weekPanel(week):text(loading
        ?'Проверяю облачную неделю…':'Личная тренировочная неделя пока не опубликована.'));
    }
    async function refresh(){
      try{
        const remote=await readWeek(client.id,canImport);
        if(!out.isConnected)return;
        const published=checkedPublication(remote,client);
        showWeek(published&&(!local||published.weekStart>=local.weekStart)?published:local);
        publication.replaceChildren();
        const ready=canImport&&remote?.prepared;
        if(!ready)return;
        publication.append(append(el('section',null,'panel stack'),
          el('strong','Готова к публикации · '+range(ready)),text('Тренировок: '+ready.count),
          row(button('Опубликовать неделю',async()=>{
            await publishWeek(client.id,ready);
            await refresh();
            message('Неделя опубликована');
          },'primary'))));
      }catch(error){
        if(!out.isConnected)return;
        showWeek(local);
        publication.replaceChildren(text(error.message,'warning-text small'),
          row(button('Повторить',refresh,'subtle')));
      }
    }
    const connected=Boolean(client?.athlete?.trainingPeaksId);
    showWeek(local,connected);
    if(connected)void refresh();
    return out;
  }
  return {page,weekPanel};
}
