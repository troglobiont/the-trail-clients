import {addDays,localDate} from './model-utils.js';
import {assignableGroupCoach,groupStaffing,updateGroupStaffing} from './coach-accounting.js';
import {coachContact,groupCoach,previewCoaches} from './role-preview.js';
import {inlineSelect} from './inline-select.js';

export const GROUP_STAFFING_ROUTE='#todo/schedule/group-staffing';

export function createGroupStaffingUI({state,context,el,append,text,button,row,field,modal,
  input,formatDate,timeRange,navigate,commit,message,loadWeek,writeCalendar,eventKey,initialWeek,onWeekChange}){
  const today=localDate();
  const monday=addDays(today,-((new Date(today+'T12:00:00Z').getUTCDay()+6)%7));
  const viewer=context(),admin=viewer.role==='superadmin';
  const actor=coachContact(state(),viewer.coachId);
  if(!admin&&(viewer.role!=='coach'||!actor))return text('Расписание группы доступно тренерам.');
  const list=el('div',null,'stack');
  const period=el('div',null,'row catalog-quick');
  period.setAttribute('role','group');period.setAttribute('aria-label','Неделя расписания');
  let request=0;
  const controls=[['Эта неделя',monday],['Следующая неделя',addDays(monday,7)]].map(([label,from])=>{
    const control=button(label,()=>refresh(from));period.append(control);return [from,control];
  });
  const page=append(el('section',null,'stack-lg'),row(button('← К расписанию',()=>navigate('#todo/schedule'),'subtle')),
    el('h1','Расписание групповых'),period,list);
  const name=id=>state().clients[id]?.name||'Тренер';

  async function write(action,from){
    if(context().role!=='superadmin')throw Error('Расписание меняет суперадмин');
    const result=await writeCalendar(action);
    await refresh(from);
    return result;
  }

  async function copyWeek(from){
    const previous=await loadWeek(addDays(from,-7));
    if(previous.mode!=='live')throw Error('Подключись к Google Календарю, чтобы скопировать неделю');
    const groups=previous.events.filter(event=>event.kind==='group');
    if(!groups.length){message('В предыдущей неделе нет групповых тренировок');return;}
    modal('Как на прошлой неделе',form=>{
      form.append(text(`Групповых встреч к переносу: ${groups.length}. Можно изменить время и ответственных после копирования.`));
      return async()=>{
        const coaches=groups.flatMap(event=>{
          const approved=groupStaffing(state(),event)?.coachId;
          const coachName=approved&&state().clients[approved]?.name;
          return coachName?[{id:event.id,coachName}]:[];
        });
        const result=await write({action:'copy-group-week',from,coaches},from);
        if(!result.sourceCount){message('В предыдущей неделе нет групповых тренировок');return;}
        const summary=[`Скопировано: ${result.created}`];
        if(result.skipped)summary.push(`Уже обработано: ${result.skipped}`);
        if(result.failed)summary.push(`Не удалось скопировать: ${result.failed}. Можно повторить.`);
        message(summary.join(' · '),Boolean(result.failed));
      };
    },{saveLabel:'Скопировать неделю'});
  }

  function changeEvent(event,from,cancel){
    const day=localDate(new Date(event.start)),time=timeRange(event).split('–')[0];
    const expected={start:event.start,end:event.end,location:event.location};
    if(cancel){
      modal('Отменить групповую тренировку',form=>{
        form.append(text([formatDate(day),timeRange(event),event.location].join(' · ')),text('Встреча будет отменена в Google Календаре.'));
        return async()=>{
          await write({action:'cancel-group',id:event.id,expected},from);
          message('Тренировка отменена');
        };
      },{saveLabel:'Отменить тренировку',cancelLabel:'Назад',saveClass:'danger'});
      return;
    }
    modal('Перенести тренировку',form=>{
      const newDay=input('date',day),newTime=input('time',time);
      newDay.min=today;newDay.required=newTime.required=true;
      form.append(row(field('Дата',newDay),field('Время Белграда',newTime)));
      return async()=>{
        if(!form.reportValidity())throw Error('Укажи дату и время тренировки');
        await write({action:'move-group',id:event.id,expected,day:newDay.value,time:newTime.value},from);
        message('Тренировка перенесена');
      };
    },{saveLabel:'Перенести'});
  }

  function card(event,editable,from){
    const entry=groupStaffing(state(),event);
    const current=coachContact(state(),groupCoach(event,state()));
    const own=entry?.requests[actor?.id];
    const future=editable&&Date.parse(event.start)>Date.now();
    const save=async(action,coachId,requesterId)=>{
      const id=await eventKey(event);
      await commit(draft=>{
        const active=context();
        const coach=coachContact(draft,active.coachId);
        return updateGroupStaffing(draft,id,event,{action,coachId,requesterId,revision:entry?.revision??0},
          {...active,coachId:coach?.id});
      });
      message({draft:'Предварительное назначение сохранено',request:'Запрос отправлен суперадмину',
        approve:'Ответственный тренер утверждён',decline:'Запрос отклонён'}[action]);
    };
    const pick=(action,initial)=>modal(action==='draft'?'Предварительно назначить тренера':'Предложить замену',(form,enable)=>{
      const choices=previewCoaches(state(),{includeHidden:admin}).flatMap(([key,label])=>{
        const coach=coachContact(state(),key);
        return assignableGroupCoach(coach)?[[coach.id,label]]:[];
      });
      const coach=inlineSelect(form.ownerDocument,[['',choices.length?'Выбери тренера':'Доступных тренеров нет'],...choices],initial||'','Ответственный тренер');
      enable(Boolean(coach.value));
      coach.element.addEventListener('change',()=>enable(Boolean(coach.value)));
      form.append(coach.field);
      return ()=>save(action,coach.value);
    },{saveLabel:action==='draft'?'Сохранить предварительно':'Отправить запрос'});
    const requests=admin?Object.entries(entry?.requests||{}).map(([requester,proposal])=>
      append(el('div',null,'stack'),text(`${name(requester)} предлагает: ${name(proposal.coachId)} · На проверке`),
        future&&row(assignableGroupCoach(state().clients[proposal.coachId])&&button('Утвердить запрос',()=>save('approve',proposal.coachId,requester),'primary'),
          button('Отклонить',()=>save('decline',null,requester),'subtle')))):[];
    return append(el('article',null,'panel stack'),el('h2',event.location||'Групповая тренировка'),
      text(formatDate(localDate(new Date(event.start)))+' · '+timeRange(event)),
      el('strong','Ответственный · '+(current?.name||'Не назначен')),
      entry?.draftCoachId&&text('Предварительно · '+name(entry.draftCoachId)),
      own&&!admin&&text('Твой запрос · '+name(own.coachId)+' · На проверке'),
      future&&admin&&row(button(entry?.draftCoachId?'Изменить предварительное назначение':'Предварительно назначить',
        ()=>pick('draft',entry?.draftCoachId||current?.id),'subtle'),
        assignableGroupCoach(state().clients[entry?.draftCoachId])&&button('Утвердить назначение',()=>save('approve',entry.draftCoachId),'primary')),
      future&&admin&&event.canEdit&&row(button('Перенести',()=>changeEvent(event,from,false),'subtle'),
        button('Отменить',()=>changeEvent(event,from,true),'subtle')),
      future&&!admin&&row(assignableGroupCoach(actor)&&current?.id!==actor.id&&own?.coachId!==actor.id&&button('Запросить себе',()=>save('request',actor.id),'primary'),
        button(own?'Изменить запрос':'Предложить замену',()=>pick('request',own?.coachId),'subtle')),
      ...requests);
  }

  async function refresh(from){
    const version=++request;
    onWeekChange(from);
    for(const [date,control] of controls)control.setAttribute('aria-pressed',String(date===from));
    const range=text(formatDate(from)+' — '+formatDate(addDays(from,6)));
    list.replaceChildren(range,text('Загружаю групповые тренировки…'));
    try{
      const result=await loadWeek(from);
      if(version!==request||!page.isConnected)return;
      const groups=result.events.filter(event=>event.kind==='group');
      const live=result.mode==='live';
      list.replaceChildren(...[range,admin&&live&&from>today&&row(button('Как на прошлой неделе',()=>copyWeek(from),'primary')),
        !live&&text('Показано сохранённое расписание. Действия доступны при подключении.'),
        ...(groups.length?groups.map(event=>card(event,live,from)):[text('На эту неделю групповых тренировок нет.')])].filter(Boolean));
    }catch(error){
      if(version===request&&page.isConnected)list.replaceChildren(range,text(error.message),row(button('Повторить',()=>refresh(from),'subtle')));
    }
  }
  void refresh(controls.some(([from])=>from===initialWeek)?initialWeek:addDays(monday,7));
  return page;
}
