import {athleteMetric,athleteZones,ATHLETE_METRICS,ATHLETE_STATUSES} from './athlete.js';
import {localDate,validDate} from './model-utils.js';
import {latestGarminPulse} from './garmin-data.js';

const number=value=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(value);
const fullDate=day=>day.split('-').reverse().join('.');
const duration=seconds=>Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
const pulseNames={lt1:'LT1 / АэП',lthr:'LT2 / ПАНО',restHr:'RHR',maxHr:'Максимальный пульс'};
const summaryMetrics=[['restHr','RHR'],['lt1','LT1'],['lthr','LT2 / LTHR']];
const zoneRange=(name,min,max)=>name==='Z0'?'≤'+max:name==='Z5'?'≥'+min:min+'–'+max;
function metricValue(metric,value){
  const unit=ATHLETE_METRICS[metric]?.[1];
  return unit==='pace'?duration(value)+' /км':unit==='seconds'?duration(value):unit==='minutes'?Math.floor(value/60)+' ч '+value%60+' мин':number(value)+(unit?' '+unit:'');
}
const groupFor=e=>e.kind==='decision'?'decisions':e.kind==='test'?'tests':e.kind==='zones'?'zones':e.kind==='device'?'devices':e.kind==='observation'?'recovery':'applications';
const groups=[['decisions','Другие показатели'],['tests','Тесты и результаты'],['zones','Прежние зоны'],['devices','Устройства'],
  ['recovery','Восстановление'],['applications','TrainingPeaks и задания']];
const groupName=entry=>groups.find(([key])=>key===groupFor(entry))?.[1]||'Тренировочные данные';
function titleFor(entry){
  if(entry.kind==='decision')return pulseNames[entry.metric];
  if(entry.kind==='zones')return 'Зоны бега';
  if(entry.kind==='device')return 'Часы и датчик';
  if(entry.kind==='observation')return 'Сон';
  if(entry.kind==='snapshot')return entry.metrics?.maxHr!=null?'Профиль TrainingPeaks':'Порог в TrainingPeaks';
  return entry.title;
}
function shortValue(entry){
  if(entry.kind==='decision')return number(entry.value)+' уд/мин';
  if(entry.kind==='test'&&entry.metrics?.lthr!=null)return number(entry.metrics.lthr)+' уд/мин';
  if(entry.kind==='zones')return entry.rows.length+' зон';
  if(entry.kind==='device')return entry.equipment?.watch||'';
  if(entry.kind==='observation'&&entry.metrics?.sleepMinutes!=null)return metricValue('sleepMinutes',entry.metrics.sleepMinutes);
  if(entry.kind==='snapshot'&&entry.metrics?.lthr!=null)return number(entry.metrics.lthr)+' уд/мин';
  return '';
}
export function createAthleteUI({ui,el,append,button,text,section,navigate,renderRestrictions,logUI,garminData}){
  let trail=[],origin=null;
  const clientRoute=c=>'#client/'+c.id;
  const summaryRoute=c=>ui.role==='athlete'?'#progress':clientRoute(c);
  const route=(c,id)=>'#client/'+c.id+'/training/'+id;
  const fromSleep=(c,item)=>item.metric==='restHr'&&item.references.some(ref=>c.athlete.entries[ref]?.kind==='observation'
    &&c.athlete.entries[ref].metrics?.sleepMin!=null);
  function openEntry(c,id,source=null){
    if(!c.athlete?.entries[id])return;
    const current=location.hash.split('/');
    if(current[1]!==c.id||current[2]!=='training'||!current[3]){
      trail=[];origin=source;
    }else if(trail.at(-1)!==current[3])trail=[current[3]];
    const existing=trail.indexOf(id);trail=existing<0?[...trail,id]:trail.slice(0,existing+1);
    navigate(route(c,id));
  }
  function back(c,entry){
    trail.pop();
    if(trail.length){navigate(route(c,trail.at(-1)));return;}
    if(entry.kind==='observation'||origin==='recovery'){
      ui.open.add(c.id+'-athlete-recovery');
      navigate(clientRoute(c)+'/recovery');return;
    }
    if(origin==='summary'||Object.values(c.athlete.current).includes(entry.id)&&entry.metric!=='maxHr'){
      navigate(summaryRoute(c));return;
    }
    ui.open.add(c.id+'-zones');ui.open.add(c.id+'-athlete-'+groupFor(entry));
    ui.athleteReturnEntry=entry.id;navigate('#client/'+c.id+'/training');
  }
  function legacyValue(c,metric){
    const value=c.training?.[metric];
    return Number.isFinite(value)?value:null;
  }
  function storedZones(c){
    return athleteZones(c)||(!c.athlete?c.zones:null);
  }
  function summary(c,goals,trainingPlan){
    const out=el('div',null,'stack');
    if(trainingPlan)out.append(trainingPlan);
    const metrics=el('div',null,'athlete-metrics');
    const today=localDate(),measuredRest=c.sportLog?.recovery?.[today]?.restingHeartRate;
    const garminRest=latestGarminPulse(garminData(c),today);
    for(const [metric,label] of summaryMetrics){
      const entry=athleteMetric(c,metric);
      const sleepMinimum=metric==='restHr'&&entry?.status==='temporary'&&fromSleep(c,entry);
      const sensorRest=metric==='restHr'&&garminRest&&(garminRest.day===today||measuredRest==null);
      const currentRest=metric==='restHr'&&(measuredRest!=null||sensorRest);
      const fallback=c.athlete||metric==='lthr'&&c.training?.status==='candidate'?null:legacyValue(c,metric);
      const value=currentRest?(sensorRest?garminRest.value:measuredRest):sleepMinimum?null:entry?.value??fallback;
      const item=button('',()=>{
        if(currentRest)navigate(clientRoute(c)+'/recovery');
        else if(entry)openEntry(c,entry.id,'summary');
        else navigate(clientRoute(c)+'/metric/'+metric);
      },'athlete-metric');
      const day=currentRest?(sensorRest?garminRest.day:today):entry?.day||c.training?.date;
      const status=currentRest?(sensorRest?'Garmin':'Замер'):entry?.status==='historical'?'Тест':
        entry?.status==='working'||metric==='lthr'&&!entry&&c.training?.status==='working'?'Рабочий':'';
      const context=[validDate(day)&&fullDate(day),status].filter(Boolean).join(' · ');
      append(item,text(label),el('strong',value==null?'—':number(value)),value!=null&&context&&text(context));
      metrics.append(item);
    }
    out.append(metrics);
    const zones=storedZones(c);
    const showZones=()=>zones&&c.athlete?openEntry(c,zones.id,'summary'):navigate(clientRoute(c)+'/metric/zones');
    const zonePanel=append(button('',showZones,'athlete-zones-summary athlete-readout'),el('strong','Зоны ЧСС'));
    if(zones?.rows?.length)zonePanel.append(append(el('span',null,'athlete-zone-scale'),
      ...zones.rows.map(([name,min,max])=>append(el('span',null,'athlete-zone'),el('strong',name),el('span',zoneRange(name,min,max))))));
    out.append(zonePanel,...logUI.summary(c));
    if(renderRestrictions)out.append(renderRestrictions(c));
    if(goals)out.append(goals);
    const key=c.id+'-athlete-summary';
    ui.athleteSummarySeen??=new Set();
    if(!ui.athleteSummarySeen.has(c.id)){ui.athleteSummarySeen.add(c.id);ui.open.add(key);}
    const fold=section('Спортсмен',key,[out]);fold.classList.add('panel','athlete-summary');return fold;
  }
  function entryRow(c,entry,source){
    const item=append(button('',()=>openEntry(c,entry.id,source),'account-line account-link athlete-row'),
      append(el('span',null,'account-label'),el('span',titleFor(entry)),el('small',fullDate(entry.day))),
      el('span',shortValue(entry),'account-value'));
    item.id='athlete-row-'+entry.id;return item;
  }
  function details(c){
    const out=el('div',null,'stack athlete-data');out.id='athlete-details-'+c.id;
    const entries=Object.values(c.athlete.entries).sort((a,b)=>b.day.localeCompare(a.day)||a.id.localeCompare(b.id));
    const current=new Set(Object.values(c.athlete.current));
    for(const [group,title] of groups){
      if(group==='recovery')continue;
      const selected=entries.filter(e=>groupFor(e)===group&&(!current.has(e.id)||e.metric==='maxHr'));
      if(selected.length)out.append(section(title,c.id+'-athlete-'+group,selected.map(e=>entryRow(c,e))));
    }
    return out;
  }
  function logPage(c,kind){
    const observations=kind==='recovery'?Object.values(c.athlete?.entries||{})
      .filter(entry=>entry.kind==='observation').sort((a,b)=>b.day.localeCompare(a.day))
      .map(entry=>entryRow(c,entry,'recovery')):[];
    return logUI.page(c,kind,observations);
  }
  function metricPage(c,metric){
    const legacy=c.athlete?null:c.training;
    const value=legacy?legacyValue(c,metric):null;
    const title=metric==='zones'?'Зоны ЧСС':pulseNames[metric];
    const page=append(el('div',null,'stack-lg athlete-entry-page'),
      button('← К спортсмену',()=>navigate(clientRoute(c)),'back subtle'),text(c.name),el('h1',title));
    if(metric==='zones'){
      const zones=storedZones(c);
      if(zones?.rows?.length)page.append(append(el('div',null,'athlete-zone-table'),
        ...zones.rows.map(([name,min,max])=>append(el('div',null,'detail-line'),text(name),el('strong',zoneRange(name,min,max)+' уд/мин')))),
        ...[zones.lthr&&'LTHR для сохранённых зон · '+zones.lthr+' уд/мин',zones.status,zones.source].filter(Boolean).map(value=>text(value)));
      else page.append(text('Зоны пока не внесены'));
    }else{
      page.append(value==null?text(metric==='restHr'?'Отдельного замера пока нет':'Значение пока не внесено')
        :el('strong',metricValue(metric,value),'athlete-detail-value'));
      if(value!=null)for(const label of [validDate(legacy.date)&&fullDate(legacy.date),legacy.source,
        metric==='lthr'&&legacy.status==='candidate'&&'Оценка теста · требует проверки'].filter(Boolean))page.append(text(label));
    }
    return append(page,button('Тренировочные данные',()=>navigate(clientRoute(c)+'/training'),'subtle'));
  }
  function entry(c,id){
    const item=c?.athlete?.entries[id];
    if(!item)return append(el('div',null,'stack'),button('← Тренировочные данные',()=>navigate('#client/'+c.id+'/training'),'back subtle'),text('Запись не найдена'));
    const index=trail.indexOf(id);
    if(index<0){trail=[id];origin=null;}else trail=trail.slice(0,index+1);
    const source=c.athlete.sources[item.sourceId];
    const page=append(el('div',null,'stack-lg athlete-entry-page'),
      button('← '+(trail.length>1?'Назад':item.kind==='observation'?'Восстановление':
        origin==='summary'||Object.values(c.athlete.current).includes(item.id)&&item.metric!=='maxHr'?'К спортсмену':groupName(item)),()=>back(c,item),'back subtle'),
      text(c.name),el('h1',titleFor(item)),text(fullDate(item.day)));
    if(item.kind==='decision'){
      page.append(el('strong',metricValue(item.metric,item.value),'athlete-detail-value'));
      if(fromSleep(c,item))page.append(text('Минимальная ЧСС во сне. Отдельного замера пульса покоя нет.'));
      else if(item.status==='historical')page.append(text('По лабораторному тесту.'));
      else page.append(text('Рабочий показатель.'));
    }
    const metrics=el('div',null,'stack');
    const values=item.metrics||{};
    const line=(label,value)=>append(el('div',null,'detail-line'),text(label),el('strong',value));
    if(item.kind==='application'&&values.percentMin!=null&&values.percentMax!=null&&values.tempoMin!=null&&values.tempoMax!=null){
      metrics.append(line('Интенсивность',number(values.percentMin)+'–'+number(values.percentMax)+'% LTHR'),line('Пульс',number(values.tempoMin)+'–'+number(values.tempoMax)+' уд/мин'));
    }else for(const [metric,value] of Object.entries(values))metrics.append(line(pulseNames[metric]||ATHLETE_METRICS[metric][0],metricValue(metric,value)));
    if(metrics.children.length)page.append(metrics);
    if(item.rows){
      const rows=el('div',null,'athlete-zone-table');
      for(const [name,min,max] of item.rows)rows.append(line(name,(name==='Z0'?'≤'+max:name==='Z5'?'≥'+min:min+'–'+max)+' уд/мин'));
      page.append(rows);
    }
    for(const [key,label] of [['watch','Часы'],['sensor','Датчик'],['position','Расположение']])if(item.equipment?.[key])page.append(line(label,item.equipment[key]));
    const related=item.references.map(ref=>c.athlete.entries[ref]);
    if(related.length)page.append(append(el('section',null,'stack athlete-related'),el('h2','Посмотреть также'),...related.map(ref=>entryRow(c,ref))));
    const full=append(el('div',null,'stack'),el('strong',item.title),text(ATHLETE_STATUSES[item.status]),item.note&&text(item.note),
      ...item.details.map(detail=>text(detail)),item.equipment?.basis&&text(item.equipment.basis),
      item.confidence&&text('Уверенность: '+({unknown:'не оценена',low:'низкая',medium:'средняя',high:'высокая'}[item.confidence])),
      item.workoutId&&text('Тренировка TrainingPeaks · '+item.workoutId),el('strong','Источник'),text(source.label+' · '+fullDate(source.day)),source.note&&text(source.note));
    page.append(section('Подробности',c.id+'-athlete-evidence-'+item.id,[full]));
    return page;
  }
  return {summary,details,openEntry,entry,logPage,metricPage};
}
