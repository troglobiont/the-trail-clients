import {localDate} from './model-utils.js';
import {sameTelegramDestination} from './telegram-delivery.js';

const errorMessage='Сервис Telegram недоступен. Проверь подключение Mac.';

export function cancellationText(event, date, time, comment) {
  const title=event.kind==='group'?'Групповая тренировка отменена':'Персональная тренировка отменена';
  const place=event.location?.trim().replace(/\s+/gu,' ').slice(0,180);
  return [title+'.', [date,time,place].filter(Boolean).join(' · '), comment.trim()].filter(Boolean).join('\n');
}

export async function notifyCancellation({service,state,event,recipients,body}) {
  const results=[];
  const peers=new Map();
  const status=await service('/telegram/status',{}).catch(()=>null);
  for(const {client,binding} of recipients){
    let error;
    if(!sameTelegramDestination(state().clients[client.id]?.telegram,binding))
      error='Привязка Telegram изменилась';
    else if(!status?.connected)error=errorMessage;
    else if(binding.accountPeerId&&binding.accountPeerId!==status.account?.peerId)
      error='Привязка относится к другому аккаунту Telegram';
    else {
      if(!peers.has(binding.peerId)){
        const identity=JSON.stringify([event.id,Date.parse(event.start),binding.peerId]);
        const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity)));
        const key='cancel-'+Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('');
        const result=await service('/telegram/send',{kind:'training-cancellation',peerId:binding.peerId,
          accountPeerId:status.account?.peerId||binding.accountPeerId||null,text:body,idempotencyKey:key}).catch(()=>null);
        peers.set(binding.peerId,result?.messageId&&Number.isFinite(Date.parse(result.sentAt))
          ?null:'Telegram не подтвердил отправку');
      }
      error=peers.get(binding.peerId);
    }
    results.push({client,binding,error});
  }
  return results;
}

export function createScheduleCancellation({state,service,roleContext,el,append,text,button,field,input,modal,
    formatDate,timeRange,message,recipientsFor}) {
  function report(results, unavailable, body, retry){
    const failed=results.filter(item=>item.error);
    const delivered=results.length-failed.length;
    modal('Тренировка отменена',form=>{
      form.append(text('Telegram подтвердил отправку: '+delivered+' из '+results.length+'.'));
      if(failed.length)form.append(text('Требуется проверка'),...failed.map(({client,error})=>text(client.name+' · '+error)));
      if(unavailable.length)form.append(text('Без привязки к Telegram'),...unavailable.map(client=>text(client.name)));
      if(failed.length||unavailable.length){
        const copy=el('textarea');copy.value=body;copy.readOnly=true;copy.rows=4;
        form.append(field('Текст уведомления',copy));
      }
      if(failed.length)form.append(button('Повторить неподтверждённые',async()=>{
        const retried=await retry(failed);
        results=[...results.filter(item=>!item.error),...retried];
        report(results,unavailable,body,retry);
      },'subtle'));
    },{saveLabel:null,cancelLabel:'Готово'});
  }

  return function cancelTraining(event,cancel,onCancelled){
    const group=event.kind==='group';
    const day=formatDate(localDate(new Date(event.start))),time=timeRange(event);
    const mayNotify=roleContext().role==='superadmin'&&Date.parse(event.start)>Date.now();
    const clients=mayNotify?recipientsFor(event):[];
    const available=clients.filter(client=>client.telegram?.peerId);
    const unavailable=clients.filter(client=>!client.telegram?.peerId);
    const connected=Boolean(state().settings.serviceURL);
    let results,body;
    const retry=recipients=>{
      if(roleContext().role!=='superadmin')throw Error('Уведомления об отмене отправляет суперадмин');
      return notifyCancellation({service,state,event,recipients,body});
    };

    modal(group?'Отменить групповую тренировку':'Отменить тренировку',form=>{
      const comment=el('textarea');comment.rows=2;comment.maxLength=300;
      const notify=input('checkbox');
      const label=group?'Уведомить участников в Telegram':clients.length?'Уведомить в Telegram · '+clients[0].name:'Уведомить в Telegram';
      notify.disabled=!available.length||!connected;
      const audience=el('div',null,'stack cancellation-audience');
      const statuses=el('details',null,'fold');
      const list=el('div',null,'fold-body cancellation-recipients');
      const count=el('summary');
      const choices=available.map(client=>{
        const check=input('checkbox');check.checked=true;
        if(group)list.append(append(el('label',null,'checkbox'),check,el('span',client.name)));
        return {check,client,binding:{...client.telegram}};
      });
      if(group)for(const client of unavailable)list.append(text(client.name+' · Нет привязки'));
      const preview=text('','cancellation-preview muted small');
      const update=()=>{
        count.textContent='Получатели · '+choices.filter(({check})=>check.checked).length+' из '+clients.length;
        audience.hidden=!notify.checked;
        preview.textContent=cancellationText(event,day,time,comment.value);
      };
      audience.append(...[group&&append(statuses,count,list),preview].filter(Boolean));
      form.append(text([day,time,event.location].filter(Boolean).join(' · ')),
        text('Встреча будет убрана из расписания и Google Календаря.'),
        field(group?'Комментарий к отмене':'Комментарий для уведомления',comment));
      if(mayNotify){
        form.append(append(el('label',null,'checkbox'),notify,el('span',label)),audience);
        if(!notify.disabled)form.append(text('Сообщение отправится после подтверждения отмены.'));
        else form.append(text(!clients.length
          ? group?'Для этой встречи в календаре спортсменов не найдены участники.':'Уточни клиента в карточке тренировки.'
          :!available.length?'У получателей нет привязки к Telegram.':'Подключи Telegram в настройках.'));
      }
      for(const control of [notify,comment,...choices.map(({check})=>check)])control.addEventListener('input',update);
      update();
      return async()=>{
        const chosen=notify.checked?choices.filter(({check})=>check.checked):[];
        if(notify.checked&&!chosen.length)throw Error('Выбери хотя бы одного получателя');
        body=cancellationText(event,day,time,comment.value);
        await cancel(comment.value.trim());
        if(chosen.length)results=await retry(chosen);
      };
    },{saveLabel:'Отменить тренировку',saveClass:'danger',cancelLabel:'Назад',onSaved:()=>{
      onCancelled();
      if(results)report(results,unavailable,body,retry);
      else message('Тренировка отменена');
    }});
  };
}
