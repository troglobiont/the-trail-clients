import {athleteMetric,athleteZones,ATHLETE_METRICS,ATHLETE_STATUSES} from './athlete.js';

const number=value=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(value);
const fullDate=day=>day.split('-').reverse().join('.');
const duration=seconds=>Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
function metricValue(metric,value){
  const unit=ATHLETE_METRICS[metric]?.[1];
  return unit==='pace'?duration(value)+' /км':unit==='seconds'?duration(value):unit==='minutes'?Math.floor(value/60)+' ч '+value%60+' мин':number(value)+(unit?' '+unit:'');
}
export function createAthleteUI({state,ui,el,append,button,row,text,section,navigate,render}){
  const groupFor=e=>e.kind==='decision'?'decisions':e.kind==='test'?'tests':e.kind==='zones'?'zones':e.kind==='device'?'devices':e.kind==='observation'?'recovery':'applications';
  function openEntry(c,id){
    const entry=c.athlete.entries[id];if(!entry)return;
    ui.open.add(c.id+'-zones');ui.open.add(c.id+'-athlete-'+groupFor(entry));render();
    queueMicrotask(()=>document.getElementById('athlete-'+id)?.scrollIntoView({block:'center',behavior:'smooth'}));
  }
  function summary(c){
    if(!c.athlete)return null;
    const primary=state().goals[c.athlete.goalId],lthr=athleteMetric(c,'lthr'),lt1=athleteMetric(c,'lt1'),rest=athleteMetric(c,'restHr'),zones=athleteZones(c);
    const out=append(el('section',null,'panel athlete-summary stack'),el('h2','Спортсмен'));
    const goals=Object.values(state().goals).filter(g=>g.clientId===c.id&&!g.deletedAt),goal=primary&&!primary.deletedAt?primary:goals[0];
    if(goal)out.append(button(goal.title,()=>navigate('#client/'+c.id+'/goal/'+goal.id),'athlete-goal'));
    else out.append(text('Цель пока не сформулирована'));
    const other=goals.filter(g=>g.id!==goal?.id);
    if(other.length)out.append(button('Другие цели · '+other.length,()=>navigate('#client/'+c.id+'/goal/'+other[0].id),'subtle'));
    if(c.athlete.raceStatus)out.append(text(c.athlete.raceStatus));
    const metrics=el('div',null,'athlete-metrics');
    for(const [entry,label] of [[lthr,'LTHR / ПАНО'],[lt1,'LT1 / АэП']])if(entry)metrics.append(append(button('',()=>openEntry(c,entry.id),'athlete-metric'),
      text(label),el('strong',number(entry.value)),text((entry.status==='historical'?'Лаборатория':['working','retained'].includes(entry.status)?'Рабочий':ATHLETE_STATUSES[entry.status])+' · '+fullDate(entry.day))));
    out.append(metrics);
    if(zones){
      const scale=el('div',null,'athlete-zone-scale');scale.setAttribute('aria-label','Пульсовые зоны бега, удары в минуту');
      for(const [name,min,max] of zones.rows)scale.append(append(el('div',null,'athlete-zone'),el('strong',name),
        el('span',name==='Z0'?'≤'+max:name==='Z5'?'≥'+min:min+'–'+max)));
      out.append(scale);
    }
    if(rest?.status==='temporary')out.append(text('Пульс покоя '+number(rest.value)+' · временный ориентир','small warning-text'));
    out.append(text(c.athlete.restrictions.status==='unknown'?'Самочувствие и ограничения: не уточнены':c.athlete.restrictions.text));
    out.append(button('Показатели и основания',()=>{ui.open.add(c.id+'-zones');render();queueMicrotask(()=>document.getElementById('athlete-details-'+c.id)?.scrollIntoView({block:'start'}));},'subtle'));
    return out;
  }
  function entryCard(c,entry){
    const source=c.athlete.sources[entry.sourceId];
    const card=append(el('article',null,'athlete-entry stack'),row(el('strong',entry.title),el('span',ATHLETE_STATUSES[entry.status],'chip')),
      text(fullDate(entry.day)));
    card.id='athlete-'+entry.id;
    if(entry.kind==='decision')card.append(append(el('div',null,'detail-line'),text(ATHLETE_METRICS[entry.metric][0]),el('strong',metricValue(entry.metric,entry.value))));
    for(const [metric,value] of Object.entries(entry.metrics||{}))card.append(append(el('div',null,'detail-line'),text(ATHLETE_METRICS[metric][0]),el('div',metricValue(metric,value))));
    if(entry.rows){
      const rows=el('div',null,'athlete-zone-table');
      for(const [name,min,max] of entry.rows)rows.append(append(el('div',null,'row between'),el('strong',name),el('span',min+'–'+max+' уд/мин')));
      card.append(rows);
    }
    if(entry.confidence)card.append(text('Уверенность: '+({unknown:'не оценена',low:'низкая',medium:'средняя',high:'высокая'}[entry.confidence])));
    for(const [key,label] of [['watch','Часы'],['sensor','Датчик'],['position','Расположение'],['basis','Подтверждение']])if(entry.equipment?.[key])
      card.append(append(el('div',null,'detail-line'),text(label),el('div',entry.equipment[key])));
    if(entry.note)card.append(text(entry.note));
    for(const detail of entry.details)card.append(text(detail));
    if(entry.workoutId)card.append(text('Тренировка TP · '+entry.workoutId));
    const refs=entry.references.map(id=>c.athlete.entries[id]);
    if(refs.length)card.append(append(el('div',null,'stack athlete-links'),text('Связанные записи'),...refs.map(ref=>button(ref.title,()=>openEntry(c,ref.id),'subtle'))));
    card.append(text('Источник: '+source.label+' · '+fullDate(source.day)));
    return card;
  }
  function details(c){
    const out=el('div',null,'stack');out.id='athlete-details-'+c.id;
    const entries=Object.values(c.athlete.entries).sort((a,b)=>b.day.localeCompare(a.day)||a.id.localeCompare(b.id));
    const sections=[['decisions','Рабочие значения и решения'],['tests','Тесты и результаты'],['zones','Зоны и основания границ'],
      ['devices','Устройства'],['recovery','Сон и восстановление'],['applications','Применение и срезы платформы']];
    for(const [group,title] of sections){
      const selected=entries.filter(e=>groupFor(e)===group);if(!selected.length)continue;
      const key=c.id+'-athlete-'+group,fold=section(title,key,[]);let built=false;
      const build=()=>{if(built)return;built=true;fold.querySelector('.fold-body').append(...selected.map(e=>entryCard(c,e)));};
      if(fold.open)build();fold.addEventListener('toggle',()=>{if(fold.open)build();});out.append(fold);
    }
    out.append(section('Источники',c.id+'-athlete-sources',Object.values(c.athlete.sources).map(source=>append(el('div',null,'stack'),
      el('strong',source.label),text(fullDate(source.day)),source.note&&text(source.note)))));
    out.append(text('Даты относятся к указанным тестам и сохранённым срезам. Открытие карточки не запрашивает TrainingPeaks или часы.'));
    return out;
  }
  return {summary,details,openEntry};
}
