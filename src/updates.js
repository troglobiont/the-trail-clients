export const APP_ID='io.github.troglobiont.trailclients';
export const REPOSITORY='troglobiont/the-trail-clients';
const PUBLIC_RELEASE=`https://github.com/${REPOSITORY}/releases/latest/download/version.json`;

export async function readPublicRelease(get){
  const response=await get({url:PUBLIC_RELEASE,responseType:'text',connectTimeout:15000,readTimeout:15000});
  if(response.status===404)throw Error('release-missing');
  if(response.status===429)throw Error('update-rate-limit');
  if(response.status===403)throw Error('update-forbidden');
  if(response.status!==200)throw Error('Не удалось прочитать выпуск');
  let url;
  try{url=new URL(response.url);}catch{throw Error('manifest');}
  const isGitHub=url.hostname==='github.com'&&url.pathname.startsWith(`/${REPOSITORY}/releases/`);
  const isAsset=['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname);
  if(url.protocol!=='https:'||url.username||url.password||url.port||(!isGitHub&&!isAsset))throw Error('manifest');
  const manifest=typeof response.data==='string'?response.data:JSON.stringify(response.data);
  if(!manifest||manifest.length>256*1024)throw Error('manifest');
  return {manifest,direct:true};
}
export function classifyUpdateError(error,step){
  const text=String(error?.message||'');
  if(['manifest','native','native-required','checksum'].includes(text))return text;
  if(step==='save')return 'save';
  if(text.includes('update-asset-id'))return 'asset-id';
  if(text.includes('update-rate-limit'))return 'rate-limit';
  if(text.includes('github-auth')||text.includes('update-asset-http-401'))return 'github-auth';
  if(text.includes('update-forbidden')||text.includes('update-asset-http-403'))return 'forbidden';
  if(text.includes('release-missing')||text.includes('update-asset-http-404'))return 'release-missing';
  if(/insufficient_disk_space|no space left/i.test(text))return 'storage';
  if(/checksum/i.test(text))return 'checksum';
  if(/timed? ?out|timeout/i.test(text))return 'timeout';
  if(/ssl|certificate|handshake/i.test(text))return 'tls';
  return 'network';
}
export function compareVersions(a,b){const parts=v=>{if(typeof v!=='string'||!/^\d+\.\d+\.\d+$/.test(v))throw Error('manifest');return v.split('.').map(Number);};const x=parts(a),y=parts(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return Math.sign(x[i]-y[i]);return 0;}
export function validateManifest(raw){
  if(!raw||raw.schemaVersion!==1||raw.appId!==APP_ID||!Number.isInteger(raw.nativeRuntime)||raw.nativeRuntime<1)throw Error('manifest');
  compareVersions(raw.version,raw.minNativeVersion);
  if(!/^[a-f0-9]{64}$/i.test(raw.bundle?.sha256||'')||raw.bundle.url!==`https://github.com/${REPOSITORY}/releases/download/v${raw.version}/THE-TRAIL-Clients-update.zip`)throw Error('manifest');
  return {version:raw.version,nativeRuntime:raw.nativeRuntime,minNativeVersion:raw.minNativeVersion,bundle:{url:raw.bundle.url,sha256:raw.bundle.sha256.toLowerCase()}};
}
export function createUpdater({version,bridge,flush,onChange=()=>{}}){
  let view={status:'idle',progress:0,latest:null,error:null,step:null},checkFlight=null,updateFlight=null;
  const emit=patch=>{view={...view,...patch};onChange(view);};
  async function run(apply){
    emit({status:'checking',error:null,progress:0,step:'save'});
    try{
      if(!bridge?.native)throw Error('native');
      await flush();
      emit({step:'release'});
      const release=await bridge.readRelease();
      let raw;
      try{raw=JSON.parse(release.manifest);}catch{throw Error('manifest');}
      const manifest=validateManifest(raw);
      const direct=release.direct===true;
      if(!direct&&(release.tag!=='v'+manifest.version||!Number.isSafeInteger(release.assetId)||release.assetId<1))throw Error('manifest');
      emit({latest:manifest.version});
      if(compareVersions(manifest.version,version)<=0){emit({status:'current'});return;}
      emit({step:'compatibility'});
      const info=await bridge.info();if(info.runtime!==manifest.nativeRuntime||compareVersions(info.nativeVersion,manifest.minNativeVersion)<0)throw Error('native-required');
      if(!apply){emit({status:'available'});return;}
      emit({status:'downloading',step:'download'});
      const bundle=await bridge.downloadUpdate({...manifest,direct,assetId:release.assetId},progress=>emit({progress:Math.max(0,Math.min(100,Number(progress)||0))}));
      if(!bundle?.id||bundle.version!==manifest.version||bundle.checksum&&bundle.checksum.toLowerCase()!==manifest.bundle.sha256)throw Error('checksum');
      emit({step:'save'});await flush();emit({status:'applying',progress:100,step:'apply'});await bridge.applyUpdate(bundle);
    }catch(error){emit({status:'error',error:classifyUpdateError(error,view.step)});}
  }
  return {state:()=>view,check(){if(updateFlight)return updateFlight;if(!checkFlight)checkFlight=run(false).finally(()=>{checkFlight=null;});return checkFlight;},update(){if(!updateFlight)updateFlight=(async()=>{if(checkFlight)await checkFlight;await run(true);})().finally(()=>{updateFlight=null;});return updateFlight;}};
}
