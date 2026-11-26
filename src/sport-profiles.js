import {id,localDate,validDate} from './model-utils.js';

export const SPORT_SERVICES={garmin:'Garmin Connect',strava:'Strava',suunto:'Suunto App',coros:'COROS Training Hub',trainingpeaks:'TrainingPeaks'};
export const SPORT_PROFILE_TYPES={profile:'Профиль',coach:'Тренерская карточка',username:'Имя пользователя'};

const profileKey=entry=>entry.service+'|'+(entry.url||entry.username).toLowerCase();
const nonempty=(value,max)=>typeof value==='string'&&value.length<=max&&Boolean(value.trim());

export function sportProfileUrl(service,type,value){
  if(!nonempty(value,400))return '';
  let url;
  try{url=new URL(value.trim());}catch{return '';}
  if(url.protocol!=='https:'||url.username||url.password||url.port)return '';
  if(service==='garmin'&&type==='profile'&&url.hostname==='connect.garmin.com'){
    const match=url.pathname.match(/^\/(?:app|modern)\/profile\/([\w.-]{1,100})\/?$/u);
    if(match&&match[1]!=='.'&&match[1]!=='..')return 'https://connect.garmin.com/app/profile/'+match[1];
  }
  if(service==='strava'&&type==='profile'&&['www.strava.com','strava.com'].includes(url.hostname)){
    const match=url.pathname.match(/^\/athletes\/(\d{1,18})\/?$/u);
    if(match)return 'https://www.strava.com/athletes/'+match[1];
  }
  if(service==='trainingpeaks'&&type==='coach'&&url.hostname==='app.trainingpeaks.com'&&url.pathname==='/'){
    const match=url.hash.match(/^#calendar\/athletes\/(\d{1,16})\/?$/u);
    if(match)return 'https://app.trainingpeaks.com/#calendar/athletes/'+match[1];
  }
  return '';
}

function entryValues({service,type,url,username,source,checkedOn}){
  if(!Object.hasOwn(SPORT_SERVICES,service)||!Object.hasOwn(SPORT_PROFILE_TYPES,type))
    throw Error('Выбери сервис и тип профиля');
  if(!nonempty(source,200)||!validDate(checkedOn)||checkedOn>localDate())
    throw Error('Укажи источник и дату проверки');
  const common={service,type,source:source.trim(),checkedOn};
  if(type==='username'){
    const value=String(username??'').trim().replace(/^@/u,'').normalize('NFC');
    if(!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,79}$/u.test(value)||url)
      throw Error('Укажи имя пользователя без ссылки');
    return {...common,username:value};
  }
  const address=sportProfileUrl(service,type,url);
  if(!address||username)throw Error('Укажи прямую ссылку на профиль или тренерскую карточку');
  return {...common,url:address};
}

export function validateSportProfiles(state){
  const used=new Set();
  for(const client of Object.values(state.clients)){
    const entries=client.sportProfiles;
    if(entries===undefined)continue;
    if(!Array.isArray(entries)||entries.length>30)throw Error('Некорректный список спортивных профилей');
    const ids=new Set();
    for(const entry of entries){
      if(!entry||typeof entry.id!=='string'||!/^[-\w]{1,100}$/u.test(entry.id)||ids.has(entry.id))
        throw Error('Некорректная запись спортивного профиля');
      ids.add(entry.id);
      const values=entryValues(entry);
      if(values.url!==entry.url||values.username!==entry.username)throw Error('Некорректный адрес спортивного профиля');
      if(client.mergedInto)continue;
      const key=profileKey(values);
      if(used.has(key))throw Error('Спортивный профиль уже указан в другой записи');
      used.add(key);
    }
  }
}

export function saveSportProfile(state,clientId,values,entryId){
  const client=state.clients[clientId];
  if(client?.role!=='Клиент'||client.mergedInto)throw Error('Карточка спортсмена не найдена');
  const entries=client.sportProfiles??[];
  if(entryId&&!entries.some(entry=>entry.id===entryId))throw Error('Запись уже изменилась');
  const entry={id:entryId??id('sport-profile'),...entryValues(values)};
  const duplicate=Object.values(state.clients).some(other=>!other.mergedInto&&
    other.sportProfiles?.some(old=>(other.id!==clientId||old.id!==entry.id)&&profileKey(old)===profileKey(entry)));
  if(duplicate)throw Error('Этот спортивный профиль уже указан');
  const next=entryId?entries.map(old=>old.id===entryId?entry:old):[...entries,entry];
  if(next.length>30)throw Error('Достигнут предел спортивных профилей');
  client.sportProfiles=next;
  return entry;
}

export function removeSportProfile(state,clientId,entryId){
  const client=state.clients[clientId];
  if(!client?.sportProfiles?.some(entry=>entry.id===entryId)||client.mergedInto)
    throw Error('Запись уже изменилась');
  const entries=client.sportProfiles.filter(entry=>entry.id!==entryId);
  if(entries.length)client.sportProfiles=entries;
  else delete client.sportProfiles;
}
