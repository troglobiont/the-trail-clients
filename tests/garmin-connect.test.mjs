import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,createDecipheriv} from 'node:crypto';
import {createGarminConnectHandler} from '../server/garmin-connect-edge.js';

const origin='https://trail-fixture.supabase.co';
const endpoint=origin+'/functions/v1/trail-garmin-connect';
const owner='10000000-0000-4000-8000-000000000001';
const clientId='client-test-athlete';
const encryptionKey=Buffer.alloc(32,30);
const clock=Date.parse('2026-11-21T15:00:00Z');
const sha=value=>createHash('sha256').update(value).digest('base64url');

function fixture({configured=true,permissions=[['ACTIVITY_EXPORT','HEALTH_EXPORT']]}={}){
  let now=clock,pending,connection;
  const exchanges=[];
  const vars={SUPABASE_URL:origin,SUPABASE_ANON_KEY:'public-fixture',SUPABASE_SERVICE_ROLE_KEY:'private-fixture',
    TRAIL_GARMIN_OAUTH:configured?JSON.stringify({owner,clientId,key:'test-app-key',secret:'test-app-secret',
      encryptionKey:encryptionKey.toString('base64url')}):undefined};
  const fetch=async(input,options)=>{
    const url=new URL(input);
    if(url.pathname==='/auth/v1/user'){
      const id=options.headers.authorization==='Bearer test-login'?owner:'other-owner';
      return Response.json({id});
    }
    if(url.origin===origin){
      assert.equal(options.headers.Authorization,'Bearer private-fixture');
      if(url.pathname.endsWith('/trail_garmin_pending')){
        if(options.method==='POST'){pending=JSON.parse(options.body);return new Response(null,{status:204});}
        assert.equal(options.method,'DELETE');
        if(url.searchParams.get('state_hash')!=='eq.'+pending?.state_hash||
           Date.parse(pending.expires_at)<=Date.parse(url.searchParams.get('expires_at').slice(3)))return Response.json([]);
        const {verifier}=pending;
        pending=null;
        return Response.json([{verifier}]);
      }
      if(url.pathname.endsWith('/trail_garmin_connections')){
        if(options.method==='POST'){connection=JSON.parse(options.body);return new Response(null,{status:204});}
        assert.equal(url.searchParams.get('select'),'connected_at');
        return Response.json(connection?[{connected_at:connection.connected_at}]:[]);
      }
    }
    if(url.origin==='https://diauth.garmin.com'){
      exchanges.push(options.body);
      return Response.json({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:86400});
    }
    if(url.pathname.endsWith('/user/id'))return Response.json({userId:'garmin-test-athlete'});
    if(url.pathname.endsWith('/user/permissions'))return Response.json(permissions);
    throw Error('Unexpected endpoint');
  };
  const handler=createGarminConnectHandler({env:name=>vars[name],now:()=>now,fetch});
  const api=(action,{athlete=clientId,login='test-login'}={})=>handler(new Request(endpoint,{method:'POST',
    headers:login?{Authorization:'Bearer '+login}:{},body:JSON.stringify({clientId:athlete,action})}));
  const finish=(state,params={code:'test-code'})=>handler(new Request(endpoint+'?'+new URLSearchParams({state,...params})));
  return {api,finish,exchanges,record:()=>connection,advance:milliseconds=>{now+=milliseconds;},pending:()=>pending};
}

test('the owner can complete Garmin PKCE and the app only receives connection status',async()=>{
  const f=fixture();
  assert.deepEqual(await(await f.api('status')).json(),{status:'ready'});
  const {url,status}=await(await f.api('start')).json();
  const go=new URL(url),state=go.searchParams.get('state'),pending=f.pending();
  assert.equal(status,'authorizing');
  assert.equal(go.origin+go.pathname,'https://connect.garmin.com/oauth2Confirm');
  assert.equal(go.searchParams.get('redirect_uri'),endpoint);
  assert.equal(go.searchParams.get('code_challenge_method'),'S256');
  assert.equal(go.searchParams.get('code_challenge'),sha(pending.verifier));
  assert.equal(pending.state_hash,sha(state));
  assert(!url.includes(pending.verifier));

  const done=await f.finish(state);
  assert.equal(done.status,200);
  assert.match(await done.text(),/Разрешение Garmin Connect сохранено/u);
  assert.equal(done.headers.get('content-type'),'text/plain; charset=utf-8');
  assert.equal(done.headers.get('referrer-policy'),'no-referrer');
  assert.equal(f.exchanges[0].get('code_verifier'),pending.verifier);
  assert.equal((await f.finish(state)).status,400);
  const record=f.record(), {iv,content}=record.credentials;
  assert.equal(record.client_id,clientId);
  assert.equal(record.provider_id,'garmin-test-athlete');
  assert.deepEqual(record.permissions,['ACTIVITY_EXPORT','HEALTH_EXPORT']);
  const cipher=Buffer.from(content,'base64url');
  const decoder=createDecipheriv('aes-256-gcm',encryptionKey,Buffer.from(iv,'base64url'));
  decoder.setAAD(Buffer.from(owner+'/'+clientId));
  decoder.setAuthTag(cipher.subarray(-16));
  const unsealed=Buffer.concat([decoder.update(cipher.subarray(0,-16)),decoder.final()]).toString();
  assert.equal(JSON.parse(unsealed).refresh,'fixture-refresh');
  assert.deepEqual(await(await f.api('status')).json(),{status:'connected',connectedAt:new Date(clock).toISOString()});
});

test('the handshake blocks another login, another card, expired state and denied consent',async()=>{
  const f=fixture();
  assert.equal((await f.api('start',{athlete:'another-card'})).status,403);
  assert.equal((await f.api('start',{login:'another-login'})).status,403);
  assert.equal((await f.api('start',{login:null})).status,401);
  assert.equal(f.pending(),undefined);
  const start=async()=>new URL((await(await f.api('start')).json()).url).searchParams.get('state');
  const expired=await start();
  f.advance(600001);
  assert.equal((await f.finish(expired)).status,400);
  const denied=await start();
  assert.match(await(await f.finish(denied,{error:'access_denied'})).text(),/отклонён/u);
  assert.equal((await f.finish(denied)).status,400);
  assert.equal(f.exchanges.length,0);
  const none=fixture({configured:false});
  assert.deepEqual(await(await none.api('start')).json(),{status:'unavailable'});
});

test('Garmin consent must include workout or health export before the athlete shows connected',async()=>{
  const f=fixture({permissions:[['WORKOUT_IMPORT']]});
  const {url}=await(await f.api('start')).json();
  const complete=await f.finish(new URL(url).searchParams.get('state'));
  assert.match(await complete.text(),/Разреши доступ/u);
  assert.equal(f.record(),undefined);
});
