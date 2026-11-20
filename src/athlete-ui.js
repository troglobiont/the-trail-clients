import {athleteMetric,athleteZones,ATHLETE_METRICS,ATHLETE_STATUSES} from './athlete.js';

const number=value=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(value);
const fullDate=day=>day.split('-').reverse().join('.');
const duration=seconds=>Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
const pulseNames={lt1:'LT1 / АэП',lthr:'LT2 / ПАНО',restHr:'RHR',maxHr:'Максимальный пульс'};
function metricValue(metric,value){
  const unit=ATHLETE_METRICS[metric]?.[1];
  return unit==='pace'?duration(value)+' /км':unit==='seconds'?duration(value):unit==='minutes'?Math.floor(value/60)+' ч '+value%60+' мин':number(value)+(unit?' '+unit:'');
}
const groupFor=e=>e.kind==='decision'?'decisions':e.kind==='test'?'tests':e.kind==='zones'?'zones':e.kind==='device'?'devices':e.kind==='observation'?'recovery':'applications';
const groups=[['decisions','Пульс'],['tests','Тесты'],['zones','Зоны'],['devices','Устройства'],['recovery','Сон и восстановление'],['applications','TrainingPeaks']];
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
export function createAthleteUI({state,ui,el,append,button,row,text,section,navigate,renderRestrictions}){
  let trail=[];
  const route=(c,id)=>'#client/'+c.id+'/training/'+id;
  function openEntry(c,id){
    if(!c.athlete?.entries[id])return;
    const current=location.hash.split('/');
    if(current[1]!==c.id||current[2]!=='training'||!current[3])trail=[];
    else if(trail.at(-1)!==current[3])trail=[current[3]];
    const existing=trail.indexOf(id);trail=existing<0?[...trail,id]:trail.slice(0,existing+1);
    navigate(route(c,id));
  }
  function back(c,entry){
    trail.pop();
    if(trail.length){navigate(route(c,trail.at(-1)));return;}
    ui.open.add(c.id+'-zones');ui.open.add(c.id+'-athlete-'+groupFor(entry));
    ui.athleteReturnEntry=entry.id;navigate('#client/'+c.id+'/training');
  }
  function summary(c){
    if(!c.athlete)return null;
    const primary=state().goals[c.athlete.goalId],lt1=athleteMetric(c,'lt1'),lt2=athleteMetric(c,'lthr'),rest=athleteMetric(c,'restHr'),zones=athleteZones(c);
    const out=el('div',null,'stack');
    const goals=Object.values(state().goals).filter(g=>g.clientId===c.id&&!g.deletedAt);
    if(primary)goals.sort((a,b)=>Number(b.id===primary.id)-Number(a.id===primary.id));
    const goalList=el('ul',null,'athlete-goals');goalList.setAttribute('aria-label','Цели спортсмена');
    for(const goal of goals){
      const link=button(goal.title,()=>navigate('#client/'+c.id+'/goal/'+goal.id),'athlete-goal');
      goalList.append(append(el('li'),link));
    }
    out.append(goals.length?append(el('div',null,'stack athlete-goal-list'),el('h3','Цели'),goalList):text('Цель пока не сформулирована'));
    const metrics=el('div',null,'athlete-metrics');
    for(const [entry,label] of [[rest,'RHR'],[lt1,'LT1 / АэП'],[lt2,'LT2 / ПАНО']]){
      const item=entry?button('',()=>openEntry(c,entry.id),'athlete-metric'):el('div',null,'athlete-metric');
      append(item,text(label),el('strong',entry?number(entry.value):'—'));
      metrics.append(item);
    }
    out.append(metrics);
    if(zones){
      const scale=button('',()=>openEntry(c,zones.id),'athlete-zone-scale');scale.setAttribute('aria-label','Открыть пульсовые зоны бега');
      for(const [name,min,max] of zones.rows)scale.append(append(el('span',null,'athlete-zone'),el('strong',name),
        el('span',name==='Z0'?'≤'+max:name==='Z5'?'≥'+min:min+'–'+max)));
      out.append(scale);
    }
    if(renderRestrictions)out.append(renderRestrictions(c));
    const key=c.id+'-athlete-summary';
    ui.athleteSummarySeen??=new Set();
    if(!ui.athleteSummarySeen.has(c.id)){ui.athleteSummarySeen.add(c.id);ui.open.add(key);}
    const fold=section('Спортсмен',key,[out]);fold.classList.add('panel','athlete-summary');return fold;
  }
  function entryRow(c,entry){
    const item=append(button('',()=>openEntry(c,entry.id),'account-line account-link athlete-row'),
      append(el('span',null,'account-label'),el('span',titleFor(entry)),el('small',fullDate(entry.day))),
      el('span',shortValue(entry),'account-value'));
    item.id='athlete-row-'+entry.id;return item;
  }
  function details(c){
    const out=el('div',null,'stack athlete-data');out.id='athlete-details-'+c.id;
    const entries=Object.values(c.athlete.entries).sort((a,b)=>b.day.localeCompare(a.day)||a.id.localeCompare(b.id));
    const current=new Set(Object.values(c.athlete.current));
    for(const [group,title] of groups){
      const selected=entries.filter(e=>groupFor(e)===group);if(!selected.length)continue;
      let rows=selected.map(e=>entryRow(c,e));
      if(group==='decisions'){
        const active=selected.filter(e=>current.has(e.id)).sort((a,b)=>['lt1','lthr','restHr','maxHr'].indexOf(a.metric)-['lt1','lthr','restHr','maxHr'].indexOf(b.metric));
        const old=selected.filter(e=>!current.has(e.id));
        rows=[...active.map(e=>entryRow(c,e)),old.length&&section('Ранее',c.id+'-athlete-previous',old.map(e=>entryRow(c,e)))].filter(Boolean);
      }
      out.append(section(title,c.id+'-athlete-'+group,rows));
    }
    return out;
  }
  function entry(c,id){
    const item=c?.athlete?.entries[id];
    if(!item)return append(el('div',null,'stack'),button('← Тренировочные данные',()=>navigate('#client/'+c.id+'/training'),'back subtle'),text('Запись не найдена'));
    const index=trail.indexOf(id);trail=index<0?[id]:trail.slice(0,index+1);
    const source=c.athlete.sources[item.sourceId];
    const page=append(el('div',null,'stack-lg athlete-entry-page'),
      button('← '+(trail.length>1?'Назад':groupName(item)),()=>back(c,item),'back subtle'),
      text(c.name),el('h1',titleFor(item)),text(fullDate(item.day)));
    if(item.kind==='decision'){
      page.append(el('strong',metricValue(item.metric,item.value),'athlete-detail-value'));
      const fromSleep=item.references.some(ref=>c.athlete.entries[ref]?.kind==='observation'&&c.athlete.entries[ref].metrics?.sleepMin!=null);
      if(fromSleep)page.append(text('Значение из минимума пульса во сне.'));
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
  return {summary,details,openEntry,entry};
}
