import {addDays,localDate,TIMEZONE} from './model-utils.js';
import {
  applyTrainingAssignment,ASSIGNMENT_MAX_BYTES,parseTrainingAssignment,previewTrainingAssignment,trainingAssignmentFor
} from './training-assignment.js';

const dayFormat=new Intl.DateTimeFormat('ru-RU',{timeZone:TIMEZONE,weekday:'short'});
const dateFormat=new Intl.DateTimeFormat('ru-RU',{timeZone:TIMEZONE,weekday:'long',day:'numeric',month:'long'});
const dateObject=day=>new Date(day+'T12:00:00Z');

export function createTrainingCalendarUI({state,el,append,text,button,row,formatDate,modal,navigate,save,message,readWeek,publishWeek}){
  const range=week=>formatDate(week.weekStart)+' — '+formatDate(addDays(week.weekStart,6))+' · '+week.weekStart.slice(0,4);

  function weekPanel(week,{preferredId,describe=session=>session.description,emptyDay=()=> 'Тренировка не назначена'}={}){
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
      for(const [date,control] of dayControls)control.setAttribute('aria-pressed',String(date===day));
      for(const [item,control] of sessionControls)control.setAttribute('aria-pressed',String(item===session));
      const description=session&&describe(session);
      detail.replaceChildren(
        text(dateFormat.format(dateObject(day))+(day===today?' · Сегодня':'')),
        el('h2',session?.title||emptyDay(day)),
        ...(description?[el('p',description,'training-calendar-description')]:[])
      );
    }

    for(const day of dates){
      const first=week.sessions.find(session=>session.day===day);
      const control=append(button('',()=>show(day,first),'training-calendar-date'),
        el('span',dayFormat.format(dateObject(day))),el('strong',String(Number(day.slice(-2)))),
        el('span',first?'•':'\u00a0','training-calendar-dot'));
      control.setAttribute('aria-label',dateFormat.format(dateObject(day))+(day===today?', сегодня':'')+(first?', есть тренировка':''));
      if(day===today)control.setAttribute('aria-current','date');
      dayControls.push([day,control]);
      dayBar.append(control);
    }
    for(const session of week.sessions){
      const control=append(button('',()=>show(session.day,session),'training-calendar-session'),
        text(formatDate(session.day)),el('strong',session.title),el('span','›','training-calendar-chevron'));
      control.lastChild.setAttribute('aria-hidden','true');
      sessionControls.push([session,control]);
      list.append(control);
    }
    if(!week.sessions.length)list.append(text('На эту неделю нет тренировок.'));
    const initialDay=selected?.day||(dates.includes(today)?today:week.sessions[0]?.day||week.weekStart);
    show(initialDay,selected||week.sessions.find(session=>session.day===initialDay));
    return append(el('div',null,'stack'),dayBar,append(el('div',null,'training-calendar-layout'),list,detail));
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
    const local=trainingAssignmentFor(state(),client);
    const heading=text('');
    const publication=el('div',null,'stack');
    publication.setAttribute('aria-live','polite');
    const content=el('div',null,'stack');
    const out=append(el('div',null,'stack-lg'),
      back&&row(button('← К профилю',()=>navigate(back),'subtle')),
      append(el('header',null,'stack'),el('h1',calendar?'Календарь':'Детали тренировок'),heading),
      publication,content,canImport&&row(button('Загрузить файл на устройство',()=>load(client),'subtle')));
    function showWeek(week,loading=false){
      heading.textContent=[calendar?'Мои тренировки':client?.name,week&&range(week)].filter(Boolean).join(' · ');
      content.replaceChildren(week?weekPanel(week):text(loading
        ?'Проверяю облачную неделю…':'Личная тренировочная неделя пока не опубликована.'));
    }
    async function refresh(){
      try{
        const remote=await readWeek(client.id,canImport);
        if(!out.isConnected)return;
        const published=remote?.published&&parseTrainingAssignment(JSON.stringify(remote.published));
        if(published&&published.athleteId!==client.athlete.trainingPeaksId)throw Error('Привязка облачной недели изменилась.');
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
