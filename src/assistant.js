import { normalizeSearch } from './core.js';

const words = value => value.toLowerCase().normalize('NFC').match(/\p{L}+/gu) || [];
const declinedEndings = [
  [/([сц]к)ая$/u, ['ой', 'ую', 'ою']],
  [/([сц]к)[иы]й$/u, ['ого', 'ому', 'им', 'ом']],
  [/([ое]в|ин)а$/u, ['ой', 'у', 'ою', 'е']],
  [/([ое]в|ин)$/u, ['а', 'у', 'ым', 'е']]
];

function nameForms(word) {
  const forms = [word];
  for (const [ending, suffixes] of declinedEndings) {
    if (ending.test(word)) {
      forms.push(...suffixes.map(suffix => word.replace(ending, (_, stem) => stem + suffix)));
      break;
    }
  }
  return forms.map(normalizeSearch);
}

function oneEditApart(first, second) {
  if (first.length > second.length) return oneEditApart(second, first);
  if (second.length - first.length > 1 || first === second) return false;
  let offset = 0;
  while (offset < first.length && first[offset] === second[offset]) offset++;
  return first.slice(offset + Number(first.length === second.length)) === second.slice(offset + 1);
}

export function suggestAssistantClients(transcript, clients) {
  const tokens = words(transcript);
  const spoken = new Set(tokens.map(normalizeSearch));
  const split = new Set(tokens.flatMap((token, index) =>
    /^[а-яё]$/u.test(token) && /^\p{L}{5,}$/u.test(tokens[index + 1] || '')
      ? [normalizeSearch(token + tokens[index + 1])] : []
  ));
  const plausible = [...new Set([...spoken, ...split])].filter(token => token.length >= 7);
  const exact = [];
  const approximate = [];
  for (const client of clients) {
    if (client.mergedInto) continue;
    let matches = 0;
    let close = false;
    for (const alias of [client.name, ...(client.aliases || [])]) {
      let score = 0;
      for (const part of new Set(words(alias))) {
        if (part.length < 3) continue;
        const forms = nameForms(part);
        if (forms.some(form => spoken.has(form))) score++;
        else if (part.length >= 6 && forms.some(form => split.has(form) || plausible.some(token => oneEditApart(form, token)))) close = true;
      }
      matches = Math.max(matches, score);
    }
    if (matches) exact.push({ id:client.id, matches });
    else if (close) approximate.push(client.id);
  }
  const best = Math.max(0, ...exact.map(candidate => candidate.matches));
  const strong = exact.filter(candidate => candidate.matches === best).map(candidate => candidate.id);
  return {
    selected: strong.length === 1 && (best > 1 || !approximate.length) ? strong[0] : '',
    suggestions: strong.length > 1 || best < 2 ? [...strong, ...approximate] : strong
  };
}

export function assistantKind(value) {
  if (/спросить|напомни|проверить|узнать|написать|попросить|поставь задачу/iu.test(value)
    || /(?:нужно|надо|необходимо|долж\p{L}*|предстоит)\s+оплатить/iu.test(value)) return 'task';
  if (/не\s+оплатил\p{L}*/iu.test(value)) return 'record';
  if (/оплатил\p{L}*|получил[аи]?\s|вн[её]с|аванс|(?:запиши|зафиксируй)\s+оплату/iu.test(value)) return 'payment';
  if (/пров[её]л|занятие прошло|записать занятие/iu.test(value)) return 'session';
  if (/цель|хочет/iu.test(value)) return 'goal';
  return 'record';
}
