import * as A from './accounting.js';
import { localDate } from './model-utils.js';

const today = () => localDate();
const currencyOptions = A.CURRENCIES.map(c => [c, ({ RSD: 'RSD · динары', RUB: 'RUB · рубли', EUR: 'EUR · евро', USD: 'USD · доллары' })[c]]);
const totals = amounts => A.CURRENCIES.filter(c => c in amounts).map(c => A.money(amounts[c], c)).join(' · ') || '—';
const monthLabel = month => new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(month + '-15T12:00:00Z')).replace(/\s*г\.$/, '');
const isMonthly = service => service.kind !== 'personal';

export function createAccountingUI({ state, el, append, button, row, field, input, select, text, section, modal, commit, render, formatDate, openClient, navigate, message }) {
  let month = today().slice(0, 7);
  let tab = 'summary';
  const book = () => A.accounting(state());
  const findService = id => book().services[id];
  const serviceTitle = s => A.SERVICES[s.kind];
  const clientName = id => state().clients[id]?.name || 'Клиент';

  function line(title, detail = '', value = '', action) {
    const item = action ? button('', action, 'account-line account-link') : el('div', null, 'account-line');
    const heading = append(el('span', null, 'account-label'), el('span', title), detail && el('small', detail));
    return append(item, heading, value && el('span', value, 'account-value'));
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

  function numberInput(value, min, max) {
    const control = input('number', value);
    control.min = min;
    control.max = max;
    control.step = '1';
    return control;
  }

  function memo(label, value = '') {
    const control = input('text', value);
    control.maxLength = 300;
    return [field(label, control), control];
  }

  function editService(clientId, existing) {
    const client = state().clients[clientId];
    modal(existing ? 'Условия услуги' : 'Добавить услугу', form => {
      const initial = client.group === 'Да' ? 'belgrade' : ['gym', 'outside'].includes(client.personal) ? 'personal' : 'coaching';
      const kind = select(Object.entries(A.SERVICES), existing?.kind || initial);
      const defaultBlock = type => ({ online: 'online', personal: 'personal', coaching: client.format === 'Дистанционно' ? 'online' : 'belgrade', belgrade: 'belgrade' })[type];
      const block = select(Object.entries(A.BLOCKS), existing?.block || defaultBlock(kind.value));
      const starts = dateInput(existing?.startsOn || today(), false);
      const ends = dateInput(existing?.endsOn || '', false);
      const currency = select(currencyOptions, existing?.currency || (block.value === 'online' ? 'RUB' : 'RSD'));
      const rate = moneyInput(existing?.rate);
      const day = numberInput(existing?.day ?? Number(starts.value.slice(-2)), 1, 31);
      const place = select(A.PLACES, existing?.place || (client.personal === 'outside' ? 'Улица' : 'Зал'));
      const reminder = input('checkbox');
      reminder.checked = existing?.reminder ?? true;
      const monthlyFields = append(el('div', null, 'stack'), field('День оплаты', day), append(el('label', null, 'checkbox'), reminder, el('span', 'Напоминать в ToDo')));
      const placeField = field('Обычное место занятия', place);
      const rateLabel = el('span');
      const sync = () => {
        const personal = kind.value === 'personal';
        monthlyFields.hidden = personal;
        placeField.hidden = !personal;
        rateLabel.textContent = personal ? 'Ставка за занятие' : 'Тариф за месяц';
      };
      kind.addEventListener('change', () => {
        block.value = defaultBlock(kind.value);
        currency.value = block.value === 'online' ? 'RUB' : 'RSD';
        sync();
      });
      sync();
      append(form, field('Услуга', kind), field('Раздел отчёта', block), append(el('div', null, 'account-fields'), field('Действует с', starts), field('Последний день', ends)),
        append(el('div', null, 'account-fields'), append(el('label'), rateLabel, rate), field('Валюта тарифа', currency)), monthlyFields, placeField);
      return async () => {
        const personal = kind.value === 'personal';
        if (!personal && !day.value) throw Error('Укажи день оплаты');
        const values = {
          clientId, kind: kind.value, block: block.value, startsOn: starts.value, endsOn: ends.value || null,
          currency: currency.value, rate: A.amountMinor(rate.value), day: personal ? null : Number(day.value),
          reminder: !personal && reminder.checked, place: personal ? place.value : null
        };
        await commit(s => A.saveService(s, values, existing?.id));
      };
    });
  }

  function choices(clientId, onlyPersonal = false) {
    return Object.values(book().services).filter(s => (!clientId || clientId === s.clientId) && (!onlyPersonal || !isMonthly(s)))
      .sort((a, b) => Number(A.activeService(b, today())) - Number(A.activeService(a, today())) || clientName(a.clientId).localeCompare(clientName(b.clientId), 'ru') || b.startsOn.localeCompare(a.startsOn));
  }

  function serviceOptions(list, showClient) {
    return [['', 'Выбрать услугу'], ...list.map(s => [s.id,
      `${showClient ? clientName(s.clientId) + ' · ' : ''}${serviceTitle(s)} · с ${formatDate(s.startsOn)}${s.endsOn ? ' · завершена ' + formatDate(s.endsOn) : ''}`])];
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

  function editPayment({ clientId, serviceId, period, suggested, existing, fromAccount = false } = {}) {
    const all = choices();
    const own = clientId ? choices(clientId) : all;
    if (!own.length && !existing) return noService(clientId);
    const seed = existing?.allocations[0]?.serviceId || serviceId || (clientId && own.length === 1 ? own[0].id : '');
    modal(existing ? 'Редактировать оплату' : 'Записать оплату', form => {
      const date = dateInput(existing?.date || today());
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
        return saveEntry({ kind: 'payment', date: recordedDate(date), amount: full, currency: currency.value, payer: payer.value.trim(), note: note.value.trim(), allocations: values }, existing, fromAccount);
      };
    });
  }

  function editSession({ clientId, serviceId, existing, fromAccount = false } = {}) {
    const list = choices(clientId, true);
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

  function summary() {
    const summary = A.summarize(state(), month);
    const metrics = append(el('div', null, 'panel stack'), text('Получено за месяц'), el('h2', totals(summary.receipts), 'account-total'));
    const byService = group('По услугам', ...Object.entries(A.SERVICES).map(([key, label]) => line(label, '', totals(summary.services[key] || {}))));
    const byBlock = section('Итоги по блокам', 'account-totals', [
      ...Object.entries(A.BLOCKS).map(([key, label]) => line(label, 'Поступления', totals(summary.blocks[key] || {}))),
      line('Расходы', '', totals(summary.expenses)), line('Остаток по Белграду и персональным', '', totals(summary.localBalance))
    ]);
    return [metrics, byService, group('Персональные занятия', line(`Проведено · ${summary.count}`, 'Стоимость проведённых занятий', totals(summary.sessions))), remindersPanel(3, month), byBlock];
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
      row(button('+ Оплата', () => editPayment({ fromAccount: true }), 'primary'), button('+ Занятие', () => editSession({ fromAccount: true }))), tabs);
    if (tab === 'summary') {
      if (!choices().length) page.append(text('Начни с услуги в карточке клиента. Укажи тариф и день оплаты для напоминаний в ToDo.'), row(button('К клиентам', () => navigate('#clients'), 'subtle')));
      append(page, ...summary());
    } else if (tab === 'operations') {
      const entries = A.operations(state(), { month, includeVoided: true });
      append(page, row(button('+ Расход', () => editExpense())), group('Операции за месяц', ...(entries.length ? entries.map(o => operationLine(o)) : [text('Операций пока нет')])));
    } else append(page, ...movement());
    return page;
  }

  function clientPanel(client) {
    const services = A.clientServices(state(), client.id);
    const active = services.filter(s => A.activeService(s, today()));
    const history = A.operations(state(), { clientId: client.id, includeVoided: true });
    const serviceLine = s => {
      const detail = `${A.BLOCKS[s.block]} · ${isMonthly(s) ? 'оплата ' + s.day + '-го' : s.place}`;
      const serviceRow = line(serviceTitle(s), detail, A.money(s.rate, s.currency), () => editService(client.id, s));
      if (isMonthly(s)) {
        const period = today().slice(0, 7);
        const charge = client.status === 'Активный' && A.monthlyCharge(state(), s, period);
        if (!charge) return serviceRow;
        const status = charge.remaining ? `Срок ${formatDate(charge.due)}` : 'Оплачено';
        return append(el('div', null, 'account-service'), serviceRow,
          line(monthLabel(period), status, charge.remaining ? A.money(charge.remaining, s.currency) : '', charge.remaining
            ? () => editPayment({ clientId: client.id, serviceId: s.id, period, suggested: charge.remaining }) : null));
      }
      const balance = A.serviceBalance(state(), s.id);
      return append(el('div', null, 'account-service'), serviceRow, line(balance.balance < 0 ? 'К оплате за занятия' : 'Остаток аванса',
        `Внесено ${A.money(balance.received, s.currency)} · проведено на ${A.money(balance.used, s.currency)}`, A.money(Math.abs(balance.balance), s.currency)));
    };
    const controls = row(button('+ Оплата', () => editPayment({ clientId: client.id }), 'primary'),
      services.some(s => !isMonthly(s)) && button('+ Занятие', () => editSession({ clientId: client.id })), button('Добавить услугу', () => editService(client.id), 'subtle'));
    const previous = services.filter(s => !active.includes(s));
    return section('Оплаты и занятия', `${client.id}-account`, [
      ...active.map(serviceLine), !services.length && text('Услуги и тарифы пока не заданы.'), controls,
      previous.length && section('Другие периоды услуг', `${client.id}-past-services`, previous.map(serviceLine)),
      history.length && section('История учёта · ' + history.length, `${client.id}-account-history`, history.map(o => operationLine(o, client.id)))
    ]);
  }

  function settingsPanel() {
    const controls = Object.entries(A.BLOCKS).map(([key, name]) => ({ key, control: numberInput(book().reminders[key] ?? A.DEFAULT_REMINDERS[key], 0, 30), name }));
    return append(el('section', null, 'stack settings-section'), el('h2', 'Учёт'),
      text('За сколько дней до срока показывать напоминание в ToDo. Ноль означает день оплаты.'),
      ...controls.map(({ name, control }) => field(name, control)), row(button('Сохранить напоминания', async () => {
        if (controls.some(({ control }) => !control.value.trim())) throw Error('Укажи число дней для каждого раздела');
        await commit(s => A.saveReminders(s, Object.fromEntries(controls.map(({ key, control }) => [key, Number(control.value)]))));
        message('Напоминания сохранены');
      })));
  }

  return { page, clientPanel, remindersPanel, settingsPanel };
}
