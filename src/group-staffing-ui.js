import {addDays,localDate} from './model-utils.js';
import {groupStaffing,updateGroupStaffing} from './coach-accounting.js';
import {coachContact,groupCoach,previewCoaches} from './role-preview.js';

export const GROUP_STAFFING_ROUTE='#todo/schedule/group-staffing';

export function createGroupStaffingUI({state,context,el,append,text,button,row,field,select,modal,
  formatDate,timeRange,navigate,commit,message,loadWeek,eventKey,initialWeek,onWeekChange}){
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

  function card(event,editable){
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
    const pick=(action,initial)=>modal(action==='draft'?'Предварительно назначить тренера':'Предложить замену',form=>{
      const choices=previewCoaches(state(),{includeHidden:admin}).map(([key,label])=>[coachContact(state(),key)?.id,label])
        .filter(([id])=>id);
      const coach=select([['','Выбери тренера'],...choices],initial||'');
      form.append(field('Ответственный тренер',coach));
      return ()=>save(action,coach.value);
    },{saveLabel:action==='draft'?'Сохранить предварительно':'Отправить запрос'});
    const requests=admin?Object.entries(entry?.requests||{}).map(([requester,proposal])=>
      append(el('div',null,'stack'),text(`${name(requester)} предлагает: ${name(proposal.coachId)} · На проверке`),
        future&&row(button('Утвердить запрос',()=>save('approve',proposal.coachId,requester),'primary'),
          button('Отклонить',()=>save('decline',null,requester),'subtle')))):[];
    return append(el('article',null,'panel stack'),el('h2',event.location||'Групповая тренировка'),
      text(formatDate(localDate(new Date(event.start)))+' · '+timeRange(event)),
      el('strong','Ответственный · '+(current?.name||'Не назначен')),
      entry?.draftCoachId&&text('Предварительно · '+name(entry.draftCoachId)),
      own&&!admin&&text('Твой запрос · '+name(own.coachId)+' · На проверке'),
      future&&admin&&row(button(entry?.draftCoachId?'Изменить предварительное назначение':'Предварительно назначить',
        ()=>pick('draft',entry?.draftCoachId||current?.id),'subtle'),
        entry?.draftCoachId&&button('Утвердить назначение',()=>save('approve',entry.draftCoachId),'primary')),
      future&&!admin&&row(current?.id!==actor.id&&own?.coachId!==actor.id&&button('Запросить себе',()=>save('request',actor.id),'primary'),
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
      list.replaceChildren(range,...(result.mode==='live'?[]:[text('Показано сохранённое расписание. Действия доступны при подключении.')]),
        ...(groups.length?groups.map(event=>card(event,result.mode==='live')):[text('На эту неделю групповых тренировок нет.')]));
    }catch(error){
      if(version===request&&page.isConnected)list.replaceChildren(range,text(error.message),row(button('Повторить',()=>refresh(from),'subtle')));
    }
  }
  void refresh(controls.some(([from])=>from===initialWeek)?initialWeek:addDays(monday,7));
  return page;
}
