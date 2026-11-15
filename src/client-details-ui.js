import * as C from './core.js';
import { GOAL_TYPES, RACE_STAGES, REQUIRED_PROFILE_FIELDS, goalType, normalizeClientCity, raceById, raceCatalog, raceCategory, raceParticipants, telegramLink, telegramPeer } from './client-details.js';

export function createClientDetailsUI({state,ui,el,append,button,row,field,input,select,text,section,modal,commit,render,formatDate,openClient,message,focusCard}) {
  const trainingFields = [
    ['height','Рост, см',30,300,.1],['weight','Вес, кг',10,500,.1],['maxHr','Максимальный пульс',30,250,1],
    ['restHr','Пульс в покое',20,160,1],['lthr','Рабочий LTHR',30,250,1]
  ];
  const trainingStatuses = [['','Не указан'],['candidate','Результат теста, проверить'],['working','Рабочий'],['confirmed','Подтверждён']];
  const profileFields = [
    ['phone','Основной местный телефон','tel',''],['secondPhone','Дополнительный телефон','tel',''],
    ['email','Email','email',''],['telegram','Telegram','text','@…'],['instagram','Instagram','text','@…'],
    ['city','Основной город','text',''],['profession','Профессия','text','']
  ];
  function link(label,href,className='inline-link') {
    const a=el('a',label,className);a.href=href;return a;
  }
  function profileEditor(data = {}) {
    const element=el('div',null,'stack');
    const controls={};
    for(const [key,label,type,placeholder] of profileFields){
      const control=input(type,key==='city'?normalizeClientCity(data[key]):data[key]||'',placeholder);
      controls[key]=control;
      if(type==='tel'){
        const withPrefix=()=>{
          const value='+'+control.value.trimStart().replace(/\+/g,'');
          if(control.value!==value)control.value=value;
        };
        control.addEventListener('focus',withPrefix);
        control.addEventListener('input',withPrefix);
        control.addEventListener('blur',()=>{
          if(control.value.trim()==='+')control.value='';
        });
      }
      element.append(field(label,control));
    }
    const stored=data.birthday||'';
    const day=input('number',stored.slice(-2)),month=input('number',stored.slice(-5,-3)),year=input('number',stored.length===10?stored.slice(0,4):'');
    day.min=1;day.max=31;month.min=1;month.max=12;year.min=1900;year.max=Number(C.localDate().slice(0,4));
    const dateFields=append(el('div',null,'profile-birthday'),field('День',day),field('Месяц',month),field('Год',year));
    append(element,el('h3','День рождения'),dateFields);
    return {
      element,
      requireFields(required){
        for(const key of REQUIRED_PROFILE_FIELDS)controls[key].required=required;
        day.required=month.required=required;
      },
      values(){
        const hasDate=day.value||month.value||year.value;
        if(hasDate&&(!day.value||!month.value))throw Error('Укажи день и месяц рождения');
        if([day,month,year].some(control=>control.validity.badInput||control.validity.rangeOverflow
          ||control.validity.rangeUnderflow||control.validity.stepMismatch))throw Error('Проверь дату рождения');
        const birthday=hasDate?[year.value,month.value.padStart(2,'0'),day.value.padStart(2,'0')].filter(Boolean).join('-'):'';
        return {...Object.fromEntries(Object.entries(controls).map(([key,control])=>[key,control.value])),birthday};
      }
    };
  }
  function editProfile(c) {
    modal('О клиенте',form=>{
      const editor=profileEditor(c.profile);
      const required=c.role==='Клиент';
      editor.requireFields(required);
      form.append(editor.element);
      return ()=>{
        const values=editor.values();
        return commit(s=>C.saveProfile(s,c.id,values,{required}));
      };
    });
  }
  function profile(c) {
    const data=c.profile||{};
    const items=profileFields.map(([key,label])=>{
      const value=key==='city'?normalizeClientCity(data.city)
        :key==='telegram'&&c.telegram?.username?'@'+c.telegram.username:data[key]||(key==='telegram'?c.telegramHint:null);
      if(!value)return null;
      const href=key==='phone'||key==='secondPhone'?'tel:'+value.replace(/[^+\d]/g,''):key==='email'?'mailto:'+value:null;
      return append(el('div',null,'detail-line'),text(label),href?link(value,href):el('div',value));
    }).filter(Boolean);
    if(data.birthday)items.push(append(el('div',null,'detail-line'),text('День рождения'),el('div',formatDate('2000-'+data.birthday.slice(-5))+(data.birthday.length===10?' '+data.birthday.slice(0,4):''))));
    return [...(items.length?items:[text('Контактные данные пока не внесены')]),button('Изменить данные',()=>editProfile(c),'subtle')];
  }
  function editTraining(c) {
    modal('Тренировочные данные',form=>{
      const data=c.training||{}, values={};
      for(const [key,label,min,max,step] of trainingFields){
        const control=input('number',data[key]??'');control.min=min;control.max=max;control.step=step;
        form.append(field(label,control));values[key]=control;
      }
      const date=input('date',data.date||''),status=select(trainingStatuses,data.status||''),source=input('text',data.source||'','Например, тест 30 минут');source.maxLength=180;
      append(form,field('Дата измерения',date),field('Статус LTHR',status),field('Источник',source));
      return ()=>commit(s=>C.saveTraining(s,c.id,{...Object.fromEntries(Object.entries(values).map(([k,v])=>[k,v.value])),date:date.value,status:status.value,source:source.value}));
    });
  }
  function training(c) {
    const out=[],data=c.training||{};
    for(const [key,label] of trainingFields) if(data[key]!=null)out.push(append(el('div',null,'detail-line'),text(label),el('div',String(data[key]))));
    const metadata=[trainingStatuses.find(([k])=>k===data.status)?.[1],data.date&&formatDate(data.date),data.source].filter(Boolean);
    if(metadata.length)out.push(text(metadata.join(' · ')));
    out.push(button('Изменить данные',()=>editTraining(c),'subtle'),el('h3','Зоны бега'));
    if(c.zones){
      if(c.zones.status)out.push(text(c.zones.status));
      if(c.zones.lthr)out.push(text('LTHR для сохранённых зон: '+c.zones.lthr+' уд/мин'));
      if(c.zones.rows?.length){
        const grid=el('div',null,'zones');
        for(const [name,min,max] of c.zones.rows)grid.append(append(el('div'),text(name),el('div',min+'–'+max)));
        out.push(grid);
      }
      if(c.zones.source)out.push(text(c.zones.source));
    }else out.push(text('Зоны пока не внесены.'));
    if(data.lthr)out.push(text('Записанный LTHR не меняет сохранённые зоны.'));
    return out;
  }
  function editJournal(c,entry) {
    modal(entry?'Изменить запись':'Запись в журнале',form=>{
      const day=input('date',entry?.day||C.localDate());
      const title=input('text',entry?.title||'');
      const note=el('textarea');
      const status=select([['','Без статуса'],...Object.entries(C.JOURNAL_STATUSES)],entry?.journalStatus||'');
      title.maxLength=140;note.maxLength=4000;note.rows=4;note.value=entry?.text||'';
      append(form,field('Дата',day),field('Тема',title),field('Статус',status),field('Запись',note));
      return ()=>commit(s=>C.saveJournalEntry(s,c.id,{title:title.value,text:note.value,day:day.value,journalStatus:status.value},entry?.id));
    });
  }
  function addJournalTask(c,entry) {
    modal('Задача по записи',form=>{
      const action=input('text'),due=input('date');
      const reply=input('checkbox');
      action.maxLength=1000;
      append(form,field('Что сделать',action),field('Срок',due),
        append(el('label',null,'checkbox'),reply,el('span','Нужен ответ клиента')));
      return async()=>{
        const task=await commit(s=>C.createTask(s,c.id,action.value,{due:due.value,needsReply:reply.checked,sourceRecordId:entry.id}));
        focusCard('task',task.id);
      };
    });
  }
  function journal(c) {
    const entries=Object.values(state().records).filter(r=>r.clientId===c.id&&r.kind==='journal')
      .sort((a,b)=>b.day.localeCompare(a.day)||b.createdAt.localeCompare(a.createdAt));
    const tasks=Object.values(state().tasks).filter(t=>t.clientId===c.id&&t.sourceRecordId);
    const items=entries.map(entry=>{
      const status=C.JOURNAL_STATUSES[entry.journalStatus];
      const linked=tasks.filter(t=>t.sourceRecordId===entry.id).map(t=>t.phase==='done'
        ? text('Выполнено · '+t.title)
        : button(t.title,()=>focusCard('task',t.id),'subtle journal-task'));
      return append(el('article',null,'journal-entry stack'),row(text(formatDate(entry.day)+' '+entry.day.slice(0,4)),status&&el('span',status,'chip')),
        el('h3',entry.title),el('div',entry.text,'feature-copy'),
        linked.length&&append(el('div',null,'stack'),text('Задачи'),...linked),
        row(button('Изменить',()=>editJournal(c,entry),'subtle'),button('+ Задача',()=>addJournalTask(c,entry),'subtle')));
    });
    return section('Журнал',c.id+'-journal',[button('+ Запись',()=>editJournal(c),'subtle'),
      ...(items.length?items:[text('Записей пока нет')])]);
  }
  async function openTelegram(c) {
    const binding=c.telegram;
    const href=telegramLink(binding);
    if(!telegramPeer(binding?.peerId))throw Error('Сначала привяжи переписку');
    const result=await window.TrailNative?.openTelegram?.(binding);
    if(result?.opened){
      await commit(s=>C.noteTelegramOpen(s,c.id,binding.peerId),false);
      render();
    }else if(href){
      window.open(href,'_blank','noopener');
    }else throw Error('Для открытия переписки по ID установи новый Android APK.');
  }
  function telegramOptions(c) {
    const saved=c.telegramCheck;
    return [
      button('Открыть переписку',()=>openTelegram(c),'primary'),
      c.telegramOpenedAt&&text('Открывал из приложения · '+formatDate(c.telegramOpenedAt,true)),
      button(saved?'Проверять через '+saved.days+' дн.':'Напоминать о переписке',()=>modal('Напоминание о Telegram',form=>{
        const active=input('checkbox');active.checked=!!saved;
        const days=input('number',saved?.days||30);days.min=1;days.max=365;
        append(form,append(el('label',null,'checkbox'),active,el('span','Показывать в ToDo')),field('Дней без открытия из приложения',days));
        return ()=>commit(s=>C.setTelegramCheck(s,c.id,active.checked?Number(days.value):null));
      }),'subtle')
    ];
  }
  function editGoal(goal) {
    modal('Редактировать цель',form=>{
      const title=input('text',goal.title),status=select(C.GOAL_STATUSES,goal.status);
      title.maxLength=500;
      const type=select([['','Без типа'],...Object.entries(GOAL_TYPES)],goalType(goal.type)||'');
      const stage=select(Object.entries(RACE_STAGES),goal.raceStage||'choosing');
      const race=select([['','Не выбран'],...raceCatalog(state(),{includeRecommended:true}).map(r=>[r.id,r.name+' · '+r.date])],raceById(state(),goal.raceId)?.id||'');
      const distance=input('text',goal.distance||'','Например, 10 км');distance.maxLength=45;
      const name=input('text','','Название старта'),date=input('date'),place=input('text');name.maxLength=120;place.maxLength=160;
      const newRace=section('Добавить новый старт',goal.id+'-new-race',[field('Название',name),field('Дата старта',date),field('Место',place)]);
      const raceFields=append(el('div',null,'stack'),field('Этап',stage),field('Старт',race),field('Дистанция',distance),newRace);
      function refresh(){raceFields.hidden=type.value!=='race';}
      type.addEventListener('change',refresh);refresh();
      append(form,field('Цель',title),field('Статус',status),field('Тип',type),raceFields);
      return ()=>commit(s=>{
        const raceId=type.value==='race'&&(name.value.trim()||date.value)?C.defineRace(s,{name:name.value,date:date.value,place:place.value}).id:race.value;
        C.editGoal(s,goal.id,title.value,status.value,{type:type.value,raceStage:stage.value,raceId,distance:distance.value});
      });
    });
  }
  function goalRow(g) {
    const race=g.raceId&&raceById(state(),g.raceId);
    const wrap=append(el('div',null,'goal'),el('div',g.title),row(...[GOAL_TYPES[goalType(g.type)],g.status,RACE_STAGES[g.raceStage]].filter(Boolean).map(label=>el('span',label,'chip'))));
    wrap.id='goal-'+g.id;wrap.tabIndex=-1;
    if(race||g.distance||g.sourceEventDate)wrap.append(text([race?.name,g.sourceEventDate||race?.date,g.distance,g.source==='TrainingPeaks'?'TrainingPeaks':null].filter(Boolean).join(' · ')));
    const controls=el('div',null,'goal-controls');
    if(g.deletedAt)controls.append(button('Восстановить',()=>commit(s=>C.deleteGoal(s,g.id,false))));
    else controls.append(button('Изменить',()=>editGoal(g),'subtle'),button('Удалить',async()=>{
      await commit(s=>C.deleteGoal(s,g.id,true));message('Цель перенесена в удалённые. Её можно восстановить.');
    },'subtle danger'));
    wrap.append(controls);return wrap;
  }
  function goals(c, addGoal) {
    const all=Object.values(state().goals).filter(g=>g.clientId===c.id);
    const current=all.filter(g=>!g.deletedAt),removed=all.filter(g=>g.deletedAt);
    const results=el('div',null,'stack'),filter=el('div',null,'row catalog-quick');
    const keys=[['','Все'],...Object.entries(GOAL_TYPES).filter(([key])=>key==='race'||current.some(g=>goalType(g.type)===key))];
    let choice=ui.goalFilters?.[c.id]||'';
    if(!keys.some(([key])=>key===choice))choice='';
    function update(){
      for(const control of filter.children)control.setAttribute('aria-pressed',String(control.dataset.filter===choice));
      const selected=current.filter(g=>!choice||goalType(g.type)===choice);
      results.replaceChildren(...(selected.length?selected.map(goalRow):[text('Целей пока нет')]));
    }
    for(const [key,label] of keys){
      const control=button(label,()=>{choice=key;(ui.goalFilters??={})[c.id]=key;update();});
      control.dataset.filter=key;filter.append(control);
    }
    update();
    return section('Цели клиента · '+current.length,c.id+'-goals',[
      row(button('Добавить цель',addGoal,'subtle'),current.length&&filter),results,
      removed.length&&section('Удалённые цели · '+removed.length,c.id+'-deleted-goals',removed.map(goalRow))
    ]);
  }
  function races() {
    const page=el('div',null,'race-page stack'),current=state();
    const catalog=raceCatalog(current,{includeRecommended:true}).map(race=>{
      const shortName=race.shortName || (/mitja marat[oó].*barcelona|barcelona.*half marathon/i.test(race.name)
        ? 'Барселона · полумарафон' : race.name);
      return {
        race,shortName,...raceCategory(race),people:raceParticipants(current,race),
        search:[race.name,race.place,shortName].map(C.normalizeSearch).join(' ')
      };
    });
    const years=[...new Set(['2026','2027',...catalog.map(({race})=>race.date.slice(0,4))])].sort().reverse();
    const yearMenu=el('details',null,'race-year');
    const yearLabel=el('summary');
    const yearOptions=el('div',null,'race-year-options');
    let year=ui.raceYear??'2027';
    for(const [value,label] of [...years.map(value=>[value,value]),['','Все сезоны']]){
      const option=button(label,()=>{
        year=value;ui.raceYear=value;yearMenu.open=false;yearLabel.focus();refresh();
      });
      option.dataset.year=value;yearOptions.append(option);
    }
    yearMenu.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&yearMenu.open){yearMenu.open=false;yearLabel.focus();}
    });
    append(yearMenu,yearLabel,yearOptions);
    const query=input('search',ui.raceQuery||'','Поиск старта');
    const quick=el('div',null,'row catalog-quick race-quick');
    quick.setAttribute('role','group');quick.setAttribute('aria-label','Фильтры стартов');
    const secondary=el('div',null,'row catalog-quick');
    const controls=[];
    for(const [container,key,value,label] of [
      [quick,'raceRegion','serbia','Сербия'],
      [quick,'raceDiscipline','Трейл','Трейл'],
      [quick,'raceDiscipline','Шоссе','Шоссе'],
      [quick,'raceRegion','abroad','Не Сербия'],
      [secondary,'raceTeam',true,'Мы бежим']
    ]){
      const control=button(label,()=>{ui[key]=ui[key]===value?null:value;refresh();});
      controls.push([control,key,value]);container.append(control);
    }
    const list=el('div',null,'race-months');
    const view=button('Подробнее',()=>{
      ui.raceDetailed=!ui.raceDetailed;
      setView();
    },'race-view-toggle');
    list.id='race-calendar';
    view.setAttribute('aria-controls',list.id);
    function setView(){
      view.setAttribute('aria-pressed',String(!!ui.raceDetailed));
      list.classList.toggle('race-view-compact',!ui.raceDetailed);
    }
    const monthFormat=new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'});
    const dateLabel=race=>{
      if(race.date.length===7)return 'Дата уточняется';
      if(!race.endDate||race.date===race.endDate)return formatDate(race.date);
      return race.date.slice(0,7)===race.endDate.slice(0,7)
        ? race.date.slice(-2).replace(/^0/,'')+'–'+formatDate(race.endDate)
        : formatDate(race.date)+' – '+formatDate(race.endDate);
    };
    function compactDate(race){
      if(race.date.length===7)return '—';
      const first=Number(race.date.slice(-2));
      if(!race.endDate||race.date===race.endDate)return String(first);
      const last=Number(race.endDate.slice(-2));
      return race.date.slice(0,7)===race.endDate.slice(0,7)
        ? first+'–'+last : first+'/'+Number(race.date.slice(5,7))+'–'+last+'/'+Number(race.endDate.slice(5,7));
    }
    function card({race,shortName,region,discipline,significant,people}){
      const details=section('',race.id,[]);
      details.classList.add('race-card');
      details.dataset.category=region==='serbia'?'serbia':significant?'significant':region==='abroad'?'abroad':'';
      if(race.featured)details.classList.add('race-featured');
      const summary=details.querySelector('summary'),body=details.querySelector('.fold-body');
      const meta=[dateLabel(race),race.place].filter(Boolean).join(' · ');
      function overview(className){
        const tags=el('span',null,'row race-tags');
        if(discipline)tags.append(el('span',discipline,'chip'));
        if(significant)tags.append(el('span','Знаковый','chip race-significant'));
        if(people.length)tags.append(el('span','Участники · '+people.length,'chip emphasis'));
        return append(el('span',null,'race-overview '+className),
          el('span',race.name,'race-name'),el('span',meta,'race-meta'),tags.childElementCount&&tags);
      }
      const day=el('span',compactDate(race),'race-compact-date');
      day.setAttribute('aria-hidden','true');
      const short=el('span',shortName,'race-name race-short-name');
      short.title=race.name;
      append(summary,append(el('span',null,'race-compact-summary'),day,short,el('span',dateLabel(race),'visually-hidden')),
        overview('race-detail-summary'));
      body.append(overview('race-compact-overview'));
      if(race.distances?.length){
        body.append(append(el('div',null,'race-detail'),el('h3',race.distanceYear?'Дистанции '+race.distanceYear:'Дистанции'),
          append(el('div',null,'row race-distances'),...race.distances.map(distance=>el('span',distance,'chip')))));
      }
      const entrants=append(el('div',null,'race-detail'),el('h3','Участники'));
      for(const goal of people){
        const label=goal.raceStage==='registered'?'Есть регистрация':'Планирует';
        const person=button('',()=>openClient(goal.clientId,'goal',goal.id),'race-person');
        append(person,el('span',current.clients[goal.clientId].name),text([goal.distance,label].filter(Boolean).join(' · ')));
        entrants.append(person);
      }
      if(!people.length)entrants.append(text('Пока без участников'));
      body.append(entrants);
      if(race.url&&/^https?:\/\//i.test(race.url)){
        const source=link('Источник · сайт старта ↗',race.url,'inline-link race-source');
        source.target='_blank';source.rel='noopener noreferrer';body.append(source);
      }
      if(race.note)body.append(text(race.note,'race-note'));
      return details;
    }
    function refresh(){
      ui.raceQuery=query.value;
      yearLabel.textContent=year||'Все сезоны';
      yearLabel.setAttribute('aria-label','Сезон · '+yearLabel.textContent);
      for(const option of yearOptions.children)option.setAttribute('aria-pressed',String(option.dataset.year===year));
      for(const [control,key,value] of controls)control.setAttribute('aria-pressed',String(ui[key]===value));
      const keywords=query.value.split(/\s+/).map(C.normalizeSearch).filter(Boolean),months=new Map();
      for(const entry of catalog){
        const {race,people,search}=entry;
        if((year&&!race.date.startsWith(year))||!keywords.every(keyword=>search.includes(keyword))
          ||(ui.raceTeam&&!people.length)||(ui.raceRegion&&entry.region!==ui.raceRegion)
          ||(ui.raceDiscipline&&entry.discipline!==ui.raceDiscipline))continue;
        const key=race.date.slice(0,7);
        if(!months.has(key))months.set(key,[]);
        months.get(key).push(card(entry));
      }
      list.replaceChildren(...[...months].map(([month,rows])=>{
        const label=monthFormat.format(new Date(month+'-01T12:00:00Z')).replace(/ г\.$/,'');
        return append(el('section',null,'race-month'),el('h2',label,'race-month-title'),...rows);
      }));
      if(!months.size)list.append(text('Стартов не найдено'));
    }
    query.addEventListener('input',refresh);
    const create=button('Добавить старт',()=>modal('Новый старт',form=>{
      const name=input('text'),date=input('date'),place=input('text');name.maxLength=120;place.maxLength=160;
      const region=select([['','Не указано'],['serbia','Сербия'],['abroad','За рубежом']],'');
      const discipline=select([['','Не указано'],'Трейл','Шоссе'],'');
      append(form,field('Название',name),field('Дата',date),field('Место',place),field('Страна',region),field('Тип',discipline));
      return ()=>commit(s=>C.defineRace(s,{name:name.value,date:date.value,place:place.value,region:region.value,discipline:discipline.value}));
    }),'subtle');
    query.setAttribute('aria-label','Поиск старта');
    append(page,append(el('div',null,'page-title'),el('h1','Старты'),create),query,
      append(el('div',null,'race-filter-box'),quick,append(el('div',null,'race-filter-head'),secondary,yearMenu)),view,list);
    setView();refresh();return page;
  }
  return {profile,profileEditor,training,journal,telegramOptions,goals,races};
}
