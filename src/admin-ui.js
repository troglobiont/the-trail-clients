import {teamMembers,teamRole,teamEntries,teamSummary,saveTeamEntry,saveTeamNotes,TEAM_ENTRY_KINDS} from './team.js';
import {amountMinor,money,CURRENCIES} from './accounting.js';
import {localDate,validDate} from './model-utils.js';
import {isOwnerPerson} from './role-preview.js';

const duration=minutes=>[Math.floor(minutes/60)?Math.floor(minutes/60)+' ч':'',minutes%60?minutes%60+' мин':''].filter(Boolean).join(' ')||'0 ч';
export function createAdminUI({state,ui,el,append,button,row,text,field,input,select,section,modal,commit,navigate,openClient,render,formatDate,partnersUI}){
  let month=localDate().slice(0,7);
  const adminBack=()=>navigate('#admin');
  function page({athlete=false,person}={}){
    const members=teamMembers(state());
    if(athlete){
      const partners=Object.values(state().partners||{}).filter(partner=>!partner.archivedAt);
      return append(el('div',null,'stack-lg admin-page'),el('h1','Ещё'),
        section('Партнёры','preview-athlete-partners',partners.length
          ?partners.map(partner=>el('div',partner.name)):[text('Партнёров пока нет.')]),
        section('Команда','preview-athlete-team',members.length
          ?members.map(member=>el('div',member.name+' · '+teamRole(member))):[text('Команда пока не добавлена.')]),
        isOwnerPerson(person)&&section('Интеграции','preview-athlete-integrations',[
          button('Источники данных',()=>openClient(person.id,'sources'),'subtle')
        ]));
    }
    const list=el('div',null,'team-list');
    for(const member of members)list.append(append(button('',()=>navigate('#admin/team/'+member.id),'team-tile'),
      el('strong',member.name),text(teamRole(member)),el('span','›','team-chevron')));
    if(!members.length)list.append(text('Добавь человека с ролью «Тренер» или «Организатор» в разделе «Клиенты».'));
    const team=section('Команда','admin-team',[list]);
    const partners=section('Партнёры','admin-partners',[partnersUI.page({embedded:true})]);
    return append(el('div',null,'stack-lg admin-page'),el('h1','Админ'),partners,team);
  }
  function editNotes(member){
    modal('Заметки · '+member.name,form=>{
      const notes=el('textarea');notes.rows=5;notes.maxLength=2000;notes.value=member.teamAdmin?.notes||'';
      append(form,field('Зона ответственности и договорённости',notes));
      return ()=>commit(s=>saveTeamNotes(s,member.id,notes.value));
    });
  }
  function editEntry(member,entry=null){
    modal(entry?'Изменить запись':'Запись команды',form=>{
      const kind=select(Object.entries(TEAM_ENTRY_KINDS),entry?.kind||'work');
      const date=input('date',entry?.day||localDate());date.max=localDate();
      const hours=input('number',String(Math.floor((entry?.minutes||0)/60)));hours.min=0;hours.max=24;hours.step=1;
      const minutes=input('number',String((entry?.minutes||0)%60));minutes.min=0;minutes.max=59;minutes.step=1;
      const durationFields=row(field('Часы',hours),field('Минуты',minutes));durationFields.classList.add('team-duration');
      const amount=input('text',entry?.amount==null?'':String(entry.amount/100));amount.inputMode='decimal';
      const currency=select(CURRENCIES,entry?.currency||'RSD');
      const amountField=field('',amount),amountLabel=el('span');amountField.prepend(amountLabel);
      const moneyFields=row(amountField,field('Валюта',currency));moneyFields.classList.add('team-duration');
      const note=el('textarea');note.rows=3;note.maxLength=2000;note.value=entry?.note||'';
      const hint=text('');
      const update=()=>{
        durationFields.hidden=kind.value!=='work';
        amountLabel.textContent=kind.value==='work'?'Начислено за работу':kind.value==='accrual'?'Начислено':kind.value==='payout'?'Выплачено':'Потрачено';
        hint.textContent=kind.value==='work'?'Можно записать только время. Сумму добавь, когда она согласована.':
          kind.value==='payout'?'Запись о фактически выданных деньгах.':kind.value==='expense'?'Дополнительный расход на работу команды. Не уменьшает сумму к выплате.':
          'Начисление без записи часов: например, фиксированная оплата за месяц.';
      };
      kind.addEventListener('change',update);update();
      append(form,text(member.name,'task-title'),field('Тип записи',kind),field('Дата',date),durationFields,moneyFields,hint,field('За что / комментарий',note));
      return ()=>{
        if(!validDate(date.value)||date.value>localDate())throw Error('Проверь дату: запись отражает уже выполненную работу или расчёт');
        const h=hours.value.trim(),m=minutes.value.trim();
        if(kind.value==='work'&&(!/^\d{1,2}$/.test(h)||!/^\d{1,2}$/.test(m)||Number(m)>59))throw Error('Укажи часы и минуты');
        return commit(s=>saveTeamEntry(s,member.id,{...(entry?{id:entry.id}:{}),kind:kind.value,day:date.value,
          minutes:kind.value==='work'?Number(h)*60+Number(m):null,amount:amount.value.trim()?amountMinor(amount.value):null,currency:currency.value,note:note.value}));
      };
    });
  }
  function card(memberId){
    const member=teamMembers(state()).find(c=>c.id===memberId);
    if(!member)return append(el('div',null,'stack'),button('← Админ',adminBack,'back subtle'),text('Участник команды не найден. Проверь синхронизацию.'));
    ui.open.add('admin-team');
    const picker=input('month',month);picker.setAttribute('aria-label','Месяц учёта команды');picker.className='team-month';
    picker.addEventListener('change',()=>{if(validDate(picker.value+'-01')){month=picker.value;render();}});
    const page=append(el('div',null,'stack-lg team-card'),button('← Админ',adminBack,'back subtle'),
      append(el('div',null,'page-title'),el('h1',member.name),el('span',teamRole(member),'chip')),
      button('Карточка человека',()=>openClient(member.id),'subtle'),
      row(picker,button('+ Запись',()=>editEntry(member),'primary')));
    const summary=teamSummary(state(),member.id,month),entries=teamEntries(state(),member.id,month);
    const totals=append(el('section',null,'panel stack team-summary'),el('h2','За месяц'));
    if(!summary.entries&&!Object.keys(summary.currencies).length)totals.append(text('Записей пока нет. Часы и расчёты появятся после ввода.'));
    else {
      totals.append(row(el('strong',duration(summary.minutes)),text('Учтённое время')));
      if(summary.unpricedWork)totals.append(text('Есть работа без указанного начисления.'));
      for(const currency of CURRENCIES){
        const sums=summary.currencies[currency];if(!sums)continue;
        const block=el('div',null,'stack team-currency');
        for(const [label,value] of [['Начислено',sums.accrued],['Выплачено',sums.paid],['Расходы',sums.expenses]])
          block.append(append(el('div',null,'row between'),text(label),el('strong',money(value,currency),'money-amount')));
        block.append(append(el('div',null,'row between'),text(sums.balance>=0?'К выплате':'Выплачено авансом'),el('strong',money(Math.abs(sums.balance),currency),'money-amount')));
        totals.append(block);
      }
      totals.append(text('К выплате — по внесённым начислениям и выплатам на конец выбранного месяца.'));
    }
    page.append(totals);
    const history=append(el('section',null,'stack'),el('h2','История'));
    if(!entries.length)history.append(text('За этот месяц записей нет.'));
    for(const entry of entries){
      const item=append(button('',()=>editEntry(member,entry),'team-entry'),
        append(el('div',null,'row between'),el('strong',TEAM_ENTRY_KINDS[entry.kind]),text(formatDate(entry.day))),
        append(el('div',null,'row between'),entry.minutes&&text(duration(entry.minutes)),
          entry.amount!==null&&el('strong',money(entry.amount,entry.currency),'money-amount')),entry.note&&text(entry.note));
      item.setAttribute('aria-label',[TEAM_ENTRY_KINDS[entry.kind],formatDate(entry.day),entry.note].filter(Boolean).join(' · '));
      history.append(item);
    }
    page.append(history,section('Договорённости','team-notes-'+member.id,[text(member.teamAdmin?.notes||'Зона ответственности, ставки и условия пока не записаны.'),
      button('Изменить',()=>editNotes(member),'subtle')]));
    return page;
  }
  return {page,card};
}
