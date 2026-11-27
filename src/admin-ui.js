import {teamMembers,teamRole,teamParticipation,teamEntries,teamEntryPeriod,teamSummary,teamMonthPayoutDue,recordTeamPayout,saveTeamEntry,saveTeamNotes,saveTeamVisibility,saveTeamGroupRate,saveTeamProfile,sharesTeamProfile,TEAM_ENTRY_KINDS,TEAM_PARTICIPATION} from './team.js';
import {amountMinor,money,CURRENCIES} from './accounting.js';
import {addDays,localDate,validDate} from './model-utils.js';
import {coachContact,isOwnerPerson} from './role-preview.js';
import {GROUP_RATE} from './coach-accounting.js';
import {inlineSelect} from './inline-select.js';

const duration=minutes=>[Math.floor(minutes/60)?Math.floor(minutes/60)+' ч':'',minutes%60?minutes%60+' мин':''].filter(Boolean).join(' ')||'0 ч';
const monthCaption=period=>new Intl.DateTimeFormat('ru',{month:'long',year:'numeric',timeZone:'UTC'})
  .format(new Date(period+'-01T12:00:00Z')).replace(/\s*г\.$/u,'');
export function createAdminUI({state,ui,el,append,button,row,text,field,input,select,section,modal,commit,navigate,openClient,addCoach,render,formatDate,partnersUI,cashPanel}){
  let month=localDate().slice(0,7),coachMonth=month,weekDay=localDate();
  const adminBack=()=>navigate('#admin');
  function page({athlete=false,person}={}){
    const canManageTeam=ui.role==='superadmin';
    const members=teamMembers(state(),{includeHidden:canManageTeam});
    const list=el('div',null,'team-list');
    for(const member of members){
      const item=canManageTeam?button('',()=>navigate('#admin/team/'+member.id),'team-tile'):el('div',null,'team-tile');
      list.append(append(item,el('strong',member.name),text([teamRole(member),member.teamAdmin?.specialty].filter(Boolean).join(' · ')),
        canManageTeam&&teamRole(member)==='Тренер'&&teamParticipation(member)==='guest'&&text('Приглашённый'),
        canManageTeam&&!sharesTeamProfile(member)&&text('Только суперадмин'),
        canManageTeam&&el('span','›','team-chevron')));
    }
    if(!members.length)list.append(text('Команда пока не добавлена.'));
    const team=section('Команда','admin-team',[canManageTeam&&row(button('+ Добавить тренера',addCoach,'subtle')),list]);
    const partners=section('Партнёры','admin-partners',[partnersUI.page({embedded:true,readOnly:athlete})]);
    return append(el('div',null,'stack-lg admin-page'),el('h1',athlete?'Ещё':'Админ'),
      ui.role==='coach'&&row(button('Мой учёт',()=>navigate('#admin/my-account'),'subtle')),partners,team,
      athlete&&isOwnerPerson(person)&&section('Интеграции','preview-athlete-integrations',[
        button('Источники данных',()=>openClient(person.id,'sources'),'subtle')
      ]));
  }
  function editCoachProfile(member){
    modal('Профиль тренера',form=>{
      const participation=inlineSelect(form.ownerDocument,Object.entries(TEAM_PARTICIPATION),teamParticipation(member),'Формат участия');
      const specialty=input('text',member.teamAdmin?.specialty||'','Например, бег или ОФП');specialty.maxLength=120;
      append(form,participation.field,field('Специализация',specialty),text('В обычном списке назначения доступны постоянные тренеры.'));
      return ()=>commit(s=>saveTeamProfile(s,member.id,{participation:participation.value,specialty:specialty.value}));
    });
  }
  function editNotes(member){
    modal('Заметки · '+member.name,form=>{
      const notes=el('textarea');notes.rows=5;notes.maxLength=2000;notes.value=member.teamAdmin?.notes||'';
      append(form,field('Зона ответственности и договорённости',notes));
      return ()=>commit(s=>saveTeamNotes(s,member.id,notes.value));
    });
  }
  function editEntry(member,entry=null){
    modal(entry?'Изменить запись':'Добавить работу или расход',form=>{
      const kinds=[['work','Работа вне расписания'],['accrual','Начисление без часов'],['expense','Расход']];
      if(entry?.kind==='payout')kinds.push(['payout','Выплата']);
      const kind=select(kinds,entry?.kind||'work');
      const date=input('date',entry?.day||localDate());date.max=localDate();
      const period=input('month',entry?.kind==='payout'?teamEntryPeriod(entry):month);
      period.max=localDate().slice(0,7);
      const periodField=field('За какой месяц',period);
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
        periodField.hidden=kind.value!=='payout';
        amountLabel.textContent=kind.value==='work'?'Начислено за работу':kind.value==='accrual'?'Начислено':kind.value==='payout'?'Выплачено':'Потрачено';
        hint.textContent=kind.value==='work'?'Для работы вне расписания. Можно указать только время.':
          kind.value==='payout'?'Запись о фактически выданных деньгах.':kind.value==='expense'?'Дополнительный расход на работу команды. Не уменьшает сумму к выплате.':
          'Начисление без записи часов: например, фиксированная оплата за месяц.';
      };
      kind.addEventListener('change',update);update();
      append(form,text(member.name,'task-title'),field('Тип записи',kind),field('Дата',date),periodField,durationFields,moneyFields,hint,field('За что / комментарий',note));
      return ()=>{
        if(!validDate(date.value)||date.value>localDate())throw Error('Проверь дату: запись отражает уже выполненную работу или расчёт');
        const h=hours.value.trim(),m=minutes.value.trim();
        if(kind.value==='work'&&(!/^\d{1,2}$/.test(h)||!/^\d{1,2}$/.test(m)||Number(m)>59))throw Error('Укажи часы и минуты');
        if(kind.value==='payout'&&(!validDate(period.value+'-01')||period.value>period.max))throw Error('Укажи месяц выплаты');
        return commit(s=>saveTeamEntry(s,member.id,{...(entry?{id:entry.id}:{}),kind:kind.value,day:date.value,
          minutes:kind.value==='work'?Number(h)*60+Number(m):null,amount:amount.value.trim()?amountMinor(amount.value):null,
          currency:currency.value,note:note.value,...(kind.value==='payout'&&{payoutPeriod:period.value})}));
      };
    });
  }
  function payout(member,period){
    const due=teamMonthPayoutDue(state(),member.id,period),parts=Object.entries(due);
    modal('Выплатить',form=>{
      const mode=select([['month','За весь месяц'],['other','Другая сумма']],parts.length?'month':'other');
      mode.options[0].disabled=!parts.length;
      const day=input('date',localDate());day.max=localDate();
      const amount=input('text');amount.inputMode='decimal';
      const currency=select(CURRENCIES,parts[0]?.[0]??'RSD');
      const note=el('textarea');note.rows=2;note.maxLength=2000;
      const moneyFields=row(field('Сумма',amount),field('Валюта',currency));
      moneyFields.classList.add('team-duration');
      const hint=text(parts.length?'Остаток за месяц · '+parts.map(([unit,value])=>money(value,unit)).join(' · '):'За этот месяц нет остатка к выплате.');
      const update=()=>{moneyFields.hidden=mode.value==='month';};
      mode.addEventListener('change',update);update();
      append(form,text(member.name+' · '+monthCaption(period),'task-title'),field('Как учесть выплату',mode),hint,
        moneyFields,field('Дата фактической выплаты',day),field('Комментарий',note),
        text('Сохраняет запись о выданных деньгах в учёте.'));
      return ()=>commit(s=>recordTeamPayout(s,member.id,{period,day:day.value,note:note.value,
        ...(mode.value==='month'?{expected:due}:{amount:amountMinor(amount.value),currency:currency.value})}));
    },{saveLabel:'Записать выплату'});
  }
  function editRate(member){
    modal('Ставка за групповую',form=>{
      const rate=input('text',String((member.teamAdmin?.groupRate??GROUP_RATE)/100));rate.inputMode='decimal';
      append(form,field('Ставка, RSD за тренировку',rate),text('Новая ставка применяется к следующим отметкам о проведении.'));
      return ()=>commit(s=>saveTeamGroupRate(s,member.id,amountMinor(rate.value)));
    });
  }
  function monthTotals(member,period,entries,manage=false){
    const summary=teamSummary(state(),member.id,period);
    const due=manage?teamMonthPayoutDue(state(),member.id,period):null;
    const totals=append(el('section',null,'panel stack team-summary'),el('h2','За месяц'));
    if(teamRole(member)==='Тренер'){
      const group=entries.filter(e=>e.group);
      const live=group.filter(e=>!e.historical),archived=group.filter(e=>e.historical);
      totals.append(row(el('strong',String(group.length)),text('Групповых проведено')));
      if(live.length)totals.append(row(text('Начислено за групповые'),el('strong',money(live.reduce((sum,e)=>sum+e.amount,0),'RSD'))));
      if(archived.length)totals.append(row(text('По архивным отчётам · '+archived.length),el('strong',money(archived.reduce((sum,e)=>sum+e.amount,0),'RSD'))),
        text('Сумма по архивным отчётам показана отдельно от остатка к выплате.'));
    }
    if(!summary.entries&&!Object.keys(summary.currencies).length)totals.append(text('За этот месяц записей нет.'));
    else {
      if(summary.minutes)totals.append(row(el('strong',duration(summary.minutes)),text('Учтённое время')));
      if(summary.unpricedWork)totals.append(text('Есть работа без указанного начисления.'));
      for(const currency of CURRENCIES){
        const sums=summary.currencies[currency];if(!sums)continue;
        const block=el('div',null,'stack team-currency');
        const lines=[['Начислено',sums.accrued],['Выплачено',sums.paid]];
        if(manage)lines.push(['Расходы',sums.expenses]);
        for(const [label,value] of lines)
          block.append(append(el('div',null,'row between'),text(label),el('strong',money(value,currency),'money-amount')));
        const balance=manage?(due[currency]??0):sums.balance;
        block.append(append(el('div',null,'row between'),text(manage?'К выплате за месяц':balance>=0?'К выплате':'Выплачено авансом'),
          el('strong',money(Math.abs(balance),currency),'money-amount')));
        totals.append(block);
      }
    }
    if(manage)totals.append(row(button('Выплатить',()=>payout(member,period),'primary'),
      button('+ Работа или расход',()=>editEntry(member),'subtle')));
    return totals;
  }
  function groupRows(entries){
    const list=el('div',null,'stack');
    for(const entry of entries){
      list.append(append(el('div',null,'row between'),text([formatDate(entry.day),entry.note,entry.source].filter(Boolean).join(' · ')),
        el('strong',money(entry.amount,entry.currency),'money-amount')));
    }
    return list;
  }
  function myAccount(){
    if(ui.role!=='coach')return page();
    const member=coachContact(state(),ui.previewCoachId);
    const shell=append(el('div',null,'stack-lg team-card'),button('← Админ',adminBack,'back subtle'),el('h1','Мой учёт'));
    if(!member)return append(shell,text('Профиль тренера пока недоступен.'));
    const monthInput=input('month',coachMonth);monthInput.className='team-month';
    monthInput.addEventListener('change',()=>{if(validDate(monthInput.value+'-01')){coachMonth=monthInput.value;render();}});
    const dateInput=input('date',weekDay);
    dateInput.addEventListener('change',()=>{if(validDate(dateInput.value)){weekDay=dateInput.value;render();}});
    const weekday=new Date(weekDay+'T12:00:00Z').getUTCDay();
    const from=addDays(weekDay,-((weekday+6)%7)),to=addDays(from,6);
    const entries=teamEntries(state(),member.id),completed=entries.filter(e=>e.group);
    const weekly=completed.filter(e=>e.day>=from&&e.day<=to);
    const archiveWeek=weekly.filter(e=>e.historical),liveWeek=weekly.filter(e=>!e.historical);
    const monthly=entries.filter(e=>teamEntryPeriod(e)===coachMonth);
    const monthlyGroups=monthly.filter(e=>e.group);
    return append(shell,el('strong',member.name),text('Ставка за групповую · '+money(member.teamAdmin?.groupRate??GROUP_RATE,'RSD')),
      append(el('section',null,'panel stack'),el('h2','За неделю'),field('День нужной недели',dateInput),
        text(formatDate(from)+' – '+formatDate(to)),
        text('Проведено · '+weekly.length),
        liveWeek.length&&append(el('div',null,'row between'),text('Начислено за групповые'),el('strong',money(liveWeek.reduce((sum,e)=>sum+e.amount,0),'RSD'))),
        archiveWeek.length&&append(el('div',null,'row between'),text('По архивным отчётам · '+archiveWeek.length),el('strong',money(archiveWeek.reduce((sum,e)=>sum+e.amount,0),'RSD'))),
        weekly.length&&groupRows(weekly)),
      field('Месяц учёта',monthInput),monthTotals(member,coachMonth,monthly),
      monthlyGroups.length&&section('Даты проведённых тренировок','coach-month-groups-'+member.id,[groupRows(monthlyGroups)]),
      cashPanel());
  }
  function card(memberId){
    if(ui.role!=='superadmin')return page();
    const member=teamMembers(state()).find(c=>c.id===memberId);
    if(!member)return append(el('div',null,'stack'),button('← Админ',adminBack,'back subtle'),text('Участник команды не найден. Проверь синхронизацию.'));
    ui.open.add('admin-team');
    const picker=input('month',month);picker.setAttribute('aria-label','Месяц учёта команды');picker.className='team-month';picker.max=localDate().slice(0,7);
    picker.addEventListener('change',()=>{if(validDate(picker.value+'-01')&&picker.value<=picker.max){month=picker.value;render();}});
    const visible=sharesTeamProfile(member);
    const visibility=button(visible?'Скрыть от других ролей':'Показывать другим ролям',
      ()=>commit(s=>saveTeamVisibility(s,member.id,!visible)),'subtle');
    const trainer=teamRole(member)==='Тренер';
    const profile=section(trainer?'Профиль тренера':'Профиль участника','team-profile-'+member.id,[
      trainer&&append(el('div',null,'stack'),
        append(el('div',null,'row between'),text('Формат участия'),el('strong',TEAM_PARTICIPATION[teamParticipation(member)])),
        append(el('div',null,'row between'),text('Специализация'),el('strong',member.teamAdmin?.specialty||'Не указана')),
        button('Изменить профиль',()=>editCoachProfile(member),'subtle')),
      text(visible?'В команде виден тренеру, бухгалтеру и спортсмену.':'В команде виден только суперадмину.'),
      row(visibility,button('Карточка человека',()=>openClient(member.id),'subtle'))
    ]);
    const entries=teamEntries(state(),member.id,month);
    const history=el('div',null,'stack');
    if(!entries.length)history.append(text('За этот месяц записей нет.'));
    for(const entry of entries){
      const item=append(entry.group?el('div',null,'team-entry'):button('',()=>editEntry(member,entry),'team-entry'),
        append(el('div',null,'row between'),el('strong',entry.group?'Групповая тренировка':TEAM_ENTRY_KINDS[entry.kind]),text(formatDate(entry.day))),
        append(el('div',null,'row between'),entry.minutes&&text(duration(entry.minutes)),
          entry.amount!==null&&el('strong',money(entry.amount,entry.currency),'money-amount')),
        entry.payoutPeriod&&text('За '+monthCaption(entry.payoutPeriod)),entry.note&&text(entry.note),entry.source&&text(entry.source));
      item.setAttribute('aria-label',[entry.group?'Групповая тренировка':TEAM_ENTRY_KINDS[entry.kind],formatDate(entry.day),entry.note,entry.source].filter(Boolean).join(' · '));
      history.append(item);
    }
    const agreements=section('Договорённости','team-notes-'+member.id,[
      trainer&&row(text('Ставка за групповую · '+money(member.teamAdmin?.groupRate??GROUP_RATE,'RSD')),
        button('Изменить ставку',()=>editRate(member),'subtle')),
      text(member.teamAdmin?.notes||'Договорённости пока не записаны.'),
      button('Изменить договорённости',()=>editNotes(member),'subtle')
    ]);
    return append(el('div',null,'stack-lg team-card'),button('← Админ',adminBack,'back subtle'),
      append(el('div',null,'page-title'),el('h1',member.name),el('span',teamRole(member),'chip')),
      picker,monthTotals(member,month,entries,true),
      profile,agreements,section('История','team-history-'+member.id,[history]));
  }
  return {page,card,myAccount};
}
