import {localDate,validDate} from './model-utils.js';
import {dayLoad,hasDeviceReading,powerTss,recoveryIndex,RECOVERY_FIELDS,saveSportDay,sessionLoad,trainingLoad,TRAINING_TYPES} from './sport-log.js';

const formatNumber=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
export const summaryNumber=value=>value==null?'—':formatNumber.format(value);
const balance=value=>value>0?'+'+summaryNumber(value):summaryNumber(value);
const titles={load:'Нагрузка',recovery:'Восстановление'};
const loadMetrics=[['Недавняя','ATL','atl'],['Долгая','CTL','ctl'],['Баланс','TSB','tsb']];
const sportNames=Object.fromEntries(TRAINING_TYPES);
const sleepDuration=value=>Math.floor(value/60)+' ч '+value%60+' мин';
const dailyRoute=(c,kind)=>'#client/'+c.id+'/'+kind;

export function createSportLogUI({el,append,button,row,text,section,modal,commit,input,select,field,navigate,formatDate}){
  const line=(label,value)=>append(el('div',null,'detail-line'),text(label),el('strong',value));
  const sep=(label,value)=>append(el('span',null,'athlete-load-metric'),el('span',label,'muted small'),el('strong',value));
  function loadValues(log){
    return append(el('span',null,'athlete-load-values'),
      ...loadMetrics.map(([label,code,key])=>sep(label+' · '+code,key==='tsb'?balance(log[key]):summaryNumber(log[key]))));
  }
  function summary(c){
    const load=trainingLoad(c.sportLog?.load);
    const recovery=recoveryIndex(c.sportLog?.recovery);
    const loadPanel=append(button('',()=>navigate(dailyRoute(c,'load')),'athlete-readout athlete-load-summary'),
      el('strong',titles.load),loadValues(load));
    const recoveryPanel=append(button('',()=>navigate(dailyRoute(c,'recovery')),'athlete-readout athlete-recovery-summary'),
      el('strong',titles.recovery),el('span',recovery.value==null?'—':recovery.value+'/100','athlete-recovery-value'));
    return [loadPanel,recoveryPanel];
  }

  function numeric(value,min,max,step){
    const control=input('number',value??'');
    control.min=min;control.max=max;control.step=step;
    return control;
  }
  function sessionFields(saved){
    const type=select(TRAINING_TYPES,saved?.type||'run');
    const minutes=numeric(saved?.minutes,1,1440,1),rpe=numeric(saved?.rpe,0,10,.5);
    const power=numeric(saved?.power?.normalized,1,3000,.1),threshold=numeric(saved?.power?.threshold,1,3000,.1);
    const powerFields=append(el('div',null,'athlete-log-fields'),field('NP, Вт',power),field('FTP, Вт',threshold));
    powerFields.hidden=type.value!=='bike';
    type.addEventListener('change',()=>{powerFields.hidden=type.value!=='bike';});
    const fields=append(el('div',null,'athlete-log-fields'),field('Длительность, мин',minutes),field('Усилие RPE, 0–10',rpe));
    const element=append(el('div',null,'stack athlete-session-form'),field('Тренировка',type),fields,powerFields);
    return {element,read(){
      const powerUsed=type.value==='bike'&&(power.value||threshold.value);
      const required=[minutes,rpe,...(powerUsed?[power,threshold]:[])];
      if(required.some(control=>!control.value||!control.checkValidity()))throw Error('Проверь длительность, усилие и мощность');
      return {type:type.value,minutes:minutes.valueAsNumber,rpe:rpe.valueAsNumber,
        ...(powerUsed&&{power:{normalized:power.valueAsNumber,threshold:threshold.valueAsNumber}})};
    }};
  }
  function loadFields(saved){
    const mode=select([['training','Тренировка проведена'],['rest','День без тренировки']],saved&&!saved.sessions.length?'rest':'training');
    const list=el('div',null,'stack'),sessions=[];
    const addSession=savedSession=>{
      const fields=sessionFields(savedSession);
      const remove=button('Убрать тренировку',()=>{
        sessions.splice(sessions.indexOf(fields),1);
        fields.element.remove();
        if(!sessions.length)addSession();
      },'subtle');
      fields.element.append(remove);sessions.push(fields);list.append(fields.element);
    };
    for(const session of saved?.sessions.length?saved.sessions:[null])addSession(session);
    const complete=append(el('div',null,'stack'),list,button('+ Тренировка',()=>addSession(),'subtle'));
    complete.hidden=mode.value==='rest';
    mode.addEventListener('change',()=>{complete.hidden=mode.value==='rest';});
    return {element:append(el('div',null,'stack'),field('Как прошёл день',mode),complete),
      read:()=>({sessions:mode.value==='rest'?[]:sessions.map(session=>session.read())})};
  }
  function recoveryFields(saved){
    const source=input('text',saved?.source||'','Например, Garmin fēnix 8');source.maxLength=80;
    const controls=Object.entries(RECOVERY_FIELDS).map(([key,[label,min,max,step]])=>
      [key,label,numeric(saved?.[key],min,max,step)]);
    const fields=append(el('div',null,'athlete-log-fields'),...controls.map(([,label,control])=>field(label,control)));
    return {element:append(el('div',null,'stack'),field('Источник сна и пульса',source),fields),read(){
      if(controls.some(([,,control])=>!control.checkValidity()))throw Error('Проверь значения замеров');
      const record=Object.fromEntries(controls.filter(([,,control])=>control.value!=='').map(([key,,control])=>[key,control.valueAsNumber]));
      if(!Object.keys(record).length)throw Error('Укажи хотя бы одно наблюдение');
      if(hasDeviceReading(record)&&!source.value.trim())throw Error('Укажи источник сна, пульса или HRV');
      if(source.value.trim())record.source=source.value.trim();
      return record;
    }};
  }
  function editDay(c,kind,day=localDate()){
    modal(kind==='load'?'Нагрузка за день':'Наблюдение за день',form=>{
      const date=input('date',day);date.max=localDate();
      const holder=el('div',null,'stack');
      let draft,previous,deleted,loadedDay;
      function show(){
        loadedDay=date.value;
        previous=c.sportLog?.[kind]?.[date.value]??null;
        deleted=false;
        draft=kind==='load'?loadFields(previous):recoveryFields(previous);
        holder.replaceChildren(draft.element);
        if(previous)holder.append(button('Удалить запись за день',()=>{
          deleted=true;
          holder.replaceChildren(text('Запись будет удалена после сохранения'),
            button('Вернуть запись',show,'subtle'));
        },'subtle danger'));
      }
      date.addEventListener('change',show);
      show();
      append(form,field('Дата',date),holder);
      return ()=>{
        if(!validDate(date.value)||!date.checkValidity())throw Error('Проверь дату');
        if(date.value!==loadedDay)throw Error('Заново выбери дату записи');
        const value=deleted?null:draft.read();
        return commit(state=>saveSportDay(state.clients[c.id],kind,date.value,value,{previous}));
      };
    });
  }

  function loadPage(c){
    const log=c.sportLog?.load||{},load=trainingLoad(log);
    const history=Object.keys(log).sort().reverse().slice(0,14).map(day=>{
      const entry=log[day],total=entry.sessions.length?summaryNumber(dayLoad(entry))+' усл. ед.':'Отдых';
      const sessions=entry.sessions.map(session=>{
        const tss=powerTss(session);
        return text(sportNames[session.type]+' · '+session.minutes+' мин · RPE '+summaryNumber(session.rpe)+' · '+
          summaryNumber(sessionLoad(session))+' усл. ед.'+(tss===null?'':' · '+summaryNumber(tss)+' TSS по мощности'));
      });
      return section(formatDate(day)+' · '+total,c.id+'-load-'+day,[...sessions,button('Изменить',()=>editDay(c,'load',day),'subtle')]);
    });
    const about=section('Как считается нагрузка',c.id+'-load-method',[
      text('Session-RPE = длительность в минутах × субъективное усилие от 0 до 10. Оценки тренировок за день складываются.'),
      text('ATL и CTL используют вчерашнее значение + (нагрузка за день − вчерашнее значение) / 7 или / 42. Начальное значение — среднее за первые 7 или 42 дня. TSB на сегодня — вчерашний CTL минус вчерашний ATL.'),
      text('Отдых записывается как 0. Пропущенный день прерывает расчёт. Для велотренировки можно отдельно указать NP и FTP. TSS по мощности = 100 × часы × (NP / FTP)².')
    ]);
    return [
      append(el('div',null,'panel stack'),loadValues(load),text('Session-RPE · усл. ед.'),line('Сегодня',summaryNumber(load.today)),
        text(load.through?'Данные по '+formatDate(load.through)+' · '+load.streak+' дн. подряд':'Добавь выполненные тренировки и дни отдыха.')),
      button('+ Записать день',()=>editDay(c,'load'),'primary'),
      history.length&&section('История нагрузки',c.id+'-load-history',history),
      about
    ];
  }
  function recoveryRows(record,reference={}){
    return [
      record.source&&line('Источник',record.source),
      ...Object.entries(RECOVERY_FIELDS).filter(([key])=>record[key]!=null).map(([key,[label]])=>{
        const format=key==='sleepMinutes'?sleepDuration:summaryNumber;
        const base=reference[key];
        return line(label,format(record[key])+(base==null?'':' · обычно '+format(key==='sleepMinutes'?Math.round(base):base)));
      })
    ].filter(Boolean);
  }
  function recoveryPage(c,observations){
    const today=localDate(),log=c.sportLog?.recovery||{},recovery=recoveryIndex(log,today);
    const history=Object.keys(log).filter(day=>day!==today).sort().reverse().slice(0,14).map(day=>
      section(formatDate(day),c.id+'-recovery-'+day,[...recoveryRows(log[day]),button('Изменить',()=>editDay(c,'recovery',day),'subtle')]));
    return [
      append(el('div',null,'panel stack'),el('strong',recovery.value==null?'—':recovery.value+'/100','athlete-detail-value'),
        recovery.value===null?text('Для оценки нужны наблюдения за сегодня и личная история хотя бы по двум группам.'):text(recovery.groups+' из 3 групп · 50 — привычный уровень'),
        ...(log[today]?recoveryRows(log[today],recovery.reference):[])),
      button(log[today]?'Изменить наблюдение':'+ Добавить наблюдение',()=>editDay(c,'recovery'),'primary'),
      history.length&&section('История наблюдений',c.id+'-recovery-history',history),
      observations.length&&section('Сохранённые наблюдения',c.id+'-athlete-recovery',observations),
      section('Как считается восстановление',c.id+'-recovery-method',[
        text('Длительность сна — 35%, HRV и пульс — 35%, свежесть — 30%. Масса, качество сна и дискомфорт видны в наблюдении.'),
        text('Норма — медиана за предыдущие 28 дней. Для каждого показателя нужно как минимум 14 сопоставимых наблюдений. Данные разных устройств считаются отдельно.'),
        text('Индекс = 50 + 25 × взвешенное среднее отклонение от личной нормы. При отсутствии одной из трёх групп веса пересчитываются по двум доступным.')
      ])
    ];
  }
  function page(c,kind,observations=[]){
    return append(el('div',null,'stack-lg athlete-entry-page'),
      button('← К спортсмену',()=>navigate('#client/'+c.id),'back subtle'),
      text(c.name),el('h1',titles[kind]),...(kind==='load'?loadPage(c):recoveryPage(c,observations)));
  }
  return {summary,page};
}
