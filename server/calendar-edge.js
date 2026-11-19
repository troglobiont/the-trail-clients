// Supabase Edge Function `trail-calendar`. Only reads the configured coach calendar.
// Google credentials stay in server secrets; callers use their existing app login.
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Content-Type':'application/json'};
const fields = 'id,summary,start,end,location,status,extendedProperties,recurringEventId,recurrence,attendees(self),etag';
const encoder = new TextEncoder();
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,'');
const encodeJSON = value => base64url(encoder.encode(JSON.stringify(value)));

function midnight(day) {
  let time = Date.parse(day+'T00:00:00Z');
  const target = time;
  const format = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Belgrade',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  for (let i=0;i<3;i++) {
    const local = format.format(new Date(time)).replace(' ','T')+'Z';
    const difference = target-Date.parse(local);
    time += difference;
    if (!difference) break;
  }
  return new Date(time).toISOString();
}

export function calendarRange({from,to}) {
  for (const day of [from,to]) if (typeof day!=='string' || !/^\d{4}-\d{2}-\d{2}$/u.test(day)
      || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0,10)!==day) throw Error('Проверь даты расписания');
  const days = (Date.parse(to)-Date.parse(from))/86400000;
  if (days<=0 || days>31) throw Error('Выбери период не длиннее месяца');
  return {timeMin:midnight(from),timeMax:midnight(to)};
}

export function calendarEvent(raw,calendar) {
  const title = raw.summary?.trim() || '';
  if (raw.status==='cancelled' || !/^персональная\s*·[^·]+·\s*сергей$/iu.test(title)
      || !raw.id || !Number.isFinite(Date.parse(raw.start?.dateTime)) || !Number.isFinite(Date.parse(raw.end?.dateTime))) return null;
  const eid = base64url(encoder.encode(raw.id+' '+calendar));
  return {id:raw.id,title,start:raw.start.dateTime,end:raw.end.dateTime,location:raw.location||'',
    clientId:raw.extendedProperties?.private?.trailClientId || null,
    canEdit:Boolean(raw.etag && !raw.recurrence),canAlign:!Boolean(raw.attendees?.length || raw.recurringEventId || raw.recurrence),
    url:'https://calendar.google.com/calendar/event?eid='+eid};
}

export function createCalendarHandler({env,fetch:request=fetch,now=Date.now}) {
  let token, renewing;
  const reply = (status,value) => new Response(JSON.stringify(value),{status,headers:cors});
  const send = (url,options={}) => request(url,{...options,signal:AbortSignal.timeout(15000)});
  async function googleToken(account) {
    if (token?.expires>now()+60000) return token.value;
    if (renewing) return renewing;
    renewing = (async()=>{
      const issued = Math.floor(now()/1000);
      const claims = {iss:account.client_email,scope:'https://www.googleapis.com/auth/calendar.events.readonly',
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
      token = {value:data.access_token,expires:now()+data.expires_in*1000};
      return token.value;
    })().finally(()=>{renewing=null;});
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
      let range;
      try {
        if (Number(request.headers.get('Content-Length'))>2000) throw Error();
        const body = await request.text();
        if (body.length>2000) throw Error();
        range = calendarRange(JSON.parse(body));
      } catch { return reply(400,{error:'Проверь даты расписания'}); }
      const settings = env('TRAIL_GOOGLE_CALENDAR');
      if (!settings) return reply(503,{error:'Облачное расписание ещё не подключено'});
      const {account,calendarId} = JSON.parse(settings);
      if (!calendarId || !account?.private_key || !account.client_email) throw Error('Облачный календарь не настроен');
      const events = [];
      let page;
      for (let count=0;count<20;count++) {
        const params = new URLSearchParams({...range,singleEvents:'true',orderBy:'startTime',maxResults:'250',
          fields:'nextPageToken,items('+fields+')',...(page?{pageToken:page}:{})});
        const response = await send('https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(calendarId)+'/events?'+params,
          {headers:{Authorization:'Bearer '+await googleToken(account)}});
        if (!response.ok) { if (response.status===401) token=null; throw Error('Не удалось обновить Google Календарь'); }
        const data = await response.json();
        events.push(...(data.items||[]).map(raw=>calendarEvent(raw,calendarId)).filter(Boolean));
        page = data.nextPageToken;
        if (!page) return reply(200,{mode:'live',source:'cloud',asOf:new Date(now()).toISOString(),events});
      }
      throw Error('Слишком много событий в выбранном периоде');
    } catch {
      // Never return upstream errors, tokens, or account JSON to the phone/logs.
      return reply(503,{error:'Не удалось обновить расписание. Сохранённые тренировки доступны на устройстве.'});
    }
  };
}

if (typeof Deno!=='undefined') Deno.serve(createCalendarHandler({env:name=>Deno.env.get(name)}));
