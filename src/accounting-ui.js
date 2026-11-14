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
  const book = () => A.accounting(state());
  const findService = id => book().services[id];
  const serviceTitle = s => A.PACKAGES[A.servicePackage(s)];
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
    const amounts = value && append(el('span',null,'account-value'),...String(value).split(' · ')
      .flatMap((part,i)=>i?[' · ',el('span',part,'money-amount')]:[el('span',part,'money-amount')]));
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
  const serviceCaption = s => isMonthly(s) ? serviceTitle(s) : (s.oneOff ? 'Разовое занятие' : serviceTitle(s)) + ' · ' + s.place;
  const importedPayment = (s, period) => ledgerRows(state(), { clientId:s.clientId, period })
    .some(entry => entry.block === s.block && ['payment','shared','review'].includes(entry.kind));

  function quickOptions(clientId, services = activeServices().filter(s => s.clientId === clientId)) {
    const priority = [];
    const personal = [];
    const other = [];
    for (const service of services) {
      if (isMonthly(service)) {
        const period = today().slice(0, 7);
        const remaining = A.monthlyCharge(state(), service, period)?.remaining ?? 0;
        const seenInArchive = importedPayment(service, period);
        const action = { kind:'payment', service, label:'Принять оплату', period };
        if (remaining && !seenInArchive) priority.push(action);
        else other.push(action);
        continue;
      }
      const { balance } = A.serviceBalance(state(), service.id);
      const useAdvance = balance >= service.rate;
      const session = { kind:'session', service, useAdvance, label:useAdvance ? 'Провести из аванса' : 'Записать занятие' };
      const paid = { kind:'combined', service, label:'Занятие и оплата' };
      if (balance < 0) {
        priority.push({ kind:'payment', service, label:'Принять оплату' });
        other.push(paid, session);
      } else if (balance >= service.rate) {
        personal.push(session);
        other.push(paid);
      } else {
        personal.push(paid);
        other.push(session);
      }
      if (balance>=0) other.push({kind:'payment',service,label:'Принять оплату'});
      other.push({ kind:'advance', service, label:'Внести аванс' });
    }
    return [...priority, ...personal, ...other];
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

  function quickEntry(clientId, selection, fromAccount = false) {
    const options = selection ? [selection] : quickOptions(clientId);
    if (!options.length) return noService(clientId);
    let confirmation;
    modal(selection ? selection.label : 'Быстрая запись', form => {
      const details = el('div', null, 'stack');
      const pick = select(options.map((option, index) => [String(index), option.label + ' · ' + serviceCaption(option.service)]), '0');
      let save;
      const show = () => {
        const action = options[Number(pick.value)];
        const { service, kind } = action;
        const date = dateInput(action.date||today());
        const place = select(A.PLACES, service.place || 'Зал');
        const rate = moneyInput(service.rate);
        const period = input('month', action.period || today().slice(0, 7));
        const received = moneyInput();
        const note = text('');
        const session = kind === 'session' || kind === 'combined';
        const payment = kind !== 'session';
        const recalc = () => {
          note.textContent = '';
          if (!payment || kind === 'advance') return;
          if (kind === 'combined') {
            received.value = rate.value;
          } else if (isMonthly(service)) {
            const charge = A.monthlyCharge(state(), service, period.value);
            const archived = importedPayment(service, period.value);
            received.value = !archived && (charge?.remaining ?? service.rate) ? String((charge?.remaining ?? service.rate) / 100) : '';
            if (archived) note.textContent = 'В бухгалтерии уже есть запись за этот месяц';
            else if (charge && !charge.remaining) note.textContent = 'Этот месяц уже оплачен';
          } else {
            const balance = A.serviceBalance(state(), service.id).balance;
            received.value = String((balance < 0 ? -balance : service.rate) / 100);
          }
        };
        period.addEventListener('change', recalc);
        rate.addEventListener('input', () => { if (kind === 'combined' && !received.dataset.edited) recalc(); });
        received.addEventListener('input', () => { received.dataset.edited = 'true'; });
        recalc();
        if(action.amount!=null)received.value=String(action.amount/100);
        const changes = append(el('details', null, 'fold'), el('summary', 'Дата и детали'),
          append(el('div', null, 'stack fold-body'), field(session ? 'Дата занятия' : 'Дата получения', date),
            session && field('Место', place), session && field('Стоимость занятия, ' + service.currency, rate)));
        details.replaceChildren(...[
          text(serviceCaption(service)),
          session && !payment && line(action.useAdvance ? 'Из аванса' : 'Стоимость занятия', '', A.money(service.rate, service.currency)),
          payment && isMonthly(service) && field('Оплаченный месяц', period),
          payment && field('Получено, ' + service.currency, received),
          note, changes,
          !session && button('Другая валюта или распределение', () => {
            const suggested = received.value.trim() ? A.amountMinor(received.value) : undefined;
            editPayment({ clientId, serviceId:service.id, period:period.value, suggested, fromAccount, paymentDate:date.value,
              onSaved:fromAccount ? () => quickClientPicker({ label:'Оплата записана' }) : undefined });
          }, 'subtle')
        ].filter(Boolean));
        save = async () => {
          const actualDate = recordedDate(date);
          const sessionValues = session && { serviceId:service.id, date:actualDate, place:place.value,
            amount:A.amountMinor(rate.value), currency:service.currency, note:'' };
          const amount = payment && A.amountMinor(received.value);
          const saved = await commit(s => {
            const fresh = A.accounting(s).services[service.id];
            if (!fresh || fresh.clientId !== clientId || fresh.kind !== service.kind || fresh.currency !== service.currency) {
              throw Error('Условия услуги изменились. Открой запись заново');
            }
            if (action.useAdvance && A.serviceBalance(s, service.id, actualDate).balance < sessionValues.amount) {
              throw Error('На дату занятия аванса не хватает. Проверь дату или выбери другой способ записи');
            }
            if (kind === 'combined') return A.savePaidSession(s, sessionValues, amount);
            if (kind === 'session') return [A.saveOperation(s, { ...sessionValues, kind:'session' })];
            return [A.saveOperation(s, { kind:'payment', date:actualDate, amount, currency:service.currency, payer:'', note:'',
              allocations:[{ serviceId:service.id, month:isMonthly(service) ? period.value : null, part:amount, credit:amount }] })];
          });
          const label = { combined:'Занятие и оплата записаны', session:'Занятие записано', advance:'Аванс записан', payment:'Оплата записана' }[kind];
          const undo = () => commit(s => {
            for (const item of saved) {
              if (JSON.stringify(A.accounting(s).operations[item.id]) !== JSON.stringify(item)) throw Error('Запись уже изменилась. Открой историю для исправления');
            }
            for (const item of saved) A.setVoided(s, item.id, true);
          });
          if (fromAccount) confirmation = { label, undo };
          else message(label, false, { label:'Отменить запись', run:undo });
        };
      };
      pick.addEventListener('change', show);
      append(form, text(clientName(clientId), 'account-form-client'), !selection && field('Что записать', pick), details);
      show();
      return () => save();
    }, { onSaved:fromAccount ? () => quickClientPicker(confirmation) : selection?.onSaved });
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

  function editService(clientId, existing, { resume = false } = {}) {
    const client = state().clients[clientId];
    modal(resume ? 'Возобновить сотрудничество' : existing ? 'Условия услуги' : 'Добавить услугу', form => {
      const initial = client.group === 'Да' ? 'belgrade' : ['gym', 'outside'].includes(client.personal) ? 'personal'
        : client.level === 'Премиум' ? 'coaching' : 'online';
      const options = Object.entries(A.PACKAGES);
      if (resume) options.unshift(['','Без тарифа']);
      const kind = select(options, existing ? A.servicePackage(existing) : resume ? '' : initial);
      const defaultBlock = type => ({ online:'online', personal:'personal', coaching:'online', belgrade:'belgrade', gym:'belgrade', trainingpeaks:'online' })[type] || 'online';
      const block = select(Object.entries(A.BLOCKS), existing?.block || defaultBlock(kind.value));
      const starts = dateInput(resume ? today() : existing?.startsOn || today(), resume);
      const ends = dateInput(resume ? '' : existing?.endsOn || '', false);
      const currency = select(currencyOptions, existing?.currency || (block.value === 'online' ? 'RUB' : 'RSD'));
      const rate = moneyInput(existing?.rate ?? (kind.value === 'belgrade' ? 800000 : undefined));
      const day = numberInput(existing?.day ?? Number(starts.value.slice(-2)), 1, 31);
      const place = select(A.PLACES, existing?.place || (client.personal === 'outside' ? 'Улица' : 'Зал'));
      const reminder = input('checkbox');
      reminder.checked = existing?.reminder ?? true;
      const monthlyFields = append(el('div', null, 'stack'), field('День оплаты', day), append(el('label', null, 'checkbox'), reminder, el('span', 'Напоминать в ToDo')));
      const placeField = field('Обычное место занятия', place);
      const rateLabel = el('span');
      const cover = input('month', existing?.coveredThrough || '');
      const tariffFields = append(el('div', null, 'stack'), field('Раздел отчёта', block),
        field('Последний день', ends),
        append(el('div', null, 'account-fields'), append(el('label'), rateLabel, rate), field('Валюта тарифа', currency)),
        monthlyFields, placeField);
      monthlyFields.append(field('Оплачено по месяц включительно', cover));
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
      append(form, field('Пакет', kind), field('Действует с', starts), tariffFields);
      return async () => {
        if (resume && !kind.value) return commit(s => activateClient(s, clientId, starts.value));
        const personal = kind.value === 'personal';
        if (!personal && !day.value) throw Error('Укажи день оплаты');
        const values = {
          clientId, kind: A.packageKind(kind.value), package:kind.value, block: block.value, startsOn: starts.value, endsOn: ends.value || null,
          currency: currency.value, rate: A.amountMinor(rate.value), day: personal ? null : Number(day.value),
          reminder: !personal && reminder.checked, place: personal ? place.value : null,
          ...(!personal && cover.value ? { coveredThrough:cover.value } : {}),
          ...(!resume && !personal && existing?.billingFrom ? { billingFrom:existing.billingFrom } : {}),
          ...(!resume && personal && existing?.openingCredit ? { openingCredit:existing.openingCredit } : {}),
          ...(!resume && existing?.note ? { note:existing.note } : {})
        };
        await commit(s => {
          if (!resume) return A.saveService(s, values, existing?.id);
          const current = A.clientServices(s, clientId).find(service => A.servicePackage(service) === values.package
            && service.place === values.place && A.activeService(service, values.startsOn));
          if (current) {
            const sameTerms = ['block','currency','rate','day'].every(key => current[key] === values[key]);
            if (sameTerms || personal && current.block === values.block && current.currency === values.currency) {
              A.saveService(s, { ...current, rate:values.rate, endsOn:values.endsOn, reminder:values.reminder,
                coveredThrough:values.coveredThrough ?? null }, current.id);
              return activateClient(s, clientId, starts.value);
            }
            if (current.startsOn >= values.startsOn) throw Error('На эту дату уже действует этот пакет. Проверь дату или открой условия тарифа.');
            A.saveService(s, { ...current, endsOn:addDays(values.startsOn,-1) }, current.id);
          }
          A.saveService(s, values);
          activateClient(s, clientId, starts.value);
        });
      };
    });
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

  async function saveEntry(values, existing, fromAccount) {
    if (fromAccount) {
      month = values.date.slice(0, 7);
      tab = 'operations';
    }
    await commit(s => A.saveOperation(s, values, existing?.id));
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
      const sync = () => {
        for (const item of allocations) {
          const service = findService(item.service.value);
          item.periodField.hidden = !service || !isMonthly(service);
          item.creditField.hidden = !service || service.currency === currency.value;
          if (service) item.creditLabel.textContent = `Зачесть в ${service.currency}`;
          item.partField.hidden = allocations.length === 1;
          item.remove.hidden = allocations.length === 1;
        }
      };
      const add = (value, limitToClient) => {
        const service = select(serviceOptions(limitToClient ? own : all, !limitToClient), value.serviceId || '');
        const paidMonth = input('month', value.month || period || (fromAccount ? month : today().slice(0, 7)));
        const part = moneyInput(value.part);
        const credit = moneyInput(value.credit);
        const creditLabel = el('span');
        const periodField = field('Оплаченный месяц', paidMonth);
        const partField = field('Часть поступления', part);
        const creditField = append(el('label'), creditLabel, credit);
        const panel = el('div', null, 'stack account-allocation');
        const remove = button('Убрать строку', () => {
          allocations.splice(allocations.indexOf(item), 1);
          panel.remove();
          sync();
        }, 'subtle');
        const item = { service, paidMonth, part, credit, creditLabel, periodField, partField, creditField, remove };
        service.addEventListener('change', () => {
          const current = findService(service.value);
          if (current && !currencyChosen) { currency.value = current.currency; currencyChosen = true; }
          sync();
        });
        allocations.push(item);
        lines.append(append(panel, field(limitToClient ? 'Услуга' : 'Клиент и услуга', service), periodField, partField, creditField, remove));
        sync();
      };
      currency.addEventListener('change', () => { currencyChosen = true; sync(); });
      for (const allocation of existing?.allocations || [{ serviceId: seed }]) add(allocation, Boolean(clientId && !existing));
      append(form, field('Дата получения', date), append(el('div', null, 'account-fields'), field('Получено', amount), field('Валюта платежа', currency)), payerField,
        el('h3', 'Что покрывает оплата'), lines, row(button('+ Услуга или месяц', () => add({}, false), 'subtle')), noteField);
      correction(form, existing);
      return () => {
        const full = A.amountMinor(amount.value);
        const values = allocations.map(item => {
          const service = findService(item.service.value);
          if (!service) throw Error('Выбери услугу для каждой строки');
          const part = allocations.length === 1 ? full : A.amountMinor(item.part.value);
          const credit = service.currency === currency.value ? part : A.amountMinor(item.credit.value);
          return { serviceId: service.id, month: isMonthly(service) ? item.paidMonth.value : null, part, credit };
        });
        const sessionId = existing?.sessionId;
        return saveEntry({ kind: 'payment', date: recordedDate(date), amount: full, currency: currency.value, payer: payer.value.trim(), note: note.value.trim(),
          allocations: values, ...(sessionId ? { sessionId } : {}) }, existing, fromAccount);
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

  function operationLine(operation, clientId) {
    const { kind, date, note, currency, voided } = operation;
    const status = voided ? 'Отменена · ' : '';
    if (kind === 'expense') return line(operation.category, `${status}${formatDate(date)} · Расход${note ? ' · ' + note : ''}`, '−' + A.money(operation.amount, currency), () => editExpense(operation));
    if (kind === 'session') {
      const service = findService(operation.serviceId);
      return line(clientId ? 'Занятие' : clientName(service.clientId), `${status}${formatDate(date)} · Занятие · ${operation.place}${note ? ' · ' + note : ''}`, A.money(operation.amount, currency), () => editSession({ existing: operation, fromAccount: !clientId }));
    }
    const items = operation.allocations.filter(item => !clientId || findService(item.serviceId).clientId === clientId);
    const names = [...new Set(items.map(item => clientName(findService(item.serviceId).clientId)))];
    const details = items.map(item => serviceTitle(findService(item.serviceId)) + (item.month ? ' · ' + monthLabel(item.month) : ' · аванс или оплата занятия'));
    const label = clientId ? 'Оплата' : names.join(', ');
    const value = items.reduce((sum, item) => sum + item.part, 0);
    return line(label, `${status}${formatDate(date)} · ${details.join(' / ')}${note ? ' · ' + note : ''}`, A.money(value, currency), () => editPayment({ existing: operation, fromAccount: !clientId }));
  }

  function remindersPanel(limit = Infinity, periodFilter) {
    const reminders = A.paymentReminders(state()).filter(item => !periodFilter || item.month === periodFilter);
    if (!reminders.length) return null;
    const list = reminders.slice(0, limit).map(({ service, month: period, due, remaining }) => {
      const detail = `${serviceTitle(service)} · ${monthLabel(period)} · ${due < today() ? 'просрочено с ' : 'срок '}${formatDate(due)}`;
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

  function sourceLine(entry, clientId) {
    const labels = { payment: 'Оплата по таблице', shared: 'Общий платёж семьи', review: 'Нужно сверить', repeat: 'Повтор строки', session: 'Персональные занятия', expense: 'Расход' };
    const information = [entry.date ? formatDate(entry.date) : '', labels[entry.kind], entry.detail].filter(Boolean).join(' · ');
    const title = clientId ? monthLabel(entry.month) : entry.name;
    const owner = !clientId && entry.owners.length === 1 ? entry.owners[0] : null;
    return line(title, information, totals(entry.values), owner ? () => openClient(owner) : null);
  }

  function sourceOperations() {
    const entries = ledgerRows(state(), { period: month });
    if (!entries.length) return null;
    return group('Строки из бухгалтерии', ...Object.entries({ ...A.BLOCKS, expenses: 'Расходы' }).map(([block, label]) => {
      const group = entries.filter(entry => entry.block === block);
      return group.length && section(`${label} · ${group.length}`, `ledger-${month}-${block}`, group.map(entry => sourceLine(entry)));
    }));
  }

  function lastPayment(clientId, imported, history) {
    const archive = imported.filter(entry => entry.kind === 'payment' && entry.date).sort((a,b) => b.date.localeCompare(a.date))[0];
    const manual = history.find(entry => entry.kind === 'payment' && !entry.voided);
    if (manual && (!archive || manual.date >= archive.date)) {
      const part = manual.allocations.filter(item => findService(item.serviceId).clientId === clientId).reduce((sum, item) => sum + item.part, 0);
      return line('Последняя оплата', formatDate(manual.date), A.money(part, manual.currency));
    }
    return archive && line('Последняя оплата по таблице', formatDate(archive.date) + ' · ' + archive.date.slice(0,4), totals(archive.values));
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

  function page() {
    const period = input('month', month);
    period.setAttribute('aria-label', 'Месяц учёта');
    period.className = 'account-month';
    period.addEventListener('change', () => { if (period.value) month = period.value; render(); });
    const tabs = el('div', null, 'segmented');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Раздел учёта');
    for (const [key, label] of [['summary', 'Сводка'], ['operations', 'Операции'], ['movement', 'Движение']]) {
      const control = button(label, () => { tab = key; render(); });
      control.setAttribute('aria-pressed', String(tab === key));
      tabs.append(control);
    }
    const page = append(el('div', null, 'stack-lg'), append(el('div', null, 'row between'), el('h1', 'Учёт'), period),
      row(button('Быстрая запись', quickClientPicker, 'primary')), tabs);
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
    const services = A.clientServices(state(), client.id);
    const active = services.filter(s => !s.oneOff && client.status === 'Активный' && A.activeService(s, today()));
    const unpaidVisits = services.filter(s=>s.oneOff).map(s=>({service:s,debt:-A.serviceBalance(state(),s.id).balance})).filter(x=>x.debt>0);
    const history = A.operations(state(), { clientId: client.id, includeVoided: true });
    const imported = ledgerRows(state(), { clientId: client.id });
    const tariffLine = s => line(serviceTitle(s), [isMonthly(s) ? 'Оплата ' + s.day + '-го' : s.place,
      s.startsOn > today() ? 'С ' + formatDate(s.startsOn) : '', s.note].filter(Boolean).join(' · '),
      A.money(s.rate, s.currency) + (isMonthly(s) ? ' / мес.' : ' / зан.'), () => editService(client.id, s));
    const currentStatus = s => {
      let status, value;
      if (isMonthly(s)) {
        const period = today().slice(0, 7);
        const charge = client.status === 'Активный' && A.monthlyCharge(state(), s, period);
        if (!charge) return null;
        if (s.coveredThrough && period <= s.coveredThrough) status = 'Оплачено по ' + monthLabel(s.coveredThrough);
        else if (!charge.remaining) status = monthLabel(period) + ' · оплачено';
        else if (importedPayment(s, period)) status = monthLabel(period) + ' · есть запись в бухгалтерии';
        else {
          status = monthLabel(period) + ' · к оплате';
          value = A.money(charge.remaining, s.currency);
        }
      } else {
        const { balance, used } = A.serviceBalance(state(), s.id);
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
      return append(el('div', null, 'account-client-status'), line(serviceCaption(s), status, value));
    };
    const actions = quickOptions(client.id, active);
    const primary = actions[0];
    const actionButton = (action, style) => button(action.label + (active.length > 1 ? ' · ' + serviceCaption(action.service) : ''),
      () => quickEntry(client.id, action), style);
    const journal = clientHistory(history, client.id);
    const previous = services.filter(s => !s.oneOff && !active.includes(s));
    const panel=section('Оплаты и занятия', `${client.id}-account`, [
      client.billingNote && text(client.billingNote),
      ...active.map(currentStatus), !active.length && !client.billingNote && text(previous.length ? 'Нет действующих услуг' : 'Тарифы пока не заданы'),
      ...unpaidVisits.map(({service,debt})=>line(serviceCaption(service),formatDate(history.find(s=>s.kind==='session'&&s.serviceId===service.id)?.date||service.startsOn)+' · К оплате',
        A.money(debt,service.currency),()=>editPayment({clientId:client.id,serviceId:service.id,suggested:debt}))),
      primary && actionButton(primary, 'primary account-main-action'),
      actions.length > 1 && section('Другие действия', `${client.id}-account-actions`, actions.slice(1).map(action => actionButton(action, 'account-extra-action'))),
      section('Тарифы' + (active.length ? ' · ' + active.length : ''), `${client.id}-tariffs`, [
        ...active.map(tariffLine), previous.length && section('Другие периоды', `${client.id}-past-services`, previous.map(tariffLine)),
        button('Добавить услугу', () => editService(client.id), 'subtle')
      ]),
      previous.length && button('Оплата за прошлую услугу', () => editPayment({ clientId:client.id }), 'subtle'),
      (imported.length || history.length) && section('История оплат и занятий', `${client.id}-account-history`, [
        lastPayment(client.id, imported, history), ...journal,
        imported.length && section('Из бухгалтерии 2026 · ' + imported.length, `${client.id}-source-history`, imported.map(entry => sourceLine(entry, client.id)))
      ])
    ]);
    panel.classList.add('client-accounting');
    return panel;
  }

  function clientHistory(history, clientId) {
    const byId = new Map(history.map(operation => [operation.id, operation]));
    const pairs = new Map();
    const pairedSessions = new Set();
    for (const payment of history) {
      const session = byId.get(payment.sessionId);
      const allocation = payment.allocations?.[0];
      if (!session || session.kind !== 'session' || payment.kind !== 'payment' || payment.voided || session.voided
          || pairedSessions.has(session.id) || payment.date !== session.date || payment.currency !== session.currency
          || payment.allocations.length !== 1 || allocation?.serviceId !== session.serviceId || payment.amount !== session.amount) continue;
      pairs.set(payment.id, session);
      pairedSessions.add(session.id);
    }
    return history.filter(item => !pairedSessions.has(item.id)).map(item => {
      const session = pairs.get(item.id);
      if (!session) return operationLine(item, clientId);
      return section('Занятие и оплата · ' + formatDate(session.date) + ' · ' + A.money(item.amount, item.currency),
        `account-pair-${session.id}`, [operationLine(session, clientId), operationLine(item, clientId)]);
    });
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

  return { page, clientPanel, remindersPanel, todoItems, settingsPanel, quickEntry, quickOptions, assistantVisit, activeClientIds, resumeClient };
}
