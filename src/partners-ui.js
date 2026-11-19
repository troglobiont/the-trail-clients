import {PARTNER_CATEGORIES,PARTNER_STATUSES,partnerList,partnerTasks,partnerURL,savePartner,savePartnerTask,
  completePartnerTask,savePartnerTerm,termConfirmation} from './partners.js';
import {localDate} from './model-utils.js';

const fullDate=new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',year:'numeric',timeZone:'Europe/Belgrade'});
const monthDate=new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric',timeZone:'Europe/Belgrade'});
const dated=value=>!value?'':/^\d{4}-\d{2}$/u.test(value)?monthDate.format(new Date(value+'-15T12:00:00Z')):
  /^\d{4}-\d{2}-\d{2}$/u.test(value)?fullDate.format(new Date(value+'T12:00:00Z')):value;
const amount=value=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(value);
const price=term=>term.price==null?'':amount(term.price)+(term.currency?' '+term.currency:'');

export function createPartnersUI({state,el,append,button,row,text,field,input,select,section,modal,commit,navigate,formatDate,message}) {
  let query='';
  const link=(label,value)=>{
    const url=partnerURL(value);if(!url)return text(label);
    const a=el('a',label,'partner-link');a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;
  };
  const contactLink=(label,prefix,value)=>{
    const a=el('a',label,'partner-link');a.href=prefix+(prefix==='tel:'?value:encodeURIComponent(value));return a;
  };
  const confirmation=(partner,term)=>{
    const source=termConfirmation(partner,term);
    const level=source.level==='owner_statement'&&!term.manualConfirmation&&term.discountPercent==null&&term.price==null
      ? 'Партнёра подтвердил Сергей'
      : {counterparty_email:'Подтверждено письмом',owner_statement:'Подтвердил Сергей',unknown:'Условия уточняются'}[source.level]||'Условия уточняются';
    return text([level,dated(source.date)].filter(Boolean).join(' · '));
  };

  function editPartner(partnerId=null) {
    const partner=state().partners?.[partnerId];
    modal(partner?'Изменить партнёра':'Новый партнёр',form=>{
      const name=input('text',partner?.name||'');name.maxLength=180;
      const category=select(PARTNER_CATEGORIES,partner?.category||'Другое');
      const status=select(Object.entries(PARTNER_STATUSES),partner?.relationshipStatus||'draft');
      const website=input('url',partner?.website||'','https://');
      const address=input('text',partner?.address?.text||partner?.storeContacts?.address||'');address.maxLength=300;
      const notes=el('textarea');notes.rows=4;notes.maxLength=4000;notes.value=partner?.notes||'';
      append(form,field('Название',name),row(field('Категория',category),field('Отношения',status)),field('Сайт',website),field('Адрес',address),field('Заметки',notes));
      return async()=>{
        if(!name.value.trim())throw Error('Введи название партнёра');
        if(website.value&&!partnerURL(website.value))throw Error('Проверь ссылку на сайт');
        const saved=await commit(s=>savePartner(s,{...(partner?{id:partner.id}:{}),name:name.value,category:category.value,
          relationshipStatus:status.value,website:website.value.trim()||null,notes:notes.value.trim(),
          address:address.value.trim()?{...partner?.address,text:address.value.trim()}:null}));
        navigate('#partners/'+saved.id);
        message('Карточка сохранена');
      };
    });
  }

  function editContact(partner,index=null) {
    const old=index===null?null:partner.contacts[index];
    modal(old?'Изменить контакт':'Добавить контакт',form=>{
      const name=input('text',old?.name||''),email=input('email',old?.email||''),phone=input('tel',old?.phone||'');
      name.maxLength=180;email.maxLength=254;phone.maxLength=60;
      append(form,field('Контактное лицо',name),field('Email',email),field('Телефон',phone));
      return ()=>{
        if(!name.value.trim()&&!email.value.trim()&&!phone.value.trim())throw Error('Заполни хотя бы одно поле контакта');
        if(email.value&&!email.validity.valid)throw Error('Проверь email');
        return commit(s=>{
          const contacts=[...s.partners[partner.id].contacts];
          const next={...old,name:name.value.trim(),email:email.value.trim()||null,phone:phone.value.trim()||null,sourceDate:localDate(),manualConfirmation:true};
          if(index===null)contacts.push(next);else contacts[index]=next;
          savePartner(s,{id:partner.id,contacts});
        });
      };
    });
  }

  function editTerm(partner,old=null) {
    modal(old?'Изменить условие':'Добавить условие',form=>{
      const title=input('text',old?.condition||old?.description||'');title.maxLength=1000;
      const description=input('text',old?.service||'');description.maxLength=1000;
      const discount=input('text',old?.discountPercent==null?'':String(old.discountPercent));discount.inputMode='decimal';
      const cost=input('text',old?.price==null?'':String(old.price));cost.inputMode='decimal';
      const currency=select([['','Не указана'],'RSD','RUB','EUR','USD'],old?.currency||'');
      const date=input('date',localDate());
      append(form,field('Условие',title),field('Услуга или товар',description),field('Скидка, %',discount),
        row(field('Цена',cost),field('Валюта',currency)),field('Дата подтверждения',date),
        text('Сохранение отметит это условие как подтверждённое тобой. Прежние письма сохранятся в источниках.'));
      const decimal=(control,max)=>{
        const value=control.value.trim().replace(',','.');if(!value)return null;
        if(!/^\d+(?:\.\d{1,2})?$/u.test(value)||Number(value)>max)throw Error('Проверь скидку и цену');
        return Number(value);
      };
      return ()=>{
        if(!title.value.trim())throw Error('Опиши условие');
        const value=decimal(cost,1e9);
        if(value!==null&&!currency.value)throw Error('Выбери валюту цены');
        return commit(s=>savePartnerTerm(s,partner.id,{...(old?{id:old.id}:{}),condition:title.value.trim(),description:title.value.trim(),
          service:description.value.trim(),discountPercent:decimal(discount,100),price:value,currency:currency.value||null,confirmedOn:date.value||localDate()}));
      };
    });
  }

  function editTask(partnerId,task=null,suggestion='') {
    modal(task?'Изменить задачу':'Задача партнёра',form=>{
      const title=el('textarea');title.rows=3;title.maxLength=1000;title.value=task?.title||suggestion;
      const due=input('date',task?.due||'');
      append(form,text(state().partners[partnerId].name,'task-title'),field('Что сделать',title),field('Срок',due));
      return ()=>commit(s=>savePartnerTask(s,partnerId,{...(task?{id:task.id}:{}),title:title.value,due:due.value||null}));
    });
  }
  function taskCard(task) {
    const card=append(el('div',null,'panel stack partner-task'),text(task.title,'task-title'),text(task.due?formatDate(task.due):'Без срока'));
    card.id=task.id;card.tabIndex=-1;
    if(task.due&&task.due<localDate()&&task.phase!=='done')card.classList.add('task-tile-overdue');
    return append(card,row(task.phase==='done'?button('Вернуть',()=>commit(s=>completePartnerTask(s,task.id,false)),'subtle'):
      button('Выполнено',()=>commit(s=>completePartnerTask(s,task.id)),'subtle'),
      button('Изменить',()=>editTask(task.partnerId,task),'subtle')));
  }

  function page() {
    const page=el('div',null,'stack-lg'),search=input('search',query,'Поиск партнёра');search.setAttribute('aria-label','Поиск партнёра');
    const list=el('div',null,'partner-list');
    const update=()=>{
      const q=search.value.trim().toLocaleLowerCase('ru');query=search.value;
      const partners=partnerList(state()).filter(p=>(p.name+' '+p.category+' '+(p.legalEntity||'')).toLocaleLowerCase('ru').includes(q));
      list.replaceChildren(...partners.map(p=>append(button('',()=>navigate('#partners/'+p.id),'partner-tile'),
        el('strong',p.name),text(p.category),
        p.benefits.some(term=>term.discountPercent!=null)&&text(p.benefits.map(term=>term.discountPercent==null?'':(term.condition?term.condition+' · ':'')+amount(term.discountPercent)+'%').filter(Boolean).join(' / ')),
        text(PARTNER_STATUSES[p.relationshipStatus]))));
      if(!partners.length)list.append(text(q?'Партнёры не найдены.':'Партнёров пока нет. После синхронизации здесь появятся подготовленные карточки.'));
    };
    search.addEventListener('input',update);update();
    return append(page,append(el('div',null,'page-title'),el('h1','Партнёры'),button('+ Добавить',()=>editPartner(),'subtle')),search,list);
  }

  function card(partnerId,taskId=null) {
    const p=state().partners?.[partnerId];if(!p)return append(el('div',null,'stack'),button('← К партнёрам',()=>navigate('#partners'),'back subtle'),text('Карточка не найдена. Проверь синхронизацию.'));
    const page=append(el('div',null,'stack-lg'),button('← К партнёрам',()=>navigate('#partners'),'back subtle'),
      append(el('div',null,'page-title'),el('h1',p.name),button('Изменить',()=>editPartner(p.id),'subtle')),
      text([p.category,PARTNER_STATUSES[p.relationshipStatus]].join(' · ')));
    const terms=append(el('section',null,'stack'),append(el('div',null,'row between'),el('h2','Условия для участников'),button('+ Условие',()=>editTerm(p),'subtle')));
    for(const term of p.benefits)append(terms,append(el('div',null,'panel stack'),
      append(el('div',null,'row between'),el('strong',term.condition||term.description||term.service),
        term.discountPercent!=null&&el('span','−'+amount(term.discountPercent)+'%','chip emphasis')),
      term.service&&term.service!==term.condition&&text(term.service),
      term.price!=null&&row(el('strong',price(term),'money-amount'),term.priceBasis?.startsWith('Расчёт')&&el('span','Расчёт','chip')),
      term.priceBasis&&section('Основание цены',p.id+'-'+term.id+'-basis',[text(term.priceBasis)]),
      term.discountPercent==null&&term.price==null&&text('Скидка и цена пока не указаны.'),confirmation(p,term),
      button('Изменить условие',()=>editTerm(p,term),'subtle')));
    if(!p.benefits.length)terms.append(text('Условия пока не указаны.'));
    page.append(terms);

    const contacts=p.contacts.map((contact,index)=>append(el('div',null,'stack'),contact.name&&el('strong',contact.name),
      contact.email&&contactLink(contact.email,'mailto:',contact.email),contact.phone&&contactLink(contact.phone,'tel:',contact.phone.replace(/[^+\d]/gu,'')),
      contact.sourceDate&&text('Данные · '+dated(contact.sourceDate)),contact.note&&text(contact.note),button('Изменить контакт',()=>editContact(p,index),'subtle')));
    if(p.address?.text)contacts.push(text(p.address.text),p.address.arrivalNotes&&text(p.address.arrivalNotes));
    if(p.storeContacts)contacts.push(!p.address?.text&&text(p.storeContacts.address),contactLink(p.storeContacts.email,'mailto:',p.storeContacts.email),
      ...p.storeContacts.phones.map(phone=>contactLink(phone,'tel:',phone)));
    if(p.website)contacts.push(link('Сайт партнёра',p.website));
    if(!contacts.length)contacts.push(text('Подтверждённые контакты пока не заполнены.'));
    contacts.push(button('+ Контакт',()=>editContact(p),'subtle'));
    page.append(section('Контакты',p.id+'-contacts',contacts.filter(Boolean)));

    const tasks=partnerTasks(state(),p.id),done=partnerTasks(state(),p.id,true);
    const actions=append(el('section',null,'stack'),append(el('div',null,'row between'),el('h2','Задачи'),button('+ Задача',()=>editTask(p.id),'subtle')));
    append(actions,...tasks.map(taskCard));
    const suggestion=p.nextStep?.text;
    if(!tasks.length)actions.append(text('Открытых задач нет.'));
    if(suggestion&&![...tasks,...done].some(task=>task.title===suggestion))append(actions,text(suggestion),
      button('Добавить в ToDo',()=>editTask(p.id,null,suggestion),'subtle'));
    if(done.length)actions.append(section('Выполнено · '+done.length,p.id+'-done',done.map(taskCard)));
    page.append(actions);

    const questions=(p.openQuestions||[]).map(question=>text('• '+question));
    for(const candidate of p.contactCandidates||[])questions.push(append(el('div',null,'panel stack'),
      el('strong','Контакт из открытого справочника'),text(candidate.address),text(candidate.phone),
      text(candidate.note?.split('DIKIDI')[0].trim()),text('Услуги и цены по ссылке записи пока не проверены.'),
      candidate.bookingUrl&&link('Непроверенная ссылка записи',candidate.bookingUrl)));
    if(questions.length)page.append(section('Нужно уточнить',p.id+'-questions',questions));
    const details=[];
    if(p.legalEntity)details.push(text(p.legalEntity));
    if(p.notes)details.push(text(p.notes));
    if(p.currentContext)details.push(text(p.currentContext));
    if(p.historicalServiceDetails){const h=p.historicalServiceDetails;details.push(el('strong','Состав услуги · '+dated(h.date)),
      text('Около '+h.durationMinutesApprox+' минут'),...h.includes.map(value=>text(value)),el('strong','По запросу'),...h.onRequest.map(value=>text(value)),text(h.note));}
    if(p.historicalContext){const h=p.historicalContext;details.push(text([h.project,h.task,dated(h.date)].join(' · ')),text(h.note));}
    details.push(text(p.clubBenefit||'Отдельная выгода и вознаграждение клубу пока не указаны.'));
    page.append(section('Подробности',p.id+'-details',details));
    page.append(section('Источники',p.id+'-sources',p.sources.length?p.sources.map(source=>append(el('div',null,'stack'),
      source.url?link(source.label||source.description||(source.type==='public_link_unreadable'?'Ссылка записи (не проверена)':'Источник'),source.url):
        text(source.type==='owner_statement'?'Подтверждение Сергея':source.type==='email_context'?'Подтверждение встречи':source.description||source.label||'Источник'),
      text(dated(source.date||source.checkedOn)))):[text('Источники пока не добавлены.')]));
    if(taskId)queueMicrotask(()=>{const task=page.querySelector('[id="'+taskId+'"]');task?.scrollIntoView({block:'center'});task?.focus({preventScroll:true});});
    return page;
  }
  return {page,card};
}
