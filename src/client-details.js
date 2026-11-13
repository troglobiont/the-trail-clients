import { addDays, localDate, validDate } from './model-utils.js';

export const GOAL_TYPES = { race:'Старт', activity:'Активность и привычки', weight:'Вес', social:'Общение', camp:'Кемп', other:'Другое' };
export const RACE_STAGES = { choosing:'Подбираем старт', selected:'Старт выбран', registered:'Зарегистрирован' };
const optional = (v, limit) => typeof v === 'string' && v.length <= limit;
const idKey = value => typeof value === 'string' && /^race-[\p{L}\p{N}-]{1,130}$/u.test(value);
export const telegramUsername = value => /^[a-z][a-z0-9_]{4,31}$/i.test(value || '');
export const telegramPeer = value => /^[1-9]\d{0,18}$/.test(value || '');

export function telegramLink(binding) {
  return telegramUsername(binding?.username) ? 'https://t.me/' + binding.username : '';
}

export function birthdayValid(birthday) {
  return !birthday || /^\d{2}-\d{2}$/.test(birthday) && validDate('2000-' + birthday)
    || /^\d{4}-\d{2}-\d{2}$/.test(birthday) && validDate(birthday);
}

export function setProfile(client, values) {
  const data = {};
  for (const [key,max] of Object.entries({ phone:40, secondPhone:40, email:180, telegram:40, instagram:80, city:120, profession:160, birthday:10 })) {
    const value = String(values[key] || '').trim();
    if (!optional(value,max)) throw Error('Слишком длинное значение');
    if (value) data[key] = value;
  }
  if (!birthdayValid(data.birthday)) throw Error('Проверь дату рождения');
  for (const number of [data.phone,data.secondPhone]) if (number && !/^\+[1-9][0-9 ()-]{5,29}$/.test(number)) throw Error('Укажи телефон с кодом страны, например +381');
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw Error('Проверь email');
  client.profile = data;
}

export function birthdayReminders(state, today = localDate(), days = 14) {
  const horizon = addDays(today,days), output = [];
  for (const client of Object.values(state.clients)) {
    const birthday = client.profile?.birthday;
    if (!birthday || !birthdayValid(birthday) || client.mergedInto || !['Активный','На паузе'].includes(client.status) && client.role === 'Клиент') continue;
    const monthDay = birthday.slice(-5);
    for (let year = Number(today.slice(0,4)); year <= Number(horizon.slice(0,4)); year++) {
      const day = year + '-' + monthDay;
      if (validDate(day) && today <= day && day <= horizon) output.push({ client, day });
    }
  }
  return output.sort((a,b) => a.day.localeCompare(b.day) || a.client.name.localeCompare(b.client.name,'ru'));
}

export function telegramReminders(state, today = localDate()) {
  return Object.values(state.clients).flatMap(client => {
    const { days, since } = client.telegramCheck || {};
    if (!Number.isInteger(days) || days < 1 || days > 365 || !validDate(since) || !client.telegram?.peerId
        || client.mergedInto || client.status !== 'Активный' || client.role !== 'Клиент') return [];
    const opened = client.telegramOpenedAt ? localDate(new Date(client.telegramOpenedAt)) : since;
    const day = addDays(opened > since ? opened : since,days);
    return day <= today ? [{ client, day }] : [];
  });
}

export function setTraining(client, values) {
  const data = {};
  const limits = { height:[30,300], weight:[10,500], maxHr:[30,250], restHr:[20,160], lthr:[30,250] };
  for (const [key,[min,max]] of Object.entries(limits)) {
    if (values[key] === '' || values[key] == null) continue;
    const value = Number(values[key]);
    if (!Number.isFinite(value) || value < min || value > max || (key.endsWith('Hr') || key === 'lthr') && !Number.isInteger(value)) throw Error('Проверь числовые данные тренировки');
    data[key] = value;
  }
  if (values.date && !validDate(values.date)) throw Error('Проверь дату');
  if (values.date) data.date = values.date;
  if (values.status) data.status = values.status;
  if (values.source) data.source = String(values.source).trim().slice(0,180);
  client.training = data;
}

// A race definition is a durable event, so it uses the existing sync and backup format.
export function raceCatalog(state) {
  const races = new Map();
  for (const event of state.events) if (event.type === 'race-defined' && event.race) races.set(event.race.id,event.race);
  return [...races.values()].sort((a,b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name,'ru'));
}

export function raceDefinition(values) {
  const name = String(values.name || '').trim().replace(/\s+/g,' ');
  const date = values.date;
  const slug = name.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'');
  if (!slug || name.length > 120 || !validDate(date)) throw Error('Укажи название и дату старта');
  return { id:'race-' + date + '-' + slug.slice(0,115), name, date };
}

export function raceGoal(state, values) {
  const type = values.type || '';
  if (type && !Object.hasOwn(GOAL_TYPES,type)) throw Error('Проверь тип цели');
  if (type !== 'race') return { type:type || null, raceStage:null, raceId:null, distance:null };
  const raceStage = values.raceStage || 'choosing', raceId = values.raceId || null;
  const distance = String(values.distance || '').trim();
  if (!Object.hasOwn(RACE_STAGES,raceStage) || distance.length > 45) throw Error('Проверь параметры старта');
  if (raceId && (!idKey(raceId) || !raceCatalog(state).some(r => r.id === raceId))) throw Error('Выбери старт из списка');
  if (!raceId && raceStage !== 'choosing') throw Error('Выбери конкретный старт');
  return { type, raceStage, raceId, distance:distance || null };
}

export function raceParticipants(state, raceId, distance = '') {
  const byClient = new Map();
  for (const goal of Object.values(state.goals)) {
    const client = state.clients[goal.clientId];
    if (!client || client.mergedInto || goal.deletedAt || goal.raceId !== raceId
        || !['selected','registered'].includes(goal.raceStage)
        || !['Желание клиента','Согласовано'].includes(goal.status)
        || distance && goal.distance !== distance) continue;
    const existing = byClient.get(client.id);
    if (!existing || goal.raceStage === 'registered' && existing.raceStage !== 'registered') byClient.set(client.id, goal);
  }
  return [...byClient.values()].sort((a,b) => state.clients[a.clientId].name.localeCompare(state.clients[b.clientId].name,'ru'));
}
