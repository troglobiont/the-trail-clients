// Supabase Edge Function `trail-calendar`, scoped to the configured club calendar.
// Google credentials stay in server secrets; callers use their existing app login.
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Content-Type':'application/json'};
const fields = 'id,summary,start,end,location,status,colorId,description,extendedProperties,recurringEventId,recurrence,attendees(self),etag';
const encoder = new TextEncoder();
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,'');
const encodeJSON = value => base64url(encoder.encode(JSON.stringify(value)));
const zone='Europe/Belgrade';
const localFormat=new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const localStamp=value=>localFormat.format(new Date(value)).replace(' ','T');
const dayShift=(day,days)=>new Date(Date.parse(day)+days*86400000).toISOString().slice(0,10);
const changeError=(status,message)=>Object.assign(Error(message),{status,calendarAction:true});
const draftLine='Статус назначения: предварительное';
const approvedLine='Статус назначения: утверждено';
const colorForCoach=name=>{
  const words=name.toLocaleLowerCase('ru').split(/\s+/u);
  return words.includes('алексей')?'6':words.includes('сергей')?'10':undefined;
};
function staffingFields(place,coach,status,description=''){
  const note=description.split('\n').filter(line=>line!==draftLine&&line!==approvedLine&&!/^Тип: групповая тренировка\. Тренер: .*\.$/u.test(line)).join('\n').trim();
  return {summary:'Группа · '+place+' · '+coach,
    description:['Тип: групповая тренировка. Тренер: '+coach+'.',status==='draft'?draftLine:status==='approved'?approvedLine:'',note].filter(Boolean).join('\n')};
}

function localInstant(stamp) {
  let time = Date.parse(stamp+'Z');
  const target = time;
  for (let i=0;i<3;i++) {
    const difference = target-Date.parse(localStamp(time)+'Z');
    time += difference;
    if (!difference)return time;
  }
  throw changeError(400,'В это время часы переводятся. Выбери другое время.');
}
const midnight=day=>new Date(localInstant(day+'T00:00:00')).toISOString();

function timedFields(day,time,duration){
  const stamp=day+'T'+time;
  const start=localInstant(stamp);
  if(localStamp(start-3600000)===stamp||localStamp(start+3600000)===stamp)
    throw changeError(400,'В это время часы переводятся. Выбери другое время.');
  const field=value=>({dateTime:new Date(value).toISOString(),timeZone:zone});
  return {start:field(start),end:field(start+duration)};
}

export function calendarRange({from,to}) {
  for (const day of [from,to]) if (typeof day!=='string' || !/^\d{4}-\d{2}-\d{2}$/u.test(day)
      || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0,10)!==day) throw Error('Проверь даты расписания');
  const days = (Date.parse(to)-Date.parse(from))/86400000;
  if (days<=0 || days>31) throw Error('Выбери период не длиннее месяца');
  return {timeMin:midnight(from),timeMax:midnight(to)};
}

export function calendarEvent(raw,calendar,includeGroups=false) {
  const title = raw.summary?.trim() || '';
  const group = includeGroups && title.match(/^группа\s*·\s*([^·]+?)\s*·\s*([^·]+)$/iu);
  if (raw.status==='cancelled' || !raw.id || !Number.isFinite(Date.parse(raw.start?.dateTime))
      || !Number.isFinite(Date.parse(raw.end?.dateTime))) return null;
  if (!group && !/^персональная\s*·[^·]+·\s*сергей$/iu.test(title)) return null;
  const eid = base64url(encoder.encode(raw.id+' '+calendar));
  const url='https://calendar.google.com/calendar/event?eid='+eid;
  if (group) return {id:raw.id,title,start:raw.start.dateTime,end:raw.end.dateTime,location:raw.location||group[1].trim(),
    kind:'group',coachName:group[2].trim(),rosterCoachName:raw.extendedProperties?.private?.trailRosterCoach||group[2].trim(),
    ...(raw.description?.split('\n').includes(draftLine)&&{assignmentStatus:'draft'}),
    ...(raw.description?.split('\n').includes(approvedLine)&&{assignmentStatus:'approved'}),
    ...(raw.colorId&&{colorId:raw.colorId}),
    canEdit:Boolean(raw.etag&&!raw.recurrence),url};
  return {id:raw.id,title,start:raw.start.dateTime,end:raw.end.dateTime,location:raw.location||'',
    clientId:raw.extendedProperties?.private?.trailClientId || null,
    canEdit:Boolean(raw.etag && !raw.recurrence),canAlign:!Boolean(raw.attendees?.length || raw.recurringEventId || raw.recurrence),
    url};
}

const slot=({start,location})=>localStamp(start)+'|'+location.trim().toLowerCase().replace(/\s+/gu,' ');
const label=value=>typeof value==='string'&&/^[^·\r\n]{1,180}$/u.test(value)&&Boolean(value.trim());
const eventId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,300}$/u.test(value);

async function copyGroupWeek({input,calendarId,list,google,now}){
  const {from,coaches=[]}=input;
  try{calendarRange({from,to:dayShift(from,7)});}
  catch{throw changeError(400,'Проверь неделю расписания');}
  if(new Date(from+'T12:00:00Z').getUTCDay()!==1||from<=localStamp(now()).slice(0,10))
    throw changeError(400,'Выбери будущую неделю, начиная с понедельника');
  if(!Array.isArray(coaches)||coaches.length>40||coaches.some(item=>!eventId(item?.id)||!label(item.coachName)
      ||item.status!==undefined&&!['draft','approved'].includes(item.status)))
    throw changeError(400,'Проверь список ответственных тренеров');
  const coachAssignments=new Map(coaches.map(item=>[item.id,item]));
  const [previous,target]=await Promise.all([list(dayShift(from,-7),from,true),list(from,dayShift(from,7),true)]);
  const groups=previous.filter(e=>e.kind==='group'&&localStamp(e.start).slice(0,10)>=dayShift(from,-7));
  if(groups.length>40)throw changeError(400,'В предыдущей неделе больше 40 групповых встреч');
  if(groups.length){
    const access=await google('',{maxResults:'1',fields:'accessRole'},{write:true});
    if(access.status===403||access.ok&&!['writer','owner'].includes((await access.json()).accessRole))
      throw changeError(403,'У календаря клуба пока нет разрешения на изменение событий');
    if(!access.ok)throw Error('Calendar write access check failed');
  }
  const occupied=new Set(target.filter(e=>e.kind==='group').map(slot));
  const result={created:0,skipped:0,failed:0,sourceCount:groups.length};
  const copies=[];
  for(const group of groups){
    try{
      const start=localStamp(group.start),day=dayShift(start.slice(0,10),7);
      const duration=Date.parse(group.end)-Date.parse(group.start);
      if(duration<=0)throw Error('Invalid duration');
      const timing=timedFields(day,start.slice(11),duration);
      const position=slot({start:timing.start.dateTime,location:group.location});
      if(occupied.has(position)){result.skipped++;continue;}
      occupied.add(position);
      const bytes=await crypto.subtle.digest('SHA-256',encoder.encode(calendarId+'\n'+from+'\n'+group.id));
      const id=Array.from(new Uint8Array(bytes).slice(0,20),b=>b.toString(16).padStart(2,'0')).join('');
      const assignment=coachAssignments.get(group.id);
      const coach=assignment?.coachName.trim()||group.coachName;
      const status=assignment?.status||group.assignmentStatus;
      const colorId=colorForCoach(coach)??(coach===group.coachName?group.colorId:undefined);
      copies.push({id,...staffingFields(group.title.split('·')[1].trim(),coach,status),...(colorId&&{colorId}),location:group.location,
        ...timing,extendedProperties:{private:{trailGroupCopy:from,trailRosterCoach:group.rosterCoachName}}});
    }catch{result.failed++;}
  }
  for(let index=0;index<copies.length;index+=4){
    await Promise.all(copies.slice(index,index+4).map(async body=>{
      try{
        const answer=await google('',{sendUpdates:'none',fields:'id'},{method:'POST',body,write:true});
        if(answer.ok){result.created++;return;}
        if(answer.status===409){
          const existing=await google('/'+body.id,{fields:'id,status,extendedProperties'});
          if(existing.status===410){result.skipped++;return;}
          if(existing.ok){
            const raw=await existing.json();
            if(raw.status==='cancelled'||raw.extendedProperties?.private?.trailGroupCopy===from){result.skipped++;return;}
          }
        }
        result.failed++;
      }catch{result.failed++;}
    }));
  }
  return result;
}

async function editGroupEvent({input,calendarId,google,now}){
  const {action,id,expected}=input;
  if(!eventId(id)||!expected)throw changeError(400,'Не найдена групповая тренировка');
  const path='/'+encodeURIComponent(id);
  const response=await google(path,{fields});
  const conflict=()=>changeError(409,'Встреча изменилась в Google Календаре. Обнови расписание.');
  if(action==='cancel-group'&&[404,410].includes(response.status))return {cancelled:true};
  if([404,410].includes(response.status))throw conflict();
  if(!response.ok)throw Error('Calendar request failed');
  const raw=await response.json();
  const current=calendarEvent(raw,calendarId,true);
  if(action==='cancel-group'&&raw.status==='cancelled')return {cancelled:true};
  if(current?.kind!=='group'||!current.canEdit||Date.parse(current.start)<=now())
    throw changeError(409,'Можно изменить только предстоящую групповую встречу');
  const duration=Date.parse(current.end)-Date.parse(current.start);
  let body;
  if(action==='move-group'){
    try{calendarRange({from:input.day,to:dayShift(input.day,1)});}
    catch{throw changeError(400,'Проверь дату тренировки');}
    if(typeof input.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/u.test(input.time))
      throw changeError(400,'Проверь время тренировки');
    body=timedFields(input.day,input.time+':00',duration);
    if(Date.parse(body.start.dateTime)<=now())throw changeError(400,'Выбери дату и время в будущем');
    if(Date.parse(body.start.dateTime)===Date.parse(current.start))return {event:current};
  }
  if(action==='assign-group'){
    if(!label(input.coachName)||!['draft','approved'].includes(input.status))
      throw changeError(400,'Проверь тренера и статус назначения');
    const coach=input.coachName.trim();
    body=staffingFields(current.title.split('·')[1].trim(),coach,input.status,raw.description);
    const colorId=colorForCoach(coach);
    if(colorId)body.colorId=colorId;
    else if(coach!==current.coachName)body.colorId=null;
    body.extendedProperties={private:{...raw.extendedProperties?.private,trailRosterCoach:current.rosterCoachName}};
    if(current.coachName===coach&&current.assignmentStatus===input.status&&(!colorId||current.colorId===colorId))return {event:current};
  }
  if(['start','end','location'].some(key=>expected[key]!==current[key])
      ||action==='assign-group'&&expected.coachName!==current.coachName)throw conflict();
  const changed=await google(path,{sendUpdates:'none',...(body&&{fields})},{method:body?'PATCH':'DELETE',body,etag:raw.etag,write:true});
  if(action==='cancel-group'&&[404,410].includes(changed.status))return {cancelled:true};
  if([404,410,412].includes(changed.status))throw conflict();
  if(changed.status===403)throw changeError(403,'У календаря клуба пока нет разрешения на изменение событий');
  if(!changed.ok)throw Error('Calendar write failed');
  return body?{event:calendarEvent(await changed.json(),calendarId,true)}:{cancelled:true};
}

export function createCalendarHandler({env,fetch:request=fetch,now=Date.now}) {
  const tokens=new Map(),renewals=new Map();
  const reply = (status,value) => new Response(JSON.stringify(value),{status,headers:cors});
  const send = (url,options={}) => request(url,{...options,signal:AbortSignal.timeout(15000)});
  async function googleToken(account,write) {
    const token=tokens.get(write);
    if (token?.expires>now()+60000) return token.value;
    if (renewals.has(write)) return renewals.get(write);
    const renewing = (async()=>{
      const issued = Math.floor(now()/1000);
      const claims = {iss:account.client_email,scope:'https://www.googleapis.com/auth/calendar.events'+(write?'':'.readonly'),
        aud:'https://oauth2.googleapis.com/token',iat:issued,exp:issued+3600};
      const unsigned = encodeJSON({alg:'RS256',typ:'JWT'})+'.'+encodeJSON(claims);
      const pem = account.private_key.replace(/-----[^-]+-----|\s/gu,'');
      const bytes = Uint8Array.from(atob(pem),character=>character.charCodeAt(0));
      const key = await crypto.subtle.importKey('pkcs8',bytes,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encoder.encode(unsigned));
      const response = await send('https://oauth2.googleapis.com/token',{method:'POST',
        body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+base64url(new Uint8Array(signature))})});
      if (!response.ok) throw Error('Google Календарь временно недоступен');
      const data = await response.json();
      if (!data.access_token || !Number.isFinite(data.expires_in)) throw Error('Не удалось подключиться к Google Календарю');
      tokens.set(write,{value:data.access_token,expires:now()+data.expires_in*1000});
      return data.access_token;
    })().finally(()=>renewals.delete(write));
    renewals.set(write,renewing);
    return renewing;
  }
  return async request => {
    if (request.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
    if (request.method!=='POST') return reply(405,{error:'Нужен POST-запрос'});
    const authorization = request.headers.get('Authorization');
    if (!/^Bearer [\w.-]+$/u.test(authorization||'')) return reply(401,{error:'Войди в аккаунт приложения'});
    try {
      // PostgREST verifies the JWT and the RPC checks the same allowlist as client sync.
      const access = await send(env('SUPABASE_URL')+'/rest/v1/rpc/trail_calendar_access',{method:'POST',
        headers:{authorization,apikey:env('SUPABASE_ANON_KEY'),'Content-Type':'application/json'},body:'{}'});
      if (access.status===401) return reply(401,{error:'Войди в аккаунт приложения'});
      if (!access.ok) return reply(access.status===403?403:503,{error:'Не удалось проверить доступ к расписанию'});
      if (await access.json()!==true) return reply(403,{error:'Нет доступа к расписанию The.Trail'});
      let input;
      try {
        if (Number(request.headers.get('Content-Length'))>32000) throw Error();
        const body = await request.text();
        if (encoder.encode(body).length>32000) throw Error();
        input=JSON.parse(body);
        if(!input||typeof input!=='object'||Array.isArray(input))throw Error();
        if(input.action===undefined)calendarRange(input);
        else if(!['copy-group-week','move-group','cancel-group','assign-group'].includes(input.action))throw Error();
      } catch { return reply(400,{error:'Проверь даты расписания'}); }
      const settings = env('TRAIL_GOOGLE_CALENDAR');
      if (!settings) return reply(503,{error:'Облачное расписание ещё не подключено'});
      const {account,calendarId} = JSON.parse(settings);
      if (!calendarId || !account?.private_key || !account.client_email) throw Error('Облачный календарь не настроен');
      async function google(path,params,{method='GET',body,etag,write=false}={}){
        const response=await send('https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(calendarId)+'/events'+path+'?'+new URLSearchParams(params),
          {method,headers:{Authorization:'Bearer '+await googleToken(account,write),...(etag&&{'If-Match':etag}),
            ...(body&&{'Content-Type':'application/json'})},...(body&&{body:JSON.stringify(body)})});
        if(response.status===401)tokens.delete(write);
        return response;
      }
      async function list(from,to,includeGroups){
        const range=calendarRange({from,to}),events=[];
        let page;
        for(let count=0;count<20;count++){
          const response=await google('',{...range,singleEvents:'true',orderBy:'startTime',maxResults:'250',
            fields:'nextPageToken,items('+fields+')',...(page?{pageToken:page}:{})});
          if(!response.ok)throw Error('Не удалось обновить Google Календарь');
          const data=await response.json();
          events.push(...(data.items||[]).map(raw=>calendarEvent(raw,calendarId,includeGroups)).filter(Boolean));
          page=data.nextPageToken;
          if(!page)return events;
        }
        throw Error('Слишком много событий в выбранном периоде');
      }
      if(input.action==='copy-group-week')return reply(200,await copyGroupWeek({input,calendarId,list,google,now}));
      if(input.action)return reply(200,await editGroupEvent({input,calendarId,google,now}));
      const events=await list(input.from,input.to,input.includeGroups===true);
      return reply(200,{mode:'live',source:'cloud',asOf:new Date(now()).toISOString(),events});
    } catch(error) {
      if(error.calendarAction)return reply(error.status,{error:error.message});
      // Never return upstream errors, tokens, or account JSON to the phone/logs.
      return reply(503,{error:'Не удалось обновить расписание. Сохранённые тренировки доступны на устройстве.'});
    }
  };
}

if (typeof Deno!=='undefined') Deno.serve(createCalendarHandler({env:name=>Deno.env.get(name)}));
