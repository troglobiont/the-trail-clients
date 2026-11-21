// Supabase Edge Function trail-garmin-connect. Garmin Business OAuth for the pilot athlete.
const authorizeURL = 'https://connect.garmin.com/oauth2Confirm';
const tokenURL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';
const userURL = 'https://apis.garmin.com/wellness-api/rest/user';
const encoder = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,'');
const random = bytes => b64(crypto.getRandomValues(new Uint8Array(bytes)));
const hash = async value => b64(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));
const ownerPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const urlToken = /^[A-Za-z0-9_-]{43}$/u;
const clientPattern = /^[a-zA-Z0-9_-]{1,180}$/u;
const headers = {'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{...headers,'Content-Type':'application/json'}});
const callbackMessage = (status, title) => new Response(title+'\n\nВернись в The.Trail, чтобы проверить подключение.',
  {status,headers:{...headers,'Content-Type':'text/plain; charset=utf-8'}});

export function createGarminConnectHandler({env,fetch:request=fetch,now=Date.now}){
  const send = (url,options={}) => request(url,{...options,redirect:'error',signal:AbortSignal.timeout(12000)});

  async function encrypt(credentials, key, owner, clientId){
    const material = Uint8Array.from(atob(key.replaceAll('-','+').replaceAll('_','/')),character=>character.charCodeAt(0));
    const secret = await crypto.subtle.importKey('raw',material,'AES-GCM',false,['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(owner+'/'+clientId)},secret,
      encoder.encode(JSON.stringify(credentials)));
    return {version:1,iv:b64(iv),content:b64(new Uint8Array(cipher))};
  }

  return async req=>{
    if (req.method!=='POST'&&req.method!=='GET') return json({error:'Недопустимый запрос'},405);
    const callback = req.method==='GET';
    try {
      const supabase=env('SUPABASE_URL'), anon=env('SUPABASE_ANON_KEY'), admin=env('SUPABASE_SERVICE_ROLE_KEY');
      const cfg=JSON.parse(env('TRAIL_GARMIN_OAUTH')||'null');
      if (typeof cfg?.key!=='string'||!cfg.key||typeof cfg.secret!=='string'||!cfg.secret||
          !urlToken.test(cfg.encryptionKey||'')||!ownerPattern.test(cfg.owner||'')||
          !clientPattern.test(cfg.clientId||'')||!supabase||!anon||!admin) {
        return callback?callbackMessage(503,'Подключение Garmin Connect пока недоступно'):json({status:'unavailable'});
      }
      const redirect=supabase+'/functions/v1/trail-garmin-connect';
      const identity={owner:'eq.'+cfg.owner,client_id:'eq.'+cfg.clientId};
      const database=async (table,params,method='GET',body,prefer)=>{
        const response=await send(supabase+'/rest/v1/'+table+'?'+new URLSearchParams(params),{
          method,headers:{apikey:admin,Authorization:'Bearer '+admin,'Content-Type':'application/json',...(prefer&&{Prefer:prefer})},
          body:body===undefined?undefined:JSON.stringify(body)});
        if(!response.ok)throw Error('Garmin connection database unavailable');
        return response.status===204?null:response.json();
      };
      if(callback){
        const query=new URL(req.url).searchParams,state=query.get('state'),code=query.get('code'),denied=query.has('error');
        if(!urlToken.test(state||'')||(!denied&&(!code||code.length>2048)))return callbackMessage(400,'Ссылка Garmin Connect устарела');
        const pending=await database('trail_garmin_pending',{...identity,state_hash:'eq.'+await hash(state),
          expires_at:'gt.'+new Date(now()).toISOString(),select:'verifier'},'DELETE',undefined,'return=representation');
        if(!pending?.[0])return callbackMessage(400,'Ссылка Garmin Connect устарела');
        if(denied)return callbackMessage(200,'Доступ к Garmin Connect отклонён');
        const exchange = await send(tokenURL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
          body:new URLSearchParams({grant_type:'authorization_code',client_id:cfg.key,client_secret:cfg.secret,
            redirect_uri:redirect,code,code_verifier:pending[0].verifier})});
        if(!exchange.ok)throw Error('Garmin OAuth exchange failed');
        const token=await exchange.json();
        if(!token.access_token||!token.refresh_token||!Number.isFinite(token.expires_in)||token.expires_in<=0)
          throw Error('Invalid Garmin OAuth response');
        const garminRequest=async path=>{
          const response=await send(userURL+path,{headers:{Authorization:'Bearer '+token.access_token}});
          if(!response.ok)throw Error('Garmin account lookup failed');
          return response.json();
        };
        const [{userId},granted]=await Promise.all([garminRequest('/id'),garminRequest('/permissions')]);
        const permissions=Array.isArray(granted)?granted.flat():null;
        if(!clientPattern.test(userId||'')||!permissions||permissions.some(item=>typeof item!=='string'))
          throw Error('Invalid Garmin account');
        if(!permissions.some(access=>access==='ACTIVITY_EXPORT'||access==='HEALTH_EXPORT'))
          return callbackMessage(200,'Разреши доступ к тренировкам или замерам в Garmin Connect');
        const credentials=await encrypt({access:token.access_token,refresh:token.refresh_token,
          expiresAt:now()+token.expires_in*1000},cfg.encryptionKey,cfg.owner,cfg.clientId);
        await database('trail_garmin_connections',{on_conflict:'owner,client_id'},'POST',{
          owner:cfg.owner,client_id:cfg.clientId,provider_id:userId,permissions,credentials,connected_at:new Date(now()).toISOString()
        },'resolution=merge-duplicates,return=minimal');
        return callbackMessage(200,'Разрешение Garmin Connect сохранено');
      }
      const authorization=req.headers.get('Authorization');
      if(!/^Bearer [\w.-]+$/u.test(authorization||''))return json({error:'Войди в аккаунт The.Trail'},401);
      const who=await send(supabase+'/auth/v1/user',{headers:{authorization,apikey:anon}});
      if(who.status===401||who.status===403)return json({error:'Войди в аккаунт The.Trail'},401);
      if(!who.ok)throw Error('The.Trail login unavailable');
      if((await who.json()).id!==cfg.owner)return json({error:'Нет доступа к подключению Garmin'},403);
      let body;
      try{
        const raw=await req.text();
        if(raw.length>1000)throw Error();
        body=JSON.parse(raw);
      }catch{return json({error:'Не удалось проверить запрос Garmin'},400);}
      if(body?.clientId!==cfg.clientId)return json({error:'Нет доступа к подключению Garmin'},403);
      if(body.action==='status'){
        const [connection]=await database('trail_garmin_connections',{...identity,select:'connected_at'});
        return json(connection?{status:'connected',connectedAt:connection.connected_at}:{status:'ready'});
      }
      if(body.action!=='start')return json({error:'Не удалось проверить запрос Garmin'},400);
      const state=random(32),verifier=random(32);
      await database('trail_garmin_pending',{on_conflict:'owner,client_id'},'POST',{owner:cfg.owner,client_id:cfg.clientId,
        state_hash:await hash(state),verifier,expires_at:new Date(now()+10*60000).toISOString()},'resolution=merge-duplicates,return=minimal');
      const url=authorizeURL+'?'+new URLSearchParams({response_type:'code',client_id:cfg.key,redirect_uri:redirect,
        state,code_challenge_method:'S256',code_challenge:await hash(verifier)});
      return json({status:'authorizing',url});
    }catch{
      return callback?callbackMessage(502,'Не удалось подключить Garmin Connect'):json({error:'Не удалось подключить Garmin Connect'},503);
    }
  };
}

if(typeof Deno!=='undefined')Deno.serve(createGarminConnectHandler({env:name=>Deno.env.get(name)}));
