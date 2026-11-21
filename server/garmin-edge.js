// Supabase Edge Function trail-garmin. A single Personal API account for the owner's pilot.
const garmin='https://personal.connectapi.garmin.com';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Content-Type':'application/json'};
const reply=(status,value)=>new Response(JSON.stringify(value),{status,headers});
const localDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Belgrade',year:'numeric',month:'2-digit',day:'2-digit'});
const dateBounds=now=>{
  const to=localDay.format(new Date(now));
  const from=new Date(Date.parse(to+'T12:00:00Z')-28*86400000).toISOString().slice(0,10);
  return {from,to};
};
const idPattern=/^[a-zA-Z0-9_-]{1,180}$/u;
const positiveId=value=>/^[1-9][0-9]{0,19}$/u.test(value||'');
const recordDay=value=>{
  const day=typeof value==='string'?value.slice(0,10):'';
  return /^\d{4}-\d{2}-\d{2}$/u.test(day)&&Number.isFinite(Date.parse(day))
    &&new Date(day).toISOString().slice(0,10)===day?day:null;
};
const number=(value,min,max)=>Number.isFinite(value)&&value>=min&&value<=max?value:null;
const inRange=(day,{from,to})=>day&&day>=from&&day<=to;

function rows(payload,key){
  if(payload===null)return [];
  while(payload&&typeof payload==='object'&&!Array.isArray(payload)){
    const field=[key,'summaries','data'].find(name=>Object.hasOwn(payload,name));
    if(!field){
      if(Object.keys(payload).length===0)return [];
      throw Error('Invalid Garmin envelope');
    }
    payload=payload[field];
    if(payload===null)return [];
  }
  if(!Array.isArray(payload)||payload.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw Error('Invalid Garmin records');
  return payload;
}

export function garminActivity(raw,range){
  const detail=raw.summaryDTO||{},local=raw.startTimeLocal||detail.startTimeLocal;
  const day=recordDay(local||raw.startTimeGMT||detail.startTimeGMT);
  const id=String(raw.activityId??'');
  if(!positiveId(id)||!inRange(day,range))return null;
  const type=raw.activityType||raw.activityTypeDTO;
  const sport=String(typeof type==='string'?type:type?.typeKey||'other').slice(0,60);
  const time=typeof local==='string'?(local.match(/^\d{4}-\d{2}-\d{2}[T ]((?:[01]\d|2[0-3]):[0-5]\d)/u)?.[1]??null):null;
  return {id,day,time,sport,title:String(raw.activityName||'Тренировка').slice(0,180),
    seconds:number(raw.duration??detail.duration,1,7*86400),meters:number(raw.distance??detail.distance,0,1000000),
    ascent:number(raw.elevationGain??detail.elevationGain,0,100000),averageHr:number(raw.averageHR??detail.averageHR,20,255)};
}

function daily(kind,records,range){
  const result={};
  for(const raw of records){
    const entry=raw.dailySleepDTO||raw.hrvSummary||raw;
    const day=recordDay(entry.calendarDate||entry.date||raw.calendarDate);
    if(!inRange(day,range))continue;
    let value;
    if(kind==='sleepMinutes'){
      const seconds=entry.sleepTimeSeconds??entry.sleepTimeInSeconds??entry.sleepDurationSeconds??entry.sleepDurationInSeconds;
      value=number(seconds,1,86400)===null?null:Math.round(seconds/60);
    }else if(kind==='hrv')value=number(entry.lastNightAvg??entry.nightlyAvg,1,500);
    else value=number(entry.heartRate?.restingValue??entry.restingHeartRate,20,200);
    if(value!==null)result[day]=value;
  }
  return result;
}

export function createGarminHandler({env,fetch:request=fetch,now=Date.now}){
  let cached,loading,token;
  const send=(url,options={})=>request(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
  async function bearer(key){
    if(token?.key===key&&token.expires>now()+60000)return token.value;
    const response=await send(garmin+'/personalapitoken-service/personal-api/personal-api-key/token',
      {method:'POST',headers:{Authorization:'ApiKey '+key}});
    if(!response.ok)throw Error('Garmin token unavailable');
    const value=(await response.text()).trim();
    if(!/^[\w-]+\.[\w-]+\.[\w-]+$/u.test(value))throw Error('Invalid Garmin token');
    // The provider supplies a 24 hour token. Read exp to respect an earlier key expiry.
    const encoded=value.split('.')[1].replaceAll('-','+').replaceAll('_','/');
    const expires=Number(JSON.parse(atob(encoded)).exp)*1000;
    if(!Number.isFinite(expires)||expires<=now())throw Error('Expired Garmin token');
    token={key,value,expires};
    return value;
  }
  async function get(path,access,params){
    const response=await send(garmin+path+(params?'?'+new URLSearchParams(params):''),{headers:{Authorization:'Bearer '+access}});
    if(response.status===401)token=null;
    if(!response.ok)throw Error('Garmin data unavailable');
    return response.json();
  }
  async function activityPage(range,access){
    const map=new Map();
    for(let start=0;start<500;start+=50){
      const page=rows(await get('/activitylist-service/activities/search/activities',access,
        {start:String(start),limit:'50',startDate:range.from,endDate:range.to}),'activities');
      const before=map.size;
      for(const raw of page){
        const value=garminActivity(raw,range);
        if(value)map.set(value.id,value);
      }
      if(page.length<50)return [...map.values()];
      if(map.size===before)break;
    }
    throw Error('Garmin activity page incomplete');
  }
  async function refresh(config){
    const range=dateBounds(now());
    const access=await bearer(config.apiKey);
    const params={startDate:range.from,endDate:range.to};
    const definitions=[
      ['sleepMinutes','/sleep-service/sleep/dailySleepSummariesByDate','sleepSummaries',params],
      ['hrv','/hrv-service/hrv/daily/'+range.from+'/'+range.to,'hrvSummaries',null],
      ['restingHeartRate','/usersummary-service/v2/dailysummaries','dailySummaries',params],
    ];
    const results=await Promise.allSettled([activityPage(range,access),
      ...definitions.map(async ([kind,path,key,query])=>daily(kind,rows(await get(path,access,query),key),range))]);
    if(results.every(result=>result.status==='rejected'))throw Error('No Garmin streams available');
    const value=result=>result.status==='fulfilled'?result.value:null;
    return {clientId:config.clientId,asOf:new Date(now()).toISOString(),...range,activities:value(results[0]),
      measures:Object.fromEntries(definitions.map(([kind],index)=>[kind,value(results[index+1])]))};
  }
  return async request=>{
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return reply(405,{error:'Нужен POST-запрос'});
    const authorization=request.headers.get('Authorization');
    if(!/^Bearer [\w.-]+$/u.test(authorization||''))return reply(401,{error:'Войди в аккаунт приложения'});
    try{
      const config=JSON.parse(env('TRAIL_GARMIN_PERSONAL')||'null');
      if(!config?.owner||!idPattern.test(config.clientId||'')||typeof config.apiKey!=='string'||!config.apiKey)
        return reply(503,{error:'Garmin ещё не подключён'});
      const who=await send(env('SUPABASE_URL')+'/auth/v1/user',{headers:{authorization,apikey:env('SUPABASE_ANON_KEY')}});
      if(who.status===401||who.status===403)return reply(401,{error:'Войди снова для Garmin'});
      if(!who.ok)return reply(503,{error:'Не удалось проверить доступ'});
      if((await who.json()).id!==config.owner)return reply(403,{error:'Нет доступа к этому Garmin'});
      let clientId;
      try{
        if(Number(request.headers.get('Content-Length'))>1000)throw Error();
        const raw=await request.text();
        if(raw.length>1000)throw Error();
        ({clientId}=JSON.parse(raw));
      }catch{return reply(400,{error:'Проверь карточку спортсмена'});}
      if(clientId!==config.clientId)return reply(403,{error:'Garmin привязан к другой карточке'});
      if(cached?.key===config.apiKey&&cached.value.clientId===clientId&&cached.value.to===dateBounds(now()).to&&
        now()-Date.parse(cached.value.asOf)<60000)return reply(200,cached.value);
      if(!loading){
        loading=refresh(config).then(value=>{
          if(value.activities!==null&&Object.values(value.measures).every(stream=>stream!==null))cached={key:config.apiKey,value};
          return value;
        }).finally(()=>{loading=null;});
      }
      return reply(200,await loading);
    }catch{return reply(503,{error:'Не удалось обновить Garmin'});}
  };
}

if(typeof Deno!=='undefined')Deno.serve(createGarminHandler({env:name=>Deno.env.get(name)}));
