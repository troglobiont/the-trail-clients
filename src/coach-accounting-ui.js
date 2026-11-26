import {CURRENCIES,activeService,amountMinor,clientServices,money,tariffLabel} from './accounting.js';
import {CASH_STATUS,coachCash,reviewCoachCash,submitCoachCash} from './coach-accounting.js';
import {id,localDate} from './model-utils.js';

export function createCoachAccountingUI({state,context,el,append,text,button,row,field,input,select,modal,commit,message,formatDate,searchClients}){
  const name=(clientId)=>state().clients[clientId]?.name||'Карточка клиента';

  function fields(form,clientId,entry,review=false){
    const date=input('date',entry?.date||localDate());date.max=localDate();
    const tariff=select([],entry?.serviceId||'');
    const currency=select(CURRENCIES,entry?.currency||'RSD');
    const sum=input('text',entry?String(entry.amount/100):'');sum.inputMode='decimal';
    const period=input('month',entry?.period||date.value.slice(0,7));
    const comment=el('textarea');comment.rows=2;comment.maxLength=900;comment.value=entry?.note||'';
    const credit=input('text');credit.inputMode='decimal';
    const monthField=field('За какой месяц',period),creditField=field('Зачесть в валюте тарифа',credit);
    const hint=text('');
    const services=clientServices(state(),clientId).filter(service=>!service.oneOff);
    let automaticCurrency=!entry;
    const selected=()=>services.find(service=>service.id===tariff.value);
    const update=()=>{
      const service=selected();
      monthField.hidden=service?.kind==='personal';
      creditField.hidden=!review||!service||service.currency===currency.value;
      hint.textContent=service?'': 'На выбранную дату нет доступной услуги.';
    };
    const updateDate=()=>{
      const selectedId=tariff.value||entry?.serviceId;
      const available=services.filter(service=>activeService(service,date.value));
      tariff.replaceChildren(...available.map(service=>{
        const label=tariffLabel(service);
        const multiple=available.filter(other=>tariffLabel(other)===label).length>1;
        const option=el('option',multiple?label+' · '+formatDate(service.startsOn):label);
        option.value=service.id;
        return option;
      }));
      if(available.some(service=>service.id===selectedId))tariff.value=selectedId;
      if(automaticCurrency&&selected())currency.value=selected().currency;
      update();
    };
    date.addEventListener('change',()=>{
      if(!entry&&date.value)period.value=date.value.slice(0,7);
      updateDate();
    });
    currency.addEventListener('change',()=>{automaticCurrency=false;update();});
    tariff.addEventListener('change',()=>{if(automaticCurrency&&selected())currency.value=selected().currency;update();});
    updateDate();
    append(form,text(name(clientId),'task-title'),field('Тариф',tariff),hint,field('Дата получения',date),
      row(field('Получено наличными',sum),field('Валюта',currency)),monthField,creditField,field('Назначение или комментарий',comment));
    return ()=>{
      const service=selected();
      if(!service)throw Error('Выбери услугу клиента');
      return {serviceId:service.id,date:date.value,currency:currency.value,amount:amountMinor(sum.value),
        period:service.kind==='personal'?null:period.value,note:comment.value,
        ...(!creditField.hidden&&{credit:amountMinor(credit.value)})};
    };
  }

  function submit(clientId,entry){
    if(context().role!=='coach'||entry&&entry.clientId!==context().coachId)return;
    const requestId=entry?.id||id('coach-cash');
    modal(entry?'Уточнить получение наличных':'Принять наличные',form=>{
      if(entry?.reason)form.append(text(entry.reason,'warning-text small'));
      const values=fields(form,clientId,entry);
      return async()=>{
        await commit(draft=>submitCoachCash(draft,requestId,{...values(),expectedUpdatedAt:entry?.updatedAt},context()));
        message('Наличные отправлены на проверку');
      };
    },{saveLabel:'Отправить на проверку'});
  }

  function pickClient(){
    modal('Принять наличные',form=>{
      const query=input('search','','Поиск клиента'),list=el('div',null,'stack');
      query.setAttribute('aria-label','Поиск клиента');
      const update=()=>{
        const found=searchClients(query.value).slice(0,12);
        list.replaceChildren(...found.map(client=>button(client.name,()=>submit(client.id),'team-entry')),
          ...(!found.length?[text('Клиенты не найдены')]:[]));
      };
      query.addEventListener('input',update);update();
      append(form,query,list);
    },{saveLabel:null});
  }

  function returnForCorrection(entry){
    modal('Вернуть на уточнение',form=>{
      const reason=el('textarea');reason.rows=3;reason.maxLength=1000;
      append(form,text(name(entry.payerClientId),'task-title'),field('Что уточнить',reason));
      return async()=>{
        await commit(draft=>reviewCoachCash(draft,entry.id,entry.updatedAt,'returned',{reason:reason.value},context()));
        message('Запись возвращена тренеру');
      };
    },{saveLabel:'Вернуть'});
  }

  function review(entry){
    if(context().role!=='superadmin')return;
    modal('Сверить наличные',form=>{
      form.append(text('Получил тренер · '+name(entry.clientId)));
      const values=fields(form,entry.payerClientId,entry,true);
      form.append(row(button('Вернуть на уточнение',()=>returnForCorrection(entry),'subtle')));
      return async()=>{
        await commit(draft=>reviewCoachCash(draft,entry.id,entry.updatedAt,'approved',values(),context()));
        message('Оплата подтверждена и записана клиенту');
      };
    },{saveLabel:'Подтвердить оплату'});
  }

  function queue(){
    if(context().role!=='superadmin')return [];
    return coachCash(state()).filter(entry=>entry.status==='pending').map(entry=>({
      name:name(entry.payerClientId),title:'Сверить наличные · '+money(entry.amount,entry.currency),
      next:formatDate(entry.date)+' · Получил '+name(entry.clientId),review:true,open:()=>review(entry)
    }));
  }

  function own(){
    const viewer=context();
    if(viewer.role!=='coach'||!viewer.coachId)return null;
    const entries=coachCash(state(),viewer.coachId);
    return append(el('section',null,'stack'),el('h2','Принятые наличные'),row(button('Принять наличные',pickClient,'primary')),
      !entries.length&&text('Пока нет записей о наличных.'),
      ...entries.map(entry=>append(el('article',null,'panel stack'),append(el('div',null,'row between'),
        el('strong',name(entry.payerClientId)),el('strong',money(entry.amount,entry.currency))),
        text([formatDate(entry.date),CASH_STATUS[entry.status]].join(' · ')),entry.note&&text(entry.note),
        entry.status==='returned'&&append(el('div',null,'stack'),text(entry.reason),row(button('Уточнить',()=>submit(entry.payerClientId,entry),'subtle'))))));
  }

  return {submit,queue,own};
}
