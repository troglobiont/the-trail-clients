import * as C from './core.js';
import { GOAL_TYPES, RACE_STAGES, raceCatalog, raceParticipants, telegramLink, telegramPeer } from './client-details.js';

export function createClientDetailsUI({state,ui,el,append,button,row,field,input,select,text,section,modal,commit,render,formatDate,openClient,message}) {
  const trainingFields = [
    ['height','Рост, см',30,300,.1],['weight','Вес, кг',10,500,.1],['maxHr','Максимальный пульс',30,250,1],
    ['restHr','Пульс в покое',20,160,1],['lthr','Рабочий LTHR',30,250,1]
  ];
  const trainingStatuses = [['','Не указан'],['candidate','Результат теста, проверить'],['working','Рабочий'],['confirmed','Подтверждён']];
  const profileFields = [
    ['phone','Основной местный телефон','tel','+381…'],['secondPhone','Дополнительный телефон','tel','+7…'],
    ['email','Email','email',''],['telegram','Telegram','text','@…'],['instagram','Instagram','text','@…'],
    ['city','Основной город','text',''],['profession','Профессия','text','']
  ];
  function link(label,href,className='inline-link') {
    const a=el('a',label,className);a.href=href;return a;
  }
  function editProfile(c) {
    modal('О клиенте',form=>{
      const entries=profileFields.map(([key,label,type,placeholder])=>[key,field(label,input(type,c.profile?.[key]||'',placeholder))]);
      for (const [,entry] of entries) form.append(entry);
      const stored=c.profile?.birthday||'';
      const day=input('number',stored.slice(-2)),month=input('number',stored.slice(-5,-3)),year=input('number',stored.length===10?stored.slice(0,4):'');
      day.min=1;day.max=31;month.min=1;month.max=12;year.min=1900;year.max=Number(C.localDate().slice(0,4));
      append(form,el('h3','День рождения'),row(field('День',day),field('Месяц',month),field('Год · необязательно',year)));
      return ()=>{
        const date=[year.value,month.value,day.value].filter(Boolean);
        if (date.length && (!day.value || !month.value || year.value && year.value.length!==4)) throw Error('Укажи день и месяц');
        const pad=v=>v.padStart(2,'0');
        const birthday=date.length ? (year.value?year.value+'-':'')+pad(month.value)+'-'+pad(day.value) : '';
        return commit(s=>C.saveProfile(s,c.id,{...Object.fromEntries(entries.map(([key,f])=>[key,f.querySelector('input').value])),birthday}));
      };
    });
  }
  function profile(c) {
    const data=c.profile||{};
    const items=profileFields.map(([key,label])=>{
      const value=key==='telegram'&&c.telegram?.username?'@'+c.telegram.username:data[key]||(key==='telegram'?c.telegramHint:null);
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
      const type=select([['','Без типа'],...Object.entries(GOAL_TYPES)],goal.type||'');
      const stage=select(Object.entries(RACE_STAGES),goal.raceStage||'choosing');
      const race=select([['','Не выбран'],...raceCatalog(state()).map(r=>[r.id,r.name+' · '+r.date])],goal.raceId||'');
      const distance=input('text',goal.distance||'','Например, 10 км');distance.maxLength=45;
      const name=input('text','','Название старта'),date=input('date');name.maxLength=120;
      const newRace=section('Добавить новый старт',goal.id+'-new-race',[field('Название',name),field('Дата старта',date)]);
      const raceFields=append(el('div',null,'stack'),field('Этап',stage),field('Старт',race),field('Дистанция',distance),newRace);
      function refresh(){raceFields.hidden=type.value!=='race';}
      type.addEventListener('change',refresh);refresh();
      append(form,field('Цель',title),field('Статус',status),field('Тип',type),raceFields);
      return ()=>commit(s=>{
        const raceId=type.value==='race'&&(name.value.trim()||date.value)?C.defineRace(s,{name:name.value,date:date.value}).id:race.value;
        C.editGoal(s,goal.id,title.value,status.value,{type:type.value,raceStage:stage.value,raceId,distance:distance.value});
      });
    });
  }
  function goalRow(g) {
    const race=g.raceId&&raceCatalog(state()).find(r=>r.id===g.raceId);
    const wrap=append(el('div',null,'goal'),el('div',g.title),row(...[GOAL_TYPES[g.type],g.status,RACE_STAGES[g.raceStage]].filter(Boolean).map(label=>el('span',label,'chip'))));
    wrap.id='goal-'+g.id;wrap.tabIndex=-1;
    if(race||g.distance)wrap.append(text([race?.name,race?.date,g.distance].filter(Boolean).join(' · ')));
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
    const keys=[['','Все'],...Object.entries(GOAL_TYPES).filter(([key])=>key==='race'||current.some(g=>g.type===key))];
    let choice=ui.goalFilters?.[c.id]||'';
    if(!keys.some(([key])=>key===choice))choice='';
    function update(){
      for(const control of filter.children)control.setAttribute('aria-pressed',String(control.dataset.filter===choice));
      const selected=current.filter(g=>!choice||g.type===choice);
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
    const page=el('div',null,'stack-lg'),catalog=raceCatalog(state());
    const distancesFor=r=>[...new Set([...(r.distances||[]),...Object.values(state().goals).filter(g=>!g.deletedAt&&g.raceId===r.id&&g.distance).map(g=>g.distance)])];
    const allDistances=[...new Set(catalog.flatMap(distancesFor))].sort();
    const years=[...new Set(catalog.map(r=>r.date.slice(0,4)))].sort();
    const year=select([['','Все сезоны'],...years],ui.raceYear||''),distance=select([['','Все дистанции'],...allDistances],ui.raceDistance||'');
    const query=input('search',ui.raceQuery||'','Поиск старта');
    const list=el('div',null,'stack');
    const refresh=()=>{
      ui.raceYear=year.value;ui.raceDistance=distance.value;ui.raceQuery=query.value;
      const found=catalog.filter(r=>(!year.value||r.date.startsWith(year.value))&&C.normalizeSearch(r.name).includes(C.normalizeSearch(query.value))
        &&(!distance.value||distancesFor(r).includes(distance.value)));
      list.replaceChildren(...(found.length?found.map(r=>{
        const entries=raceParticipants(state(),r.id,distance.value);
        const registered=entries.filter(g=>g.raceStage==='registered').length;
        const distances=distancesFor(r);
        return section(r.name+' · '+formatDate(r.date)+' '+r.date.slice(0,4)+' · '+entries.length+' чел.',r.id,[
          text('Выбрали · '+(entries.length-registered)+' / Зарегистрированы · '+registered),
          distances.length&&text('Дистанции: '+distances.join(', ')),
          button('Настроить дистанции',()=>modal('Дистанции',form=>{
            const control=el('textarea');control.value=(r.distances||[]).join('\n');
            form.append(field('По одной дистанции на строку',control));
            return ()=>commit(s=>C.setRaceDistances(s,r.id,control.value.split('\n')));
          }),'subtle'),
          ...entries.map(g=>button(state().clients[g.clientId].name+' · '+[g.distance,RACE_STAGES[g.raceStage]].filter(Boolean).join(' · '),()=>openClient(g.clientId,'goal',g.id),'subtle')),
          !entries.length&&text('Пока никто не подтвердил участие. Добавь этот старт в цели клиента.')
        ]);
      }):[text('Стартов не найдено')]));
    };
    for(const control of [query,year,distance])control.addEventListener(control===query?'input':'change',refresh);
    const create=button('Добавить старт',()=>modal('Новый старт',form=>{
      const name=input('text'),date=input('date');name.maxLength=120;
      append(form,field('Название',name),field('Дата',date));
      return ()=>commit(s=>C.defineRace(s,{name:name.value,date:date.value}));
    }),'subtle');
    query.setAttribute('aria-label','Поиск старта');
    append(page,append(el('div',null,'page-title'),el('h1','Старты'),create),query,row(field('Сезон',year),field('Дистанция',distance)),list);
    refresh();return page;
  }
  return {profile,training,telegramOptions,goals,races};
}
