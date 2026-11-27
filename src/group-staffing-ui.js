import {addDays,localDate} from './model-utils.js';
import {assignableGroupCoach,groupCancellations,groupStaffing,updateGroupStaffing} from './coach-accounting.js';
import {calendarGroupCoach,coachContact,groupCoach,previewCoaches} from './role-preview.js';
import {inlineSelect} from './inline-select.js';

export const GROUP_STAFFING_ROUTE='#todo/schedule/group-staffing';
const expectedEvent=({start,end,location,coachName})=>({start,end,location,coachName});

export function createGroupStaffingUI({state,context,el,append,text,button,row,field,modal,section,
  input,formatDate,timeRange,navigate,commit,message,loadWeek,writeCalendar,eventKey,initialWeek,onWeekChange,copiedWeeks,cancelTraining}){
  const today=localDate();
  const monday=addDays(today,-((new Date(today+'T12:00:00Z').getUTCDay()+6)%7));
  const viewer=context(),admin=viewer.role==='superadmin';
  const actor=coachContact(state(),viewer.coachId);
  if(!admin&&(viewer.role!=='coach'||!actor))return text('Расписание группы доступно тренерам.');
  const list=el('div',null,'staffing-list');
  const period=el('div',null,'row catalog-quick');
  period.setAttribute('role','group');period.setAttribute('aria-label','Неделя расписания');
  let request=0;
  const controls=[['Эта неделя',monday],['Следующая неделя',addDays(monday,7)]].map(([label,from])=>{
    const control=button(label,()=>refresh(from));period.append(control);return [from,control];
  });
  const page=append(el('section',null,'stack-lg'),row(button('← К расписанию',()=>navigate('#todo/schedule'),'subtle')),
    el('h1','Расписание групповых'),period,list);
  const name=id=>state().clients[id]?.name||'Тренер';

  function write(action){
    if(context().role!=='superadmin')throw Error('Расписание меняет суперадмин');
    return writeCalendar(action);
  }

  function cardState(event,live){
    const entry=groupStaffing(state(),event);
    const assigned=entry?.draftCoachId||entry?.coachId;
    const current=admin&&assigned?state().clients[assigned]:coachContact(state(),groupCoach(event,state()));
    const draft=!entry?.cancellation&&(Boolean(entry?.draftCoachId)||!entry?.coachId&&event.assignmentStatus==='draft');
    const editable=live&&event.canEdit&&Date.parse(event.start)>Date.now();
    const approved=!draft&&(entry?.coachId||event.assignmentStatus==='approved');
    const canApprove=editable&&!approved&&assignableGroupCoach(current);
    const scheduled=coachContact(state(),calendarGroupCoach(event,state()));
    const pending=editable&&current&&assigned&&
      (scheduled?.id!==current?.id||event.assignmentStatus!==(draft?'draft':'approved'));
    return {event,entry,current,draft,editable,canApprove,pending};
  }

  async function copyWeek(from){
    const previous=await loadWeek(addDays(from,-7));
    if(previous.mode!=='live')throw Error('Подключись к Google Календарю, чтобы скопировать неделю');
    const groups=previous.events.filter(event=>event.kind==='group');
    if(!groups.length){message('В предыдущей неделе нет групповых тренировок');return;}
    modal('Как на прошлой неделе',form=>{
      form.append(text(`Групповых встреч к переносу: ${groups.length}.`));
      return async()=>{
        const coaches=groups.flatMap(event=>{
          const entry=groupStaffing(state(),event);
          const responsible=entry?.draftCoachId||entry?.coachId;
          const coachName=responsible&&state().clients[responsible]?.name;
          return coachName?[{id:event.id,coachName,status:entry.draftCoachId?'draft':'approved'}]:[];
        });
        const result=await write({action:'copy-group-week',from,coaches});
        if(result.sourceCount&&!result.failed)copiedWeeks.add(from);
        await refresh(from);
        if(!result.sourceCount){message('В предыдущей неделе нет групповых тренировок');return;}
        const summary=[`Скопировано: ${result.created}`];
        if(result.skipped)summary.push(`Уже есть: ${result.skipped}`);
        if(result.failed)summary.push(`Не удалось скопировать: ${result.failed}. Можно повторить.`);
        message(summary.join(' · '),Boolean(result.failed));
      };
    },{saveLabel:'Скопировать неделю'});
  }

  function chooseCoach(form,initial,label){
    const choices=previewCoaches(state(),{includeHidden:admin}).flatMap(([key,label])=>{
      const coach=coachContact(state(),key);
      return assignableGroupCoach(coach)?[[coach.id,label]]:[];
    });
    const available=choices.some(([id])=>id===initial);
    return inlineSelect(form.ownerDocument,[['',choices.length?'Выбери тренера':'Доступных тренеров нет'],...choices],available?initial:'',label);
  }

  function assignInApp(draft,id,{event,entry},action,coachId,requesterId){
    const active=context();
    const coach=coachContact(draft,active.coachId);
    const role={...active,coachId:coach?.id};
    let revision=entry?.revision??0;
    if(action==='approve'&&!requesterId&&!entry?.draftCoachId)
      revision=updateGroupStaffing(draft,id,event,{action:'draft',coachId,revision},role).revision;
    return updateGroupStaffing(draft,id,event,{action,coachId,requesterId,revision},role);
  }

  function publishAssignment({event},coachId,status){
    return write({action:'assign-group',id:event.id,expected:expectedEvent(event),coachName:name(coachId),status});
  }

  async function approve(items,from){
    const proposals=await Promise.all(items.map(async item=>({...item,id:await eventKey(item.event)})));
    await commit(draft=>{
      for(const item of proposals)assignInApp(draft,item.id,item,'approve',item.coachId,item.requesterId);
    },false);
    let failed=0;
    for(let i=0;i<proposals.length;i+=4){
      const results=await Promise.allSettled(proposals.slice(i,i+4).map(item=>publishAssignment(item,item.coachId,'approved')));
      failed+=results.filter(result=>result.status==='rejected').length;
    }
    await refresh(from);
    const label=items.length===1?'Назначение утверждено':'Утверждено назначений: '+items.length;
    message(failed?label+' · Не обновилось в Google: '+failed:label,Boolean(failed));
  }

  function approveWeek(items,from){
    const proposals=items.filter(item=>item.canApprove).map(item=>({...item,coachId:item.current.id}));
    if(!proposals.length)return;
    modal('Утвердить неделю',form=>{
      form.append(text('Назначений к утверждению: '+proposals.length));
      return ()=>approve(proposals,from);
    },{saveLabel:'Утвердить'});
  }

  function editTraining(item,from){
    const {event,current}=item;
    const startDay=localDate(new Date(event.start)),startTime=timeRange(event).split('–')[0].trim();
    modal(event.location||'Групповая тренировка',form=>{
      const day=input('date',startDay),time=input('time',startTime),location=input('text',event.location);
      day.min=today;day.required=time.required=location.required=true;location.maxLength=180;
      const coach=chooseCoach(form,current?.id,'Предварительно назначить');
      form.append(row(field('Дата',day),field('Время Белграда',time)),field('Место',location),coach.field,
        button('Отменить тренировку',()=>cancelTraining(event,()=>void refresh(from)),'subtle danger'));
      return async()=>{
        if(!form.reportValidity())throw Error('Проверь дату, время и место');
        const changeCoach=coach.value&&coach.value!==current?.id;
        if(!changeCoach&&day.value===startDay&&time.value===startTime&&location.value.trim()===event.location)return;
        const result=await write({action:'edit-group',id:event.id,expected:expectedEvent(event),day:day.value,time:time.value,
          location:location.value.trim(),...(changeCoach&&{coachName:name(coach.value),status:'draft'})});
        if(changeCoach){
          const id=await eventKey(result.event);
          try{await commit(draft=>assignInApp(draft,id,item,'draft',coach.value),false);}
          catch(error){await refresh(from);throw Error('Google Календарь обновлён. '+error.message);}
        }
        await refresh(from);
        message(changeCoach?'Предварительное назначение сохранено':'Тренировка обновлена');
      };
    });
  }

  function card(item,from){
    const {event,entry,current,draft,editable,canApprove,pending}=item;
    const own=entry?.requests[actor?.id];
    const saveRequest=async(action,coachId,requesterId)=>{
      const id=await eventKey(event);
      await commit(s=>assignInApp(s,id,item,action,coachId,requesterId),false);
      await refresh(from);
      message(action==='request'?'Запрос отправлен суперадмину':'Запрос отклонён');
    };
    const pickRequest=()=>modal('Предложить замену',(form,enable)=>{
      const coach=chooseCoach(form,own?.coachId,'Ответственный тренер');
      enable(Boolean(coach.value));
      coach.element.addEventListener('change',()=>enable(Boolean(coach.value)));
      form.append(coach.field);
      return ()=>saveRequest('request',coach.value);
    },{saveLabel:'Отправить запрос'});
    const requests=Object.entries(entry?.requests||{});
    const actions=admin?row(
      editable&&button('Изменить',()=>editTraining(item,from),'subtle'),
      canApprove&&button('Утвердить',()=>approve([{...item,coachId:current.id}],from),'subtle staffing-approve'),
      pending&&button('Обновить',async()=>{
        await publishAssignment(item,current.id,draft?'draft':'approved');
        await refresh(from);
        message('Google Календарь обновлён');
      },'subtle')
    ):row(editable&&assignableGroupCoach(actor)&&current?.id!==actor.id&&own?.coachId!==actor.id&&
      button('Запросить себе',()=>saveRequest('request',actor.id),'subtle'),
      editable&&button(own?'Изменить запрос':'Предложить замену',pickRequest,'subtle'));
    actions.classList.add('staffing-actions');
    return append(el('article',null,'panel staffing-card'),append(el('div',null,'staffing-card-heading'),
      el('h2',event.location||'Групповая тренировка'),text(formatDate(localDate(new Date(event.start)))+' · '+timeRange(event))),
      append(el('div',null,'staffing-coach'),el('span','Ответственный · '+(current?.name||'Не назначен')),
        draft&&el('small',' (предварительно)')),
      own&&!admin&&text('Твой запрос · '+name(own.coachId)+' · На проверке'),
      actions.children.length&&actions,
      admin&&requests.length>0&&section('Запросы · '+requests.length,'staffing-requests-'+event.id,requests.map(([requester,proposal])=>
        append(el('div',null,'stack'),text(`${name(requester)} предлагает: ${name(proposal.coachId)}`),
          editable&&row(assignableGroupCoach(state().clients[proposal.coachId])&&button('Утвердить',()=>
            approve([{...item,coachId:proposal.coachId,requesterId:requester}],from),'subtle staffing-approve'),
          button('Отклонить',()=>saveRequest('decline',null,requester),'subtle'))))));
  }

  async function refresh(from){
    const version=++request;
    onWeekChange(from);
    for(const [date,control] of controls)control.setAttribute('aria-pressed',String(date===from));
    const lastDay=addDays(from,6);
    const range=text(formatDate(from)+' — '+formatDate(lastDay));
    list.replaceChildren(range,text('Загружаю групповые тренировки…'));
    try{
      const result=await loadWeek(from);
      if(version!==request||!page.isConnected)return;
      const live=result.mode==='live';
      const items=result.events.filter(event=>event.kind==='group').map(event=>cardState(event,live));
      const copied=copiedWeeks.has(from)||items.some(({event})=>event.copiedWeek===from);
      const copy=admin&&live&&from>today&&button('Как на прошлой неделе',()=>copyWeek(from),copied?'staffing-copy-done':'primary');
      if(copy&&copied)copy.title='Неделя уже скопирована';
      const confirm=admin&&items.some(item=>item.canApprove)&&button('Утвердить неделю',()=>approveWeek(items,from),'subtle staffing-approve');
      const cancelled=admin?groupCancellations(state(),from,lastDay):[];
      const toolbar=(copy||confirm)&&row(copy,confirm);
      list.replaceChildren(...[range,toolbar,!live&&text('Показано сохранённое расписание. Действия доступны при подключении.'),
        ...(items.length?items.map(item=>card(item,from)):[text('На эту неделю групповых тренировок нет.')]),
        cancelled.length>0&&section('Отменённые · '+cancelled.length,'staffing-cancelled-'+from,cancelled.map(entry=>
          append(el('div',null,'stack'),el('strong',entry.location),text(formatDate(entry.start,true)),
            entry.comment&&text(entry.comment))))].filter(Boolean));
    }catch(error){
      if(version===request&&page.isConnected)list.replaceChildren(range,text(error.message),row(button('Повторить',()=>refresh(from),'subtle')));
    }
  }
  void refresh(controls.some(([from])=>from===initialWeek)?initialWeek:addDays(monday,7));
  return page;
}
