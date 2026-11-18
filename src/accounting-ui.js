import * as A from './accounting.js';
import { addDays, localDate } from './model-utils.js';
import { ledgerRows } from './ledger-import.js';

const today = () => localDate();
const currencyOptions = A.CURRENCIES.map(c => [c, ({ RSD: 'RSD · динары', RUB: 'RUB · рубли', EUR: 'EUR · евро', USD: 'USD · доллары' })[c]]);
const statementLabels = {belgrade:'Групповые · Белград', online:'Онлайн', personal:'Персональные'};
const totals = amounts => A.CURRENCIES.filter(c => c in amounts).map(c => A.money(amounts[c], c)).join(' · ') || '—';
const monthLabel = month => new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(month + '-15T12:00:00Z')).replace(/\s*г\.$/, '');
const isMonthly = service => service.kind !== 'personal';

export function createAccountingUI({ state, el, append, button, row, field, input, select, text, section, modal, commit, render, formatDate, openClient, navigate, message, importLedger, searchClients, activateClient }) {
  let month = today().slice(0, 7);
  let tab = 'summary';
  let receivablePlace = 'all';
  const historyFilters = new Map();
  const book = () => A.accounting(state());
  const findService = id => book().services[id];
  const serviceTitle = A.tariffLabel;
  const clientName = id => state().clients[id]?.name || 'Клиент';

  function totalDisplay(amounts) {
    const unit = currency=>el('span',A.money(amounts[currency],currency),'money-amount');
    const extra = A.CURRENCIES.filter(c=>c!=='RSD'&&c in amounts);
    const rsd = 'RSD' in amounts && append(el('span',null,'account-currency-line'),unit('RSD'),extra.length&&' ·');
    const rest = extra.length&&append(el('span',null,'account-currency-line'),...extra.flatMap((c,i)=>i?[' · ',unit(c)]:[unit(c)]));
    return append(el('h2',null,'account-total'),rsd,rest,!(rsd||rest)&&'—');
  }

  function line(title, detail = '', value = '', action) {
    const item = action ? button('', action, 'account-line account-link') : el('div', null, 'account-line');
    const heading = append(el('span', null, 'account-label'), el('span', title), detail && el('small', detail));
    const amounts = value && (typeof value === 'object' ? value : append(el('span',null,'account-value'),...String(value).split(' · ')
      .flatMap((part,i)=>i?[' · ',el('span',part,'money-amount')]:[el('span',part,'money-amount')])));
    return append(item, heading, amounts);
  }

  function group(title, ...items) {
    return append(el('section', null, 'account-section'), el('h2', title), ...items);
  }

  function moneyInput(value) {
    const control = input('text', value == null ? '' : String(value / 100));
    control.inputMode = 'decimal';
    control.maxLength = 16;
    return control;
  }

  function dateInput(value = today(), past = true) {
    const control = input('date', value);
    if (past) control.max = today();
    return control;
  }

  function recordedDate(control) {
    if (control.value > today()) throw Error('Укажи дату фактической операции');
    return control.value;
  }

  const activeServices = () => Object.values(book().services).filter(s =>
    !s.oneOff && state().clients[s.clientId].status === 'Активный' && A.activeService(s, today()));
  const activeClientIds = () => new Set(activeServices().map(s => s.clientId));
  const serviceCaption = s => s.oneOff ? 'Разово · ' + serviceTitle(s) : serviceTitle(s);

  function tariffButtons(options, selected, onSelect) {
    const controls = el('div',null,'row catalog-quick');
    controls.setAttribute('role','group');
    controls.setAttribute('aria-label','Тариф');
    for (const [value,label] of options) {
      const control = button(label,()=>{
        selected = onSelect(value);
        for (const item of controls.children) item.setAttribute('aria-pressed',String(item.dataset.tariff === selected));
      });
      control.dataset.tariff = value;
      control.setAttribute('aria-pressed',String(value === selected));
      controls.append(control);
    }
    return controls;
  }

  function quickOptions(clientId, services = activeServices().filter(s => s.clientId === clientId),
      statuses = A.currentPaymentStatuses(state(),today(),clientId)) {
    const order = Object.keys(A.TARIFF_LABELS);
    return services.slice().sort((a,b) => order.indexOf(A.tariffKey(a)) - order.indexOf(A.tariffKey(b))).map(service => {
      const status = statuses.get(service.id);
      const next = service.pauses?.length && status?.type === 'none' ? status.nextDue?.slice(0,7) : null;
      return {kind:'payment',service,label:'Принять оплату',
        period:isMonthly(service) ? status?.previous?.month ?? next ?? today().slice(0,7) : null};
    });
  }

  function quickClientPicker(confirmation) {
    modal('Быстрая запись', form => {
      const search = input('search', '', 'Поиск (фамилия имя)');
      search.setAttribute('aria-label', 'Поиск (фамилия имя)');
      search.autofocus = true;
      const list = el('div', null, 'stack account-picker');
      const eligible = activeClientIds();
      const update = () => {
        const matches = searchClients(search.value).filter(client => eligible.has(client.id));
        list.replaceChildren(...matches.slice(0, 10).map(client => line(client.name, '', '›', () =>
          quickEntry(client.id, null, true))));
        if (!matches.length) list.append(text('Клиенты с действующими тарифами не найдены'));
        if (matches.length > 10) list.append(text('Уточни имя, чтобы увидеть остальные результаты'));
      };
      search.addEventListener('input', update);
      form.addEventListener('submit', e => {
        e.preventDefault();
        if (list.querySelectorAll('button').length === 1) list.querySelector('button').click();
      });
      const saved = confirmation && append(el('div', null, 'row between account-confirmation'), el('span', confirmation.label),
        confirmation.undo && button('Отменить запись', async () => { await confirmation.undo(); saved.remove(); }, 'subtle'));
      if (saved) saved.setAttribute('role', 'status');
      append(form, saved, search, list);
      update();
    }, { saveLabel:null });
  }

  function quickEntry(clientId, selection, fromAccount = false, {tariffs, scheduled} = {}) {
    const options = tariffs ?? (selection ? [selection] : quickOptions(clientId));
    if (!options.length) return noService(clientId);
    const title = scheduled ? 'Запись по тренировке' : selection?.label ?? 'Быстрая оплата';
    let confirmation;
    modal(title, (form, setSaveEnabled) => {
      const details = el('div',null,'stack');
      let selected = options[0];
      let selectedDate = scheduled?.date || selection?.date || today();
      let save;
      const show = () => {
        const {service,period:paidPeriod,amount:providedAmount} = selected;
        const monthly = isMonthly(service);
        const canRecordSession = !monthly && !selection;
        const date = dateInput(selectedDate);
        date.addEventListener('change',()=>{if(date.value)selectedDate=date.value;});
        const place = select(A.PLACES,service.place || 'Зал');
        const rate = moneyInput(service.rate);
        const period = input('month',paidPeriod || today().slice(0,7));
        const received = moneyInput();
        const receivedOn = scheduled && dateInput(selectedDate);
        const receivedOnField = scheduled && append(el('details',null,'fold'),
          el('summary','Дата оплаты'),append(el('div',null,'fold-body'),field('Дата получения',receivedOn)));
        const recordSession = input('checkbox');
        recordSession.checked = Boolean(scheduled);
        const paid = input('checkbox');
        const priorPayment = scheduled && book().operations[scheduled.paymentId];
        paid.disabled = Boolean(priorPayment && !priorPayment.voided);
        const separate = input('checkbox');
        const alreadyRecorded = scheduled && A.hasManualSession(state(),service.id,scheduled.date);
        const sessionField = append(el('label',null,'checkbox'),recordSession,el('span','Занятие проведено'));
        const paidField = append(el('label',null,'checkbox'),paid,el('span',scheduled ? 'Получены новые деньги' : 'Оплата получена'));
        const receivedField = field('Получено, ' + service.currency,received);
        const dateLabel = el('span');
        const placeField = field('Место',place);
        const rateField = field('Стоимость занятия, ' + service.currency,rate);
        const note = text('');
        const changes = append(el('details',null,'fold'),el('summary','Дата и детали'),
          append(el('div',null,'stack fold-body'),append(el('label'),dateLabel,date),
            canRecordSession && placeField,canRecordSession && rateField));
        const advanced = button('Другая валюта или распределение',()=>{
          const suggested = received.value.trim() ? A.amountMinor(received.value) : undefined;
          editPayment({clientId,serviceId:service.id,period:period.value,suggested,fromAccount,paymentDate:date.value,
            onSaved:fromAccount ? () => quickClientPicker({label:'Оплата записана'}) : undefined});
        },'subtle');
        const recalc = () => {
          const session = recordSession.checked;
          const payment = !canRecordSession || paid.checked;
          setSaveEnabled(session || payment);
          receivedField.hidden = !payment;
          if (receivedOnField) receivedOnField.hidden = !paid.checked || selectedDate === today();
          dateLabel.textContent = session ? payment ? 'Дата занятия и оплаты' : 'Дата занятия' : 'Дата получения';
          placeField.hidden = rateField.hidden = !session;
          advanced.hidden = !payment || session;
          changes.hidden = !session && !payment;
          note.textContent = '';
          if (session) {
            if (!received.dataset.edited) received.value = rate.value;
            const {balance} = A.serviceBalance(state(),service.id);
            if (scheduled) {
              const covered = Math.min(service.rate,Math.max(0,balance));
              const value = amount => A.money(amount,service.currency);
              if (!payment) note.textContent = covered === service.rate
                ? 'Из аванса '+value(covered)+' · останется '+value(balance-covered)
                : [covered && 'Из аванса '+value(covered),'К оплате '+value(service.rate-covered)].filter(Boolean).join(' · ');
            } else if (!payment && balance > 0) note.textContent = 'Занятие будет учтено в остатке аванса';
          } else if (monthly) {
            const charge = A.monthlyCharge(state(),service,period.value);
            const remaining = charge?.remaining ?? service.rate;
            received.value = remaining ? String(remaining/100) : '';
            if (charge && !charge.remaining) note.textContent = charge.coverageOnly
              ? 'Месяц закрыт. Здесь можно записать полученные деньги.' : 'Этот месяц уже оплачен';
            else if (ledgerRows(state(),{clientId,period:period.value})
              .some(entry => entry.block === service.block && ['review','shared'].includes(entry.kind))) {
              note.textContent = 'Есть запись из бухгалтерии для сверки';
            }
          } else if (!received.dataset.edited) {
            const {balance} = A.serviceBalance(state(),service.id);
            received.value = String((balance < 0 ? -balance : service.rate)/100);
          }
        };
        period.addEventListener('change',recalc);
        recordSession.addEventListener('change',recalc);
        paid.addEventListener('change',recalc);
        rate.addEventListener('input',recalc);
        received.addEventListener('input',()=>{received.dataset.edited='true';});
        recalc();
        if (providedAmount != null) received.value = String(providedAmount/100);
        details.replaceChildren(...[
          selection && text(serviceCaption(service)),
          scheduled && text([formatDate(scheduled.date),A.money(service.rate,service.currency)].join(' · ')),
          alreadyRecorded && text('На эту дату уже записано занятие по этому тарифу. Проверь историю клиента.','warning-text small'),
          alreadyRecorded && append(el('label',null,'checkbox'),separate,el('span','Это другое занятие')),
          canRecordSession && sessionField, canRecordSession && paidField,
          paid.disabled && text('Поступление по этой записи уже внесено'),
          receivedField,receivedOnField,monthly && field('Оплаченный месяц',period),note,!scheduled && changes,!scheduled && advanced
        ].filter(Boolean));
        save = async () => {
          const actualDate = recordedDate(date);
          const session = recordSession.checked;
          const payment = !canRecordSession || paid.checked;
          if (!session && !payment) throw Error('Отметь занятие или оплату');
          const amount = payment && A.amountMinor(received.value);
          const saved = await commit(s => {
            if (scheduled) return A.recordCalendarSession(s,{...scheduled,clientId,serviceId:service.id,
              currency:service.currency,amount:service.rate,place:service.place,received:amount,
              receivedOn:payment&&recordedDate(receivedOn),separate:separate.checked,performed:session});
            const fresh = A.accounting(s).services[service.id];
            if (!fresh || fresh.clientId !== clientId || fresh.kind !== service.kind || fresh.currency !== service.currency) {
              throw Error('Условия услуги изменились. Открой запись заново');
            }
            if (session) {
              const values = {serviceId:service.id,date:actualDate,place:place.value,currency:service.currency,
                amount:A.amountMinor(rate.value),note:''};
              return payment ? A.savePaidSession(s,values,amount) : [A.saveOperation(s,{...values,kind:'session'})];
            }
            return [A.saveOperation(s,{kind:'payment',date:actualDate,amount,currency:service.currency,payer:'',note:'',
              allocations:[{serviceId:service.id,month:monthly ? period.value : null,part:amount,credit:amount}]})];
          });
          const label = session ? payment ? 'Занятие и оплата записаны' : 'Занятие записано' : 'Оплата записана';
          const undo = () => commit(s => {
            for (const item of saved) {
              if (JSON.stringify(A.accounting(s).operations[item.id]) !== JSON.stringify(item)) throw Error('Запись уже изменилась. Открой историю для исправления');
            }
            for (const item of saved) A.setVoided(s,item.id,true);
          });
          if (fromAccount) confirmation = {label,undo};
          else message(label,false,{label:'Отменить запись',run:undo});
        };
      };
      const labels = options.map(({service}) => {
        const same = options.filter(item => serviceTitle(item.service) === serviceTitle(service));
        const name = same.length === 1 ? serviceTitle(service)
          : serviceTitle(service) + ' · ' + A.money(service.rate,service.currency) + ' · ' + formatDate(service.startsOn);
        return [service.id,name];
      });
      append(form,text(clientName(clientId),'account-form-client'),
        (!selection && (!scheduled || options.length>1)) && tariffButtons(labels,selected.service.id,id=>{
          if (selected.service.id === id) return id;
          selected = options.find(option => option.service.id === id);
          show();
          return id;
        }),details);
      show();
      return () => save();
    },{onSaved:fromAccount ? () => quickClientPicker(confirmation) : selection?.onSaved});
  }

  function scheduledSession(clientId, scheduled, services) {
    quickEntry(clientId,null,false,{scheduled,tariffs:services.map(service=>({service}))});
  }

  function numberInput(value, min, max) {
    const control = input('number', value);
    control.min = min;
    control.max = max;
    control.step = '1';
    return control;
  }

  function assistantVisit({ clientId, transcript, day, place, amount, currency, services, checkPayment, paymentOnly, draftKey, onSaved }) {
    modal(paymentOnly?'Записать оплату за персональную тренировку':'Записать персональное занятие', (form, setSaveEnabled) => {
      const missing = !services.length;
      const selected = select(services.map(s=>[s.id, serviceCaption(s)+' · '+A.money(s.rate,s.currency)]),services[0]?.id);
      const date = dateInput(day);
      const location = select(A.PLACES,place||services[0]?.place||'Зал');
      const rate = moneyInput();
      const moneyUnit = select(currencyOptions,currency||'RSD');
      const rateLabel = el('span','Стоимость занятия');
      const paid = select([['','Выбери статус'],['pending','К оплате'],['received','Оплачено']],checkPayment?'':'pending');
      const dateLabel = el('span','Дата занятия');
      const paidField = field('Статус оплаты',paid);
      const receivedOn = dateInput();
      const received = moneyInput(amount);
      const receivedLabel = el('span');
      const moneyFields = append(el('div',null,'stack'),field('Дата получения',receivedOn),append(el('label'),receivedLabel,received));
      const body = el('div',null,'stack');
      const actions = row();
      const warning = missing && text('У клиента нет подходящего тарифа на персональную тренировку'+(place?' · '+place:''),'warning-text small');
      let mode = missing ? '' : 'existing';
      let receivedEdited = amount != null;
      const sync = () => {
        const unit = selected.value ? findService(selected.value)?.currency : moneyUnit.value;
        const onlyPayment = paymentOnly && mode==='tariff';
        dateLabel.textContent = onlyPayment ? 'Тариф действует с' : 'Дата занятия';
        rateLabel.textContent = (onlyPayment ? 'Ставка за занятие, ' : 'Стоимость занятия, ')+unit;
        receivedLabel.textContent = 'Получено, '+unit;
        paidField.hidden = onlyPayment;
        moneyFields.hidden = !onlyPayment && paid.value !== 'received';
        if (!receivedEdited) received.value = rate.value;
        setSaveEnabled(!!mode&&(onlyPayment||!!paid.value));
      };
      function establishMode(next) {
        mode = next;
        for (const control of actions.children) control.setAttribute('aria-pressed',String(control.dataset.mode===mode));
        body.hidden = false;
        sync();
      }
      if (missing) for (const [key,label] of [['once','Разовое занятие'],['tariff','Добавить тариф']]) {
        const control=button(label,()=>establishMode(key));
        control.dataset.mode=key;
        control.setAttribute('aria-pressed','false');
        actions.append(control);
      }
      actions.classList.add('catalog-quick');
      const updateService = () => {
        const service=findService(selected.value);
        if (service) {
          location.value=place||service.place;
          rate.value=String(service.rate/100);
        } else {
          const rates = new Set(activeServices().filter(s=>s.kind==='personal'&&s.place===location.value&&s.currency===moneyUnit.value).map(s=>s.rate));
          const suggested=amount ?? (rates.size===1?[...rates][0]:null);
          rate.value=suggested==null?'':String(suggested/100);
        }
        sync();
      };
      selected.addEventListener('change',updateService);
      rate.addEventListener('input',sync);
      moneyUnit.addEventListener('change',sync);
      paid.addEventListener('change',sync);
      received.addEventListener('input',()=>{receivedEdited=true;});
      append(body,!missing&&field('Тариф',selected),append(el('label'),dateLabel,date),field('Место',location),
        append(el('div',null,'account-fields'),append(el('label'),rateLabel,rate),missing&&field('Валюта',moneyUnit)),
        paidField,moneyFields);
      body.hidden=missing;
      const context=[place,formatDate(day)].filter(Boolean).join(' · ');
      append(form,text(clientName(clientId),'account-form-client'),text(transcript),text(context),warning,missing&&actions,body);
      updateService();
      return async () => {
        const sessionDate=recordedDate(date);
        const onlyPayment=paymentOnly&&mode==='tariff';
        const payment=onlyPayment||paid.value==='received'?{amount:A.amountMinor(received.value),date:recordedDate(receivedOn)}:null;
        const values={clientId,serviceId:selected.value||null,oneOff:mode==='once',place:location.value,
          currency:selected.value ? findService(selected.value)?.currency : moneyUnit.value,
          rate:A.amountMinor(rate.value),date:sessionDate,payment,paymentOnly:onlyPayment};
        await commit(s=>{
          A.savePersonalVisit(s,values);
          delete s.settings.drafts?.[draftKey];
        });
        message(onlyPayment?'Тариф и оплата записаны':payment?'Занятие и оплата записаны':'Занятие записано');
      };
    }, {onSaved});
  }

  function memo(label, value = '') {
    const control = input('text', value);
    control.maxLength = 300;
    return [field(label, control), control];
  }

  function editPaymentDay(service, initialMonth) {
    modal('Перенести срок оплаты', form => {
      const period = input('month',initialMonth);
      period.min = service.startsOn.slice(0,7);
      if (service.endsOn) period.max = service.endsOn.slice(0,7);
      const day = numberInput(A.paymentDay(service,period.value),1,31);
      const mode = select([['from','Начиная с этого месяца'],['once','Только в этом месяце']],'from');
      period.addEventListener('change',() => { day.value = A.paymentDay(service,period.value); });
      append(form,text(serviceTitle(service)),field('Месяц',period),field('Новый день оплаты',day),field('Применить',mode),
        text('Меняется срок оплаты. Даты и суммы полученных платежей сохраняются.'));
      return async () => {
        await commit(s => A.movePaymentDay(s,service.id,period.value,Number(day.value),mode.value));
        message('Срок оплаты изменён');
      };
    });
  }

  function activateWithTariff(snapshot, clientId, serviceId, date) {
    for (const other of A.clientServices(snapshot,clientId)) {
      if (!other.oneOff && other.id !== serviceId && A.activeService(other,date)) {
        A.stopService(snapshot,other.id,'pause',date,date);
      }
    }
    return activateClient(snapshot,clientId,date);
  }

  function editService(clientId, existing, { resume = false, scheduled, restoreKey } = {}) {
    const client = state().clients[clientId];
    const previousPlace = {'personal-gym':'Зал','personal-outside':'Улица'}[restoreKey];
    modal(resume ? 'Возобновить сотрудничество' : restoreKey ? 'Вернуть услугу' : existing ? 'Условия услуги' : 'Добавить услугу', form => {
      const initial = scheduled || previousPlace ? 'personal' : restoreKey || (client.group === 'Да' ? 'belgrade' : ['gym', 'outside'].includes(client.personal) ? 'personal'
        : client.level === 'Премиум' ? 'coaching' : 'online');
      const options = Object.entries(A.PACKAGES).map(([key,label]) => [key,A.TARIFF_LABELS[key] ?? label]);
      if (resume && !restoreKey) options.unshift(['','Без тарифа']);
      const kind = select(options, existing ? A.servicePackage(existing) : resume && !restoreKey ? '' : initial);
      if (restoreKey) kind.disabled = true;
      const defaultBlock = type => ({ online:'online', personal:'personal', coaching:'online', belgrade:'belgrade', gym:'belgrade', trainingpeaks:'online' })[type] || 'online';
      const block = select(Object.entries(A.BLOCKS), existing?.block || defaultBlock(kind.value));
      const starts = dateInput(resume ? today() : existing?.startsOn || scheduled?.date || today(), resume);
      const ends = dateInput(resume ? '' : existing?.endsOn || '', false);
      const currency = select(currencyOptions, existing?.currency || (block.value === 'online' ? 'RUB' : 'RSD'));
      const rate = moneyInput(existing?.rate ?? (kind.value === 'belgrade' ? 800000 : undefined));
      const managesSchedule = existing?.id && isMonthly(existing) && !resume;
      const thisMonth = today().slice(0,7);
      const period = existing?.endsOn && existing.endsOn.slice(0,7) < thisMonth ? existing.endsOn.slice(0,7)
        : starts.value.slice(0,7) > thisMonth ? starts.value.slice(0,7) : thisMonth;
      const day = numberInput(managesSchedule ? A.paymentDay(existing,period) : existing?.day ?? Number(starts.value.slice(-2)), 1, 31);
      day.readOnly = Boolean(managesSchedule);
      const place = select(A.PLACES, existing?.place || scheduled?.place || previousPlace || (client.personal === 'outside' ? 'Улица' : 'Зал'));
      const reminder = input('checkbox');
      reminder.checked = existing?.reminder ?? true;
      const monthlyFields = append(el('div', null, 'stack'), field('День оплаты', day), append(el('label', null, 'checkbox'), reminder, el('span', 'Напоминать в ToDo')));
      if (managesSchedule) monthlyFields.append(button('Перенести срок',()=>editPaymentDay(existing,period),'subtle account-move-date'));
      const placeField = field('Обычное место занятия', place);
      const rateLabel = el('span');
      const billingStart = input('month', resume ? '' : existing?.billingFrom || '');
      const cover = input('month', existing?.coveredThrough || '');
      const tariffFields = append(el('div', null, 'stack'), field('Раздел отчёта', block),
        field('Последний день', ends),
        append(el('div', null, 'account-fields'), append(el('label'), rateLabel, rate), field('Валюта тарифа', currency)),
        monthlyFields, placeField);
      monthlyFields.append(field('Начислять с месяца', billingStart), field('Оплачено по месяц включительно', cover));
      const sync = () => {
        const personal = kind.value === 'personal';
        tariffFields.hidden = !kind.value;
        monthlyFields.hidden = personal;
        placeField.hidden = !personal;
        rateLabel.textContent = personal ? 'Ставка за занятие' : 'Тариф за месяц';
      };
      kind.addEventListener('change', () => {
        block.value = defaultBlock(kind.value);
        currency.value = block.value === 'online' ? 'RUB' : 'RSD';
        rate.value = kind.value === 'belgrade' ? '8000' : '';
        sync();
      });
      sync();
      append(form, field('Пакет', kind), field('Действует с', starts), tariffFields, existing?.note && text(existing.note));
      return async () => {
        if (resume && !kind.value) return commit(s => activateClient(s, clientId, starts.value));
        const activate = (s, service) => restoreKey ? activateWithTariff(s,clientId,service.id,starts.value) : activateClient(s,clientId,starts.value);
        const personal = kind.value === 'personal';
        if (!personal && !day.value) throw Error('Укажи день оплаты');
        if (!personal && billingStart.value && billingStart.value < starts.value.slice(0,7)) {
          throw Error('Месяц начисления должен быть не раньше начала действия тарифа');
        }
        const values = {
          clientId, kind: A.packageKind(kind.value), package:kind.value, block: block.value, startsOn: starts.value, endsOn: ends.value || null,
          currency: currency.value, rate: A.amountMinor(rate.value), day: personal ? null : managesSchedule ? existing.day : Number(day.value),
          reminder: !personal && reminder.checked, place: personal ? place.value : null,
          ...(!resume && !personal && existing?.paymentDays ? {paymentDays:existing.paymentDays} : {}),
          ...(!resume && existing?.pauses ? {pauses:existing.pauses} : {}),
          ...(personal && (restoreKey || !resume && existing?.returnState) ? {
            returnState:existing?.returnState?.previous ? existing.returnState : {from:starts.value,previous:null}
          } : {}),
          ...(!personal && cover.value ? { coveredThrough:cover.value } : {}),
          ...(!personal && billingStart.value ? { billingFrom:billingStart.value } : {}),
          ...(!resume && personal && existing?.openingCredit ? { openingCredit:existing.openingCredit } : {}),
          ...(!resume && existing?.note ? { note:existing.note } : {})
        };
        await commit(s => {
          if (!resume) {
            if (restoreKey && A.clientServices(s,clientId).some(service => !service.oneOff && A.tariffKey(service) === A.tariffKey(values) &&
                (!service.endsOn || service.endsOn >= values.startsOn))) throw Error('У клиента уже есть этот тариф');
            return A.saveService(s, values, existing?.id);
          }
          const current = A.clientServices(s, clientId).find(service => !service.oneOff && A.servicePackage(service) === values.package
            && service.place === values.place && service.startsOn <= values.startsOn && (!service.endsOn || service.endsOn >= values.startsOn));
          if (current) {
            const sameTerms = ['block','currency','rate','day'].every(key => current[key] === values[key]);
            if (sameTerms || personal && current.block === values.block && current.currency === values.currency) {
              const restored = A.servicePause(current,values.startsOn) ? A.restoreService(s,current.id,values.startsOn) : current;
              const saved = A.saveService(s, { ...restored, rate:values.rate, endsOn:values.endsOn, reminder:values.reminder,
                billingFrom:values.billingFrom ?? current.billingFrom, coveredThrough:values.coveredThrough ?? null }, current.id);
              return activate(s,saved);
            }
            if (current.startsOn >= values.startsOn) throw Error('На эту дату уже действует этот пакет. Проверь дату или открой условия тарифа.');
            A.saveService(s, { ...current, endsOn:addDays(values.startsOn,-1) }, current.id);
          }
          return activate(s,A.saveService(s,values));
        });
      };
    });
  }

  function changeServiceState(service, mode) {
    const pause = mode === 'pause';
    const title = pause ? 'Поставить на паузу' : 'Завершить тариф';
    modal(title, form => {
      const date = dateInput();
      date.min = service.startsOn;
      append(form,text(serviceTitle(service)),field(pause ? 'Пауза с' : 'Завершить с',date));
      return async () => {
        await commit(s=>A.stopService(s,service.id,mode,date.value));
        message(pause ? 'Тариф на паузе' : 'Тариф завершён');
      };
    }, {saveLabel:pause ? 'На паузу' : 'Завершить'});
  }

  function serviceActions(service, paused) {
    const canCancel = A.canCancelServiceReturn(state(),service,today());
    modal(serviceTitle(service), form => {
      const rate = A.money(service.rate,service.currency) + (isMonthly(service) ? ' / мес.' : ' / зан.');
      append(form,text(rate),append(el('div',null,'stack'),
        button('Условия услуги',()=>editService(service.clientId,service),'subtle'),
        canCancel && button('Отменить возврат',async()=>{
          await commit(s=>A.cancelServiceReturn(s,service.id));
          form.closest('dialog').close();
          message('Возврат отменён');
        },'subtle'),
        !canCancel && !paused && button('Поставить на паузу',()=>changeServiceState(service,'pause'),'subtle'),
        !canCancel && button('Завершить тариф',()=>changeServiceState(service,'end'),'subtle')));
    },{saveLabel:null,cancelLabel:'Закрыть'});
  }

  function withRestore(entry, label, action) {
    if (!action) return entry;
    const restore = button('+',action,'subtle tariff-restore');
    restore.setAttribute('aria-label','Вернуть тариф «'+label+'»');
    return append(el('div',null,'tariff-with-restore'),entry,restore);
  }

  function returnTariff(client, tariff, {service, preset, visit, price} = {}) {
    const resume = client.status !== 'Активный';
    if (!service && !preset && (!visit?.place || !price)) {
      return editService(client.id,undefined,{resume,restoreKey:tariff});
    }
    const terms = service || preset || {kind:'personal',place:visit.place,currency:price[0],rate:price[1]};
    const save = async date => {
      await commit(snapshot=>{
        const current = snapshot.clients[client.id];
        if (current.status !== client.status) throw Error('Статус клиента изменился. Открой тариф заново');
        let restored;
        if (service) {
          const assigned = A.accounting(snapshot).services[service.id];
          if (!assigned || A.tariffKey(assigned)!==tariff || assigned.startsOn>date) throw Error('Выбери дату действия тарифа');
          restored = A.activeService(assigned,date) ? assigned : A.restoreService(snapshot,assigned.id,date);
        } else if (terms.kind === 'personal') {
          restored = A.restoreHistoricalVisitTariff(snapshot,client.id,terms.place,terms.currency,terms.rate,date);
        } else {
          if (A.clientServices(snapshot,client.id).some(s=>A.tariffKey(s)===tariff && (!s.endsOn || s.endsOn>=date))) {
            throw Error('У клиента уже есть этот тариф');
          }
          restored = A.saveService(snapshot,{...terms,clientId:client.id,startsOn:date,endsOn:null});
        }
        if (resume) activateWithTariff(snapshot,client.id,restored.id,date);
      });
      message(resume ? 'Клиент и тариф возвращены' : 'Тариф возвращён');
    };
    if (!resume) return save(today());
    return modal('Возобновить сотрудничество', form=>{
      const date = dateInput();
      if (service) date.min = service.startsOn;
      append(form,text(client.name,'account-form-client'),line(A.TARIFF_LABELS[tariff],
        isMonthly(terms) ? 'День оплаты по тарифу · '+A.paymentDay(terms,today().slice(0,7)) : '',
        A.money(terms.rate,terms.currency)+(isMonthly(terms) ? ' / мес.' : ' / зан.')),
      field('Возобновить с',date));
      return ()=>save(recordedDate(date));
    },{saveLabel:'Возобновить'});
  }

  function resumeClient(client) {
    const previous = A.clientServices(state(), client.id).filter(s=>!s.oneOff)
      .sort((a,b) => Number(isMonthly(b)) - Number(isMonthly(a)) || b.startsOn.localeCompare(a.startsOn));
    editService(client.id, previous[0] || client.priorTariff, { resume:true });
  }

  function choices(clientId, onlyPersonal = false) {
    return Object.values(book().services).filter(s => (!clientId || clientId === s.clientId) && (!onlyPersonal || !isMonthly(s)))
      .sort((a, b) => Number(A.activeService(b, today())) - Number(A.activeService(a, today())) || clientName(a.clientId).localeCompare(clientName(b.clientId), 'ru') || b.startsOn.localeCompare(a.startsOn));
  }

  function serviceOptions(list, showClient) {
    return [['', 'Выбрать услугу'], ...list.map(s => [s.id,
      `${showClient ? clientName(s.clientId) + ' · ' : ''}${s.oneOff ? serviceCaption(s)+' · '+formatDate(s.startsOn)
        : serviceTitle(s)+' · с '+formatDate(s.startsOn)+(s.endsOn?' · завершена '+formatDate(s.endsOn):'')}`])];
  }

  function noService(clientId) {
    if (clientId) return editService(clientId);
    message('Добавь услугу в карточке клиента', false, { label: 'Клиенты', run: () => navigate('#clients') });
  }

  async function saveEntry(values, existing, fromAccount, buildAllocations) {
    if (fromAccount) {
      month = values.date.slice(0, 7);
      tab = 'operations';
    }
    await commit(s => A.saveOperation(s, buildAllocations ? { ...values, allocations:buildAllocations(s) } : values, existing?.id));
    message(existing ? 'Операция обновлена' : ({ payment: 'Оплата записана', session: 'Занятие записано', expense: 'Расход записан' })[values.kind]);
  }

  function correction(form, existing) {
    if (!existing) return;
    form.append(button(existing.voided ? 'Восстановить операцию' : 'Отменить операцию', async () => {
      await commit(s => A.setVoided(s, existing.id, !existing.voided));
      form.closest('dialog').close();
      message(existing.voided ? 'Операция восстановлена' : 'Операция отменена', false, {
        label: 'Вернуть', run: () => commit(s => A.setVoided(s, existing.id, existing.voided))
      });
    }, existing.voided ? 'subtle' : 'subtle danger'));
  }

  function editPayment({ clientId, serviceId, period, suggested, existing, fromAccount = false, paymentDate, onSaved } = {}) {
    const all = choices();
    const own = clientId ? choices(clientId) : all;
    if (!own.length && !existing) return noService(clientId);
    const seed = existing?.allocations[0]?.serviceId || serviceId || (clientId && own.length === 1 ? own[0].id : '');
    modal(existing ? 'Редактировать оплату' : 'Записать оплату', form => {
      const date = dateInput(existing?.date || paymentDate || today());
      const currency = select(currencyOptions, existing?.currency || findService(seed)?.currency || 'RSD');
      const amount = moneyInput(existing?.amount ?? suggested);
      const [payerField, payer] = memo('Плательщик · если отличается', existing?.payer);
      const [noteField, note] = memo('Комментарий', existing?.note);
      const lines = el('div', null, 'stack');
      const allocations = [];
      let currencyChosen = Boolean(existing || seed);
      const differentCurrency = service => Boolean(service && service.currency !== currency.value);
      const closesMonths = (item,service) => differentCurrency(service) && isMonthly(service) && item.settlement.value === 'full';
      const sync = () => {
        for (const item of allocations) {
          const service = findService(item.service.value);
          const foreign = differentCurrency(service);
          const closeMonths = closesMonths(item,service);
          const covered = closeMonths && A.monthlyCharge(state(),service,item.paidMonth.value)?.coverageOnly;
          item.periodField.hidden = !service || !isMonthly(service);
          item.settlementField.hidden = !foreign || !isMonthly(service);
          item.settlement.options[0].textContent = covered ? 'Записать поступление за закрытый месяц' : 'Закрыть месяц полностью';
          item.lastMonthField.hidden = !closeMonths || covered;
          item.creditField.hidden = !foreign || closeMonths;
          item.creditError.hidden = item.creditField.hidden || !item.creditError.textContent;
          if (service) item.creditLabel.textContent = `Сколько покрывает платёж, ${service.currency}`;
          item.partField.hidden = allocations.length === 1;
          item.remove.hidden = allocations.length === 1;
        }
      };
      const add = (value, limitToClient) => {
        const service = select(serviceOptions(limitToClient ? own : all, !limitToClient), value.serviceId || '');
        const paidMonth = input('month', value.month || period || (fromAccount ? month : today().slice(0, 7)));
        const lastMonth = input('month');
        const part = moneyInput(value.part);
        const credit = moneyInput(value.credit);
        const settlement = select([['full','Закрыть месяц полностью'],['partial','Указать сумму в валюте тарифа']],
          value.credit == null ? 'full' : 'partial');
        const creditLabel = el('span');
        const creditError = el('div',null,'form-error');
        const periodField = field('Оплаченный месяц', paidMonth);
        const settlementField = field('Как зачесть оплату',settlement);
        const lastMonthField = field('По месяц включительно', lastMonth);
        lastMonthField.append(el('small','Оставь пустым, если оплачиваешь один месяц'));
        const partField = field('Часть поступления', part);
        const creditField = append(el('label'), creditLabel, credit);
        const panel = el('div', null, 'stack account-allocation');
        const remove = button('Убрать строку', () => {
          allocations.splice(allocations.indexOf(item), 1);
          panel.remove();
          sync();
        }, 'subtle');
        const item = { service, paidMonth, lastMonth, settlement, part, credit, creditLabel, creditError,
          periodField, settlementField, lastMonthField, partField, creditField, remove };
        service.addEventListener('change', () => {
          const current = findService(service.value);
          if (current && !currencyChosen) { currency.value = current.currency; currencyChosen = true; }
          sync();
        });
        settlement.addEventListener('change',sync);
        paidMonth.addEventListener('change',sync);
        credit.addEventListener('input',()=>{
          credit.removeAttribute('aria-invalid');
          creditError.textContent = '';
          creditError.hidden = true;
        });
        allocations.push(item);
        lines.append(append(panel, field(limitToClient ? 'Услуга' : 'Клиент и услуга', service), partField, periodField,
          settlementField, lastMonthField, creditField, creditError, remove));
        sync();
      };
      currency.addEventListener('change', () => { currencyChosen = true; sync(); });
      for (const allocation of existing?.allocations || [{ serviceId: seed }]) add(allocation, Boolean(clientId && !existing));
      append(form, field('Дата получения', date), append(el('div', null, 'account-fields'), field('Получено', amount), field('Валюта платежа', currency)), payerField,
        el('h3', 'Что покрывает оплата'), lines, row(button('+ Услуга или месяц', () => add({}, false), 'subtle')), noteField);
      correction(form, existing);
      return () => {
        const full = A.amountMinor(amount.value);
        const paymentCurrency = currency.value;
        const plan = allocations.map(item => {
          const service = findService(item.service.value);
          if (!service) throw Error('Выбери услугу для каждой строки');
          const part = allocations.length === 1 ? full : A.amountMinor(item.part.value);
          const paidMonth = isMonthly(service) ? item.paidMonth.value : null;
          if (closesMonths(item,service)) {
            const recordCovered = Boolean(A.monthlyCharge(state(),service,paidMonth)?.coverageOnly);
            return { serviceId:service.id,firstMonth:paidMonth,lastMonth:recordCovered ? paidMonth : item.lastMonth.value || paidMonth,part,recordCovered };
          }
          let credit = part;
          if (differentCurrency(service)) {
            try { credit = A.amountMinor(item.credit.value); }
            catch (error) {
              const detail = item.credit.value.trim() ? error.message : `Укажи сумму в ${service.currency}, которую покрывает платёж`;
              item.credit.setAttribute('aria-invalid','true');
              item.creditError.textContent = detail;
              item.creditError.hidden = false;
              item.credit.focus();
              throw Error(detail);
            }
          }
          return { serviceId:service.id, month:paidMonth, part, credit };
        });
        const sessionId = existing?.sessionId;
        return saveEntry({ kind:'payment',date:recordedDate(date),amount:full,currency:paymentCurrency,payer:payer.value.trim(),note:note.value.trim(),
          ...(sessionId ? { sessionId } : {}) },existing,fromAccount,s => plan.flatMap(item =>
          'firstMonth' in item ? A.settleMonths(s,item,existing?.id) : [item]));
      };
    }, { onSaved });
  }

  function editSession({ clientId, serviceId, existing, fromAccount = false } = {}) {
    const list = choices(clientId, true).filter(service=>!service.oneOff||service.id===existing?.serviceId);
    if (!list.length) {
      if (clientId) return message('Добавь услугу «Персональные занятия» в карточке клиента', false, { label: 'Добавить', run: () => editService(clientId) });
      return noService();
    }
    modal(existing ? 'Редактировать занятие' : 'Записать занятие', form => {
      const service = select(serviceOptions(list, !clientId), existing?.serviceId || serviceId || (list.length === 1 ? list[0].id : ''));
      const selected = () => findService(service.value);
      const date = dateInput(existing?.date || today());
      const place = select(A.PLACES, existing?.place || selected()?.place || 'Зал');
      const rate = moneyInput(existing?.amount ?? selected()?.rate);
      const [noteField, note] = memo('Комментарий', existing?.note);
      const label = el('span');
      const sync = () => { label.textContent = selected() ? `Стоимость, ${selected().currency}` : 'Стоимость'; };
      service.addEventListener('change', () => {
        const current = selected();
        rate.value = current ? String(current.rate / 100) : '';
        place.value = current?.place || 'Зал';
        sync();
      });
      sync();
      append(form, field(clientId ? 'Услуга' : 'Клиент и услуга', service), field('Дата занятия', date),
        append(el('div', null, 'account-fields'), field('Место', place), append(el('label'), label, rate)), noteField);
      correction(form, existing);
      return () => {
        const current = selected();
        if (!current) throw Error('Выбери услугу');
        const actualDate = recordedDate(date);
        return saveEntry({ kind: 'session', serviceId: current.id, date: actualDate, place: place.value, amount: A.amountMinor(rate.value), currency: current.currency, note: note.value.trim() }, existing, fromAccount);
      };
    });
  }

  function editExpense(existing, fromAccount = true) {
    modal(existing ? 'Редактировать расход' : 'Записать расход', form => {
      const category = select(A.EXPENSES, existing?.category || 'Оплата тренеру');
      const date = dateInput(existing?.date || today());
      const amount = moneyInput(existing?.amount);
      const currency = select(currencyOptions, existing?.currency || 'RSD');
      const quantity = numberInput(existing?.quantity ?? '', 1, 100000);
      const rate = moneyInput(existing?.rate);
      const [noteField, note] = memo('Комментарий', existing?.note);
      const countFields = append(el('div', null, 'account-fields'), field('Число занятий · для расчёта', quantity), field('Ставка за занятие', rate));
      const amountField = field('Сумма', amount);
      const sync = () => {
        countFields.hidden = category.value !== 'Оплата тренеру';
        amountField.hidden = !countFields.hidden && Boolean(quantity.value || rate.value.trim());
      };
      category.addEventListener('change', sync);
      quantity.addEventListener('input', sync);
      rate.addEventListener('input', sync);
      sync();
      append(form, field('Статья', category), field('Дата расхода', date), field('Валюта', currency), countFields, amountField, noteField);
      correction(form, existing);
      return () => {
        const count = amountField.hidden ? Number(quantity.value) : null;
        const unitRate = amountField.hidden ? A.amountMinor(rate.value) : null;
        const value = amountField.hidden ? count * unitRate : A.amountMinor(amount.value);
        return saveEntry({ kind: 'expense', category: category.value, date: recordedDate(date), amount: value, currency: currency.value, quantity: count, rate: unitRate, note: note.value.trim() }, existing, fromAccount);
      };
    });
  }

  function operationLine(operation) {
    const { kind, date, note, currency, voided } = operation;
    const status = voided ? 'Отменена · ' : '';
    if (kind === 'expense') return line(operation.category, `${status}${formatDate(date)} · Расход${note ? ' · ' + note : ''}`, '−' + A.money(operation.amount, currency), () => editExpense(operation));
    if (kind === 'session') {
      const service = findService(operation.serviceId);
      const when = formatDate(date) + ' · ' + operation.place;
      return line(clientName(service.clientId), `${status}${when}${note ? ' · ' + note : ''}`, A.money(operation.amount, currency),
        () => editSession({existing:operation,fromAccount:true}));
    }
    const { names, tariffs, amount } = paymentBreakdown(operation);
    return line(names.join(', '),[status+formatDate(date),tariffs,note].filter(Boolean).join(' · '),A.money(amount,currency),
      () => editPayment({existing:operation,fromAccount:true}));
  }

  function paymentBreakdown(operation, clientId, packageFilter = 'all') {
    const items = operation.allocations.filter(item => {
      const service = findService(item.serviceId);
      return (!clientId || service.clientId === clientId) && (packageFilter === 'all' || A.tariffKey(service) === packageFilter);
    });
    const names = [...new Set(items.map(item => clientName(findService(item.serviceId).clientId)))];
    const byService = new Map();
    for (const item of items) {
      if (!byService.has(item.serviceId)) byService.set(item.serviceId,[]);
      byService.get(item.serviceId).push(item.month);
    }
    const details = [...byService].map(([serviceId,periods]) => {
      const service = findService(serviceId);
      const tariff = clientId ? '' : serviceTitle(service) + ' · ';
      if (!periods[0]) return serviceTitle(service);
      const ranges = [];
      for (const period of periods.sort()) {
        const last = ranges[ranges.length-1];
        if (last && A.nextMonth(last[1]) === period) last[1] = period;
        else ranges.push([period,period]);
      }
      const included = ranges.map(([first,last]) => first === last ? monthLabel(first) : monthLabel(first) + ' — ' + monthLabel(last));
      return tariff + (clientId ? 'за ' : '') + included.join(', ');
    });
    return {names,tariffs:[...new Set(details)].join(' / '),amount:items.reduce((sum,item)=>sum+item.part,0)};
  }

  function remindersPanel(limit = Infinity, periodFilter) {
    const reminders = A.paymentReminders(state()).filter(item => !periodFilter || item.month === periodFilter);
    if (!reminders.length) return null;
    const list = reminders.slice(0, limit).map(({ service, month: period, due, remaining }) => {
      const status = A.paymentTiming(due,today()) === 'overdue' ? 'Просрочено · срок ' : 'срок ';
      const detail = `${serviceTitle(service)} · ${monthLabel(period)} · ${status}${formatDate(due)}`;
      return append(el('div', null, 'account-reminder'),
        line(clientName(service.clientId), detail, A.money(remaining, service.currency), () => openClient(service.clientId)),
        button('Записать оплату', () => editPayment({ clientId: service.clientId, serviceId: service.id, period, suggested: remaining }), 'subtle'));
    });
    if (reminders.length > limit) list.push(button('Все напоминания', () => navigate('#todo'), 'subtle'));
    return group('По оплатам', ...list);
  }

  function todoItems() {
    return A.paymentReminders(state()).map(({service,month:period,due,remaining})=>({
      name:clientName(service.clientId), title:'Оплата · '+serviceTitle(service),
      due, next:A.money(remaining,service.currency), reminder:true, payment:true,
      open:()=>editPayment({clientId:service.clientId,serviceId:service.id,period,suggested:remaining})
    }));
  }

  function sourceSummary() {
    const source = state().ledger?.months.find(item => item.month === month);
    if (!source) return null;
    const labels = { ...A.BLOCKS, personal: 'Стоимость персональных занятий', expenses: 'Расходы', balance: 'Остаток по Белграду и персональным' };
    return group('По бухгалтерии за ' + monthLabel(month),
      ...Object.entries(labels).map(([block, label]) => line(label, '', totals(source.blocks[block] || {}))));
  }

  function sourceLine(entry) {
    const labels = { payment: 'Оплата по таблице', shared: 'Общий платёж семьи', review: 'Нужно сверить', repeat: 'Повтор строки', session: 'Персональные занятия', expense: 'Расход' };
    const information = [entry.date ? formatDate(entry.date) : '', labels[entry.kind], entry.detail].filter(Boolean).join(' · ');
    const owner = entry.owners.length === 1 ? entry.owners[0] : null;
    return line(entry.name, information, totals(entry.values), owner ? () => openClient(owner) : null);
  }

  function sourceOperations() {
    const entries = ledgerRows(state(), { period: month });
    if (!entries.length) return null;
    return group('Строки из бухгалтерии', ...Object.entries({ ...A.BLOCKS, expenses: 'Расходы' }).map(([block, label]) => {
      const group = entries.filter(entry => entry.block === block);
      return group.length && section(`${label} · ${group.length}`, `ledger-${month}-${block}`, group.map(entry => sourceLine(entry)));
    }));
  }

  function summary() {
    const summary = A.combinedSummary(state(), month);
    const metrics = append(el('div', null, 'panel stack'), text('Получено за месяц'), totalDisplay(summary.receipts));
    const byDirection = group('Источники поступлений', ...Object.entries(statementLabels).map(([key,label])=>line(label,'',totals(summary.blocks[key]||{}))));
    const lastDay = addDays(A.nextMonth(month)+'-01',-1);
    const balances = A.personalBalances(state(),lastDay);
    const personal = section('Персональные занятия', 'account-personal-totals', [
      line('Проведено · '+summary.count, 'Стоимость проведённых занятий', totals(summary.sessions)),
      line('Авансы клиентов', 'По учтённым занятиям и оплатам на конец месяца', totals(balances.advance)),
      line('Клиенты должны', '', totals(balances.debt))
    ]);
    const source = sourceSummary();
    return [metrics,byDirection,personal,group('Расходы и остаток',
      line('Расходы','',totals(summary.expenses)),line('Остаток · Белград и персональные','',totals(summary.localBalance))),
      source && section('Сверка с бухгалтерией','account-source-totals',[
        summary.imported.review>0&&text('Строки без подтверждённой оплаты не включены · '+summary.imported.review),
        summary.imported.skippedDuplicates>0&&text('Точные совпадения учтены один раз · '+summary.imported.skippedDuplicates),
        summary.imported.sessionRows>0&&text('В таблице занятия могут быть сгруппированы за месяц. Без дат отдельных занятий совпадения с приложением не проверяются.'),
        source
      ]),remindersPanel(3,month)];
  }

  function movement() {
    const events = A.movementFor(state(), month);
    return Object.entries(A.MOVEMENT).map(([kind, label]) => {
      const entries = events.filter(e => e.movement === kind);
      const people = [...new Map(entries.slice().reverse().map(e => [e.clientId, e])).values()].reverse();
      return group(`${label} · ${people.length}`, ...people.map(e => line(clientName(e.clientId), formatDate(e.day), '›', () => openClient(e.clientId))),
        people.length ? null : text('Записей пока нет'));
    });
  }

  function receivableDetails({service,unpaid,remaining}) {
    return append(el('div',null,'stack account-receivable-service'),
      line(serviceCaption(service),'К оплате',A.money(remaining,service.currency)),
      ...unpaid.map(({session,remaining}) => line(formatDate(session.date) + ' · ' + session.place,
        remaining < session.amount ? 'Частично оплачено' : '',A.money(remaining,service.currency),() => editSession({existing:session}))),
      button('Принять оплату',() => editPayment({clientId:service.clientId,serviceId:service.id,suggested:remaining}),'primary'));
  }

  function receivablesPage() {
    const entries = A.personalReceivables(state(),today());
    const places = append(el('div',null,'row catalog-quick'), ...[['all','Все'],['Зал','Зал'],['Улица','Улица']].map(([key,label]) => {
      const control = button(label,()=>{receivablePlace=key;render();});
      control.setAttribute('aria-pressed',String(receivablePlace === key));
      return control;
    }));
    places.setAttribute('role','group');
    places.setAttribute('aria-label','Место по тарифу');
    const clients = new Map();
    const total = {};
    for (const item of entries) {
      const {clientId,place,currency} = item.service;
      if (receivablePlace !== 'all' && place !== receivablePlace) continue;
      if (!clients.has(clientId)) clients.set(clientId,{items:[],sums:{}});
      const client = clients.get(clientId);
      client.items.push(item);
      client.sums[currency] = (client.sums[currency] ?? 0) + item.remaining;
      total[currency] = (total[currency] ?? 0) + item.remaining;
    }
    const list = [...clients].map(([clientId,{items,sums}]) => section(clientName(clientId) + ' · ' + totals(sums),
      'account-receivable-'+clientId,[...items.map(receivableDetails),button('Открыть карточку',()=>openClient(clientId),'subtle')]));
    return append(el('section',null,'stack'),el('h2','Проведено, не оплачено'),
      text('За персональные занятия, записанные в приложении'),places,
      clients.size ? line('Всего к получению','',totals(total)) : text('Неоплаченных занятий нет'),...list);
  }

  function page() {
    const period = input('month', month);
    period.setAttribute('aria-label', 'Месяц учёта');
    period.className = 'account-month';
    period.addEventListener('change', () => { if (period.value) month = period.value; render(); });
    const tabs = el('div', null, 'segmented');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Раздел учёта');
    for (const [key, label] of [['summary','Сводка'],['operations','Операции'],['receivables','К получению'],['movement','Движение']]) {
      const control = button(label, () => { tab = key; render(); });
      control.setAttribute('aria-pressed', String(tab === key));
      tabs.append(control);
    }
    const page = append(el('div', null, 'stack-lg'), append(el('div', null, 'row between'), el('h1', 'Учёт'), tab !== 'receivables' && period),
      row(button('Быстрая запись', quickClientPicker, 'primary')), tabs);
    if (tab === 'receivables') return append(page,receivablesPage());
    if (tab === 'summary') {
      if (!choices().length) page.append(text('Начни с услуги в карточке клиента. Укажи тариф и день оплаты для напоминаний в ToDo.'), row(button('К клиентам', () => navigate('#clients'), 'subtle')));
      append(page, ...summary());
    } else if (tab === 'operations') {
      const entries = A.operations(state(), { month, includeVoided: true });
      append(page, sourceOperations(), row(button('Распределить оплату', () => editPayment({ fromAccount: true })),button('+ Расход', () => editExpense())), group(state().ledger ? 'Записано в приложении' : 'Операции за месяц', ...(entries.length ? entries.map(o => operationLine(o)) : [text('Операций пока нет')])));
    } else append(page, ...movement());
    page.append(section('Импорт учёта', 'account-import', [
      state().ledger && text('Бухгалтерия загружена по ' + formatDate(state().ledger.asOf)),
      button('Импортировать файл учёта 2026', importLedger)
    ]));
    return page;
  }

  function clientPanel(client) {
    const date = today();
    const services = A.clientServices(state(), client.id);
    const active = services.filter(s => !s.oneOff && client.status === 'Активный' && A.activeService(s,date));
    const unpaidVisits = services.filter(s=>s.oneOff).map(s=>({service:s,debt:-A.serviceBalance(state(),s.id).balance})).filter(x=>x.debt>0);
    const history = A.clientAccountHistory(state(),client.id,today());
    const historyByTariff = A.clientHistoryByTariff(state(),history,client.id);
    const statuses = A.currentPaymentStatuses(state(),today(),client.id);
    const outstanding = new Map(A.personalReceivables(state(),today(),client.id).map(item => [item.service.id,item]));
    const paused = s => (!s.endsOn || s.endsOn >= date) && A.servicePause(s,date);
    const tariffLine = (s, action) => {
      const pause = paused(s);
      return line(serviceTitle(s), [s.startsOn > date && 'С ' + formatDate(s.startsOn),
        pause && 'На паузе с ' + formatDate(pause.from),s.endsOn && s.endsOn < date && 'До ' + formatDate(s.endsOn)]
        .filter(Boolean).join(' · '), A.money(s.rate,s.currency) + (isMonthly(s) ? ' / мес.' : ' / зан.'), action);
    };
    const currentStatus = s => {
      const info = statuses.get(s.id);
      if (!info) return null;
      let status, detail, value;
      let tone = info.type;
      if (isMonthly(s)) {
        const period = monthLabel(info.month).replace(/\s\d{4}$/, '');
        if (info.type === 'paid') {
          status = 'Месяц оплачен';
          detail = [period, 'срок ' + formatDate(info.due),
            info.nextDue && 'следующий срок ' + formatDate(info.nextDue)].filter(Boolean).join(' · ');
        } else if (info.type === 'none') {
          status = 'За этот месяц начислений нет';
          detail = info.nextDue && 'Следующий срок ' + formatDate(info.nextDue);
        } else {
          status = { upcoming:'Предстоит оплата', today:'Оплата сегодня', grace:'Ожидает оплаты', overdue:'Просрочено' }[info.timing];
          if (info.timing === 'upcoming') tone = 'none';
          detail = period + ' · срок ' + formatDate(info.due);
          value = A.money(info.remaining, s.currency);
        }
      } else {
        const { balance, used } = info;
        if (balance < 0) {
          status = 'К оплате';
          value = A.money(-balance, s.currency);
        } else if (balance > 0) {
          const count = Math.floor(balance / s.rate);
          status = 'Остаток аванса' + (count ? ' · хватит на ' + count + ' зан.' : '');
          value = A.money(balance, s.currency);
        } else if (used) status = 'Все занятия оплачены';
        else {
          status = 'За занятие';
          value = A.money(s.rate, s.currency);
        }
      }
      const item = line(serviceCaption(s), '', value);
      append(item.firstElementChild,el('span',status,`payment-indicator payment-${tone}`),detail && el('small',detail));
      const previous = info.previous;
      return append(el('div', null, 'account-client-status'), item, previous &&
        line(previous.timing === 'overdue' ? 'Просрочено за прошлые месяцы' : 'К оплате за прошлый месяц',
          'Первый срок ' + formatDate(previous.due),A.money(previous.remaining,s.currency)),
        isMonthly(s) ? button('Перенести срок',()=>editPaymentDay(s,info.month),'subtle account-move-date') :
          outstanding.has(s.id) && button('Неоплаченные занятия',() => modal('Проведено, не оплачено',form => {
            form.append(receivableDetails(outstanding.get(s.id)));
          },{saveLabel:null}),'subtle account-move-date'));
    };
    const payments = quickOptions(client.id,active,statuses);
    const previous = services.filter(s => !s.oneOff && s.startsOn <= date && !active.includes(s))
      .sort((a,b) => b.startsOn.localeCompare(a.startsOn));
    const personalDebt = previous.map(s=>outstanding.get(s.id)).find(Boolean);
    const oldCharge = personalDebt ? null : A.firstPastCharge(state(),previous.filter(isMonthly),date);
    const previousDebt = personalDebt || oldCharge;
    const future = services.filter(s => !s.oneOff && s.startsOn > date);
    const shownTariffs = new Set([...active,...previous].map(A.tariffKey));
    const restorable = new Set([...active,...future].map(A.tariffKey));
    const mayReturn = ['Активный','На паузе','Завершил'].includes(client.status);
    const restoreAssigned = previous.map(s => {
      const key = A.tariffKey(s);
      const action = mayReturn && !restorable.has(key) && (()=>returnTariff(client,key,{service:s}));
      restorable.add(key);
      return withRestore(tariffLine(s,paused(s) && (()=>serviceActions(s,true))),serviceTitle(s),action);
    });
    const prior = client.priorTariff;
    const priorKey = prior && A.tariffKey(prior);
    const pastKeys = Object.keys(A.TARIFF_LABELS).filter(key=>historyByTariff.has(key) || key===priorKey);
    const previousFromHistory = pastKeys.flatMap(tariff => {
      if (shownTariffs.has(tariff)) return [];
      const preset = tariff===priorKey ? prior : null;
      const entries = historyByTariff.get(tariff) ?? [];
      const records = entries.flatMap(item => {
        if (item.type === 'ledger') return [item.row];
        if (item.type === 'operation' && !item.operation.voided) return [item.operation];
        return [];
      });
      if (!records.length && !preset) return [];
      const lastVisit = records.find(record => record.kind === 'session' && record.date);
      const lastSession = lastVisit?.date;
      const lastPayment = records.find(record => ['payment','shared'].includes(record.kind) && record.date)?.date;
      const label = A.TARIFF_LABELS[tariff] + (tariff.startsWith('personal-') ? ' · разовые занятия' : '');
      const prices = lastVisit?.values && Object.entries(lastVisit.values).filter(([,value])=>value>0);
      const price = lastVisit?.currency ? [lastVisit.currency,lastVisit.amount] :
        lastVisit?.sourceLedgerRowId && prices?.length===1 ? prices[0] : null;
      const restore = mayReturn && !restorable.has(tariff) && (()=>returnTariff(client,tariff,{preset,visit:lastVisit,price}));
      return [withRestore(line(label,lastSession ? 'Последнее занятие · '+formatDate(lastSession) :
        lastPayment ? 'Последняя оплата · '+formatDate(lastPayment) : ''),A.TARIFF_LABELS[tariff],restore)];
    });
    const panel=section('Оплаты и занятия', `${client.id}-account`, [
      client.billingNote && text(client.billingNote),
      ...active.map(currentStatus), !active.length && !client.billingNote &&
        text(services.length || previousFromHistory.length ? 'Нет действующих услуг' : 'Тарифы пока не заданы'),
      ...unpaidVisits.map(({service,debt})=>{
        const visit = history.find(({operation}) => operation?.kind === 'session' && operation.serviceId === service.id);
        return line(serviceCaption(service),formatDate(visit?.date || service.startsOn)+' · К оплате',A.money(debt,service.currency),
          ()=>editPayment({clientId:client.id,serviceId:service.id,suggested:debt}));
      }),
      payments.length && button('Принять оплату',()=>quickEntry(client.id,null,false,{tariffs:payments}),'primary account-main-action'),
      section('Тарифы', `${client.id}-tariffs`, [
        ...active.map(s=>tariffLine(s,()=>serviceActions(s,false))),
        (previous.length || previousFromHistory.length) && section('Ранее', `${client.id}-previous-tariffs`, [
          ...restoreAssigned, ...previousFromHistory,
          previousDebt && button('Записать оплату долга', () => editPayment({clientId:client.id,serviceId:previousDebt.service.id,
            period:previousDebt.month,suggested:previousDebt.remaining}), 'subtle')
        ]),
        future.length && text('Будущие тарифы'), ...future.map(s=>tariffLine(s,()=>editService(client.id,s))),
        button('Добавить услугу', () => editService(client.id), 'subtle')
      ]),
      section('История оплат и занятий', `${client.id}-account-history`, [clientHistory(history,client.id,historyByTariff)])
    ]);
    panel.classList.add('client-accounting');
    return panel;
  }

  function historyAmount({label, amount, currency, received}, voided) {
    const value = (received ? '+' : '−')+A.money(Math.abs(amount),currency);
    const node = el('span',value,'money-amount'+(received && !voided ? ' history-received' : ''));
    node.setAttribute('aria-label',label+' '+value);
    return node;
  }

  function historyLine({title, status, context, details, amounts, notes = [], edit = [], voided = false}) {
    const values = append(el('span',null,'account-value history-amounts'),...amounts.map(unit=>historyAmount(unit,voided)));
    if (voided) values.classList.add('history-voided');
    return line(title,[status,context,details].filter(Boolean).join(' · '),values,()=>modal(title,form=>{
      const amountRows = amounts.map(unit => {
        const value = el('span',null,'account-value');
        if (voided) value.classList.add('history-voided');
        value.append(historyAmount(unit,voided));
        return line(unit.label,'',value);
      });
      const corrections = edit.length && append(el('details',null,'fold'),el('summary','Исправить запись'),
        append(el('div',null,'row fold-body'),...edit.map(([label,action])=>button(label,action,'subtle'))));
      append(form,text([status,context].filter(Boolean).join(' · ')),append(el('div',null,'history-details'),...amountRows),
        details && text(details),...notes.filter(Boolean).map(note=>text(note)),corrections);
    },{saveLabel:null,cancelLabel:'Закрыть'}));
  }

  function clientHistoryLine(operation, session, clientId, tariff, application) {
    const payment = operation.kind==='payment' ? operation : null;
    const visit = session || (operation.kind==='session' ? operation : null);
    const voided = operation.voided;
    const when = formatDate(operation.date);
    const info = payment && paymentBreakdown(payment,clientId,tariff);
    const received = payment && {label:'Поступило',amount:info.amount,currency:payment.currency,received:true};
    const charged = visit && {label:'Стоимость занятия',amount:visit.amount,currency:visit.currency,received:false};
    const status = session ? 'Проведено и оплачено' : visit ? 'Проведено' : 'Поступление';
    let details;
    if (application && payment) {
      details = [application.covered>0 && 'Погашено '+A.money(application.covered,application.currency),
        application.advance>0 && 'В аванс '+A.money(application.advance,application.currency)].filter(Boolean).join(' · ');
    } else if (application && visit) {
      details = [application.fromAdvance>0 && 'Из аванса '+A.money(application.fromAdvance,application.currency),
        application.due>0 && 'К оплате на эту дату '+A.money(application.due,application.currency)].filter(Boolean).join(' · ');
    }
    const context = visit ? '' : info.tariffs;
    return historyLine({title:when+(visit ? ' · '+visit.place : ''),status:voided ? 'Запись отменена' : status,
      context,details,amounts:[received,charged].filter(Boolean),
      notes:[...new Set([visit?.note,payment?.note])],voided,edit:[
        visit && ['Изменить занятие',()=>editSession({existing:visit})],
        payment && ['Изменить оплату',()=>editPayment({existing:payment})]
      ].filter(Boolean)});
  }

  function importedHistoryLine(entry) {
    const label = {payment:'Поступление',shared:'Семейная оплата · общая сумма',session:'Занятия за месяц'}[entry.kind];
    const received = entry.kind !== 'session';
    const amounts = A.CURRENCIES.filter(currency=>entry.values[currency]>0).map(currency=>({
      label:received?'Поступило':'Стоимость занятий',currency,amount:entry.values[currency],received}));
    const period = monthLabel(entry.month);
    if (!received && entry.sourceLedgerRowId) {
      const when = entry.date ? formatDate(entry.date) : period;
      const title = [when,entry.place].filter(Boolean).join(' · ');
      const status = entry.date ? 'Проведено · оплата не сверена' : 'Занятие без даты · оплата не сверена';
      const note = entry.detail.replace(/^1 зан\. × [\d.]+ RSD(?: · )?/u,'');
      return historyLine({title,status,amounts,notes:[note]});
    }
    return historyLine({title:entry.date ? formatDate(entry.date) : period,status:label,
      context:entry.date ? 'за '+period : '',amounts,notes:[entry.detail]});
  }

  function clientHistory(history, clientId, historyByTariff) {
    const operationDetails = A.personalOperationHistory(state(),clientId);
    const recorded = history.filter(item => item.type === 'operation').map(item => item.operation);
    const byId = new Map(recorded.map(operation => [operation.id, operation]));
    const pairs = new Map();
    const pairedSessions = new Set();
    for (const payment of recorded) {
      const session = byId.get(payment.sessionId);
      const allocation = payment.allocations?.[0];
      if (!session || session.kind !== 'session' || payment.kind !== 'payment' || payment.voided || session.voided
          || pairedSessions.has(session.id) || payment.date !== session.date || payment.currency !== session.currency
          || payment.allocations.length !== 1 || allocation?.serviceId !== session.serviceId || payment.amount !== session.amount) continue;
      pairs.set(payment.id, session);
      pairedSessions.add(session.id);
    }
    const tariffs = [...historyByTariff.keys()].map(key=>[key,A.TARIFF_LABELS[key]]);
    let selected = historyFilters.get(clientId);
    if (!historyByTariff.has(selected)) selected = 'all';
    const pageSize = 6;
    let limit = pageSize;
    const list = el('div',null,'account-history-list');
    const more = button('',()=>{limit += pageSize;draw();},'subtle');
    function draw(){
      const entries = (historyByTariff.get(selected) ?? history)
        .filter(item => item.type !== 'operation' || !pairedSessions.has(item.operation.id));
      list.replaceChildren(...entries.slice(0,limit).map(item => {
        if (item.type === 'coverage') {
          const { service } = item;
          const row = line('Оплачено по ' + monthLabel(service.coveredThrough));
          const note = service.note?.trim();
          append(row.firstElementChild,note && el('small',note),el('small','Дата и сумма платежа не записаны'));
          return row;
        }
        if (item.type === 'ledger') return importedHistoryLine(item.row);
        const operation = item.operation;
        return clientHistoryLine(operation,pairs.get(operation.id),clientId,selected,operationDetails.get(operation.id));
      }));
      if (!entries.length) list.append(text(selected === 'all' ? 'Платежей и занятий пока нет' : 'По этому тарифу записей нет'));
      more.hidden = limit >= entries.length;
      more.textContent = 'Показать ещё · ' + (entries.length-limit);
    }
    draw();
    return append(el('div',null,'stack'),tariffs.length && tariffButtons(tariffs,selected,value=>{
      selected = selected === value ? 'all' : value;
      historyFilters.set(clientId,selected);
      limit = pageSize;
      draw();
      return selected;
    }),list,more);
  }

  function settingsPanel() {
    const controls = Object.entries(A.BLOCKS).map(([key, name]) => ({ key, control: numberInput(book().reminders[key] ?? A.DEFAULT_REMINDERS[key], 0, 30), name }));
    return append(el('section', null, 'stack settings-section'),
      text('За сколько дней до срока показывать напоминание в ToDo. Ноль означает день оплаты.'),
      ...controls.map(({ name, control }) => field(name, control)), row(button('Сохранить напоминания', async () => {
        if (controls.some(({ control }) => !control.value.trim())) throw Error('Укажи число дней для каждого раздела');
        await commit(s => A.saveReminders(s, Object.fromEntries(controls.map(({ key, control }) => [key, Number(control.value)]))));
        message('Напоминания сохранены');
      })));
  }

  return { page, clientPanel, remindersPanel, todoItems, settingsPanel, quickEntry, quickOptions, assistantVisit, activeClientIds, resumeClient,
    scheduledSession, addScheduledTariff:(clientId,scheduled)=>editService(clientId,undefined,{scheduled}) };
}
