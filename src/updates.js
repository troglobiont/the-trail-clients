export const APP_ID='io.github.troglobiont.trailclients';
export const REPOSITORY='troglobiont/the-trail-clients';
export function compareVersions(a,b){const parts=v=>{if(typeof v!=='string'||!/^\d+\.\d+\.\d+$/.test(v))throw Error('manifest');return v.split('.').map(Number);};const x=parts(a),y=parts(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return Math.sign(x[i]-y[i]);return 0;}
export function validateManifest(raw){
  if(!raw||raw.schemaVersion!==1||raw.appId!==APP_ID||!Number.isInteger(raw.nativeRuntime)||raw.nativeRuntime<1)throw Error('manifest');
  compareVersions(raw.version,raw.minNativeVersion);
  if(!/^[a-f0-9]{64}$/i.test(raw.bundle?.sha256||'')||raw.bundle.url!==`https://github.com/${REPOSITORY}/releases/download/v${raw.version}/THE-TRAIL-Clients-update.zip`)throw Error('manifest');
  return {version:raw.version,nativeRuntime:raw.nativeRuntime,minNativeVersion:raw.minNativeVersion,bundle:{url:raw.bundle.url,sha256:raw.bundle.sha256.toLowerCase()}};
}
export function createUpdater({version,bridge,flush,onChange=()=>{}}){
  let view={status:'idle',progress:0,latest:null,error:null},flight=null;
  const emit=patch=>{view={...view,...patch};onChange(view);};
  async function run(apply){
    emit({status:'checking',error:null,progress:0});
    try{
      if(!bridge?.native)throw Error('native');
      await flush();
      const release=await bridge.readRelease(),manifest=validateManifest(JSON.parse(release.manifest));
      if(release.tag!=='v'+manifest.version||!Number.isSafeInteger(release.assetId)||release.assetId<1)throw Error('manifest');
      emit({latest:manifest.version});
      if(compareVersions(manifest.version,version)<=0){emit({status:'current'});return;}
      const info=await bridge.info();if(info.runtime!==manifest.nativeRuntime||compareVersions(info.nativeVersion,manifest.minNativeVersion)<0)throw Error('native-required');
      if(!apply){emit({status:'available'});return;}
      emit({status:'downloading'});
      const bundle=await bridge.downloadUpdate({...manifest,assetId:release.assetId},progress=>emit({progress:Math.max(0,Math.min(100,Number(progress)||0))}));
      if(!bundle?.id||bundle.version!==manifest.version||bundle.checksum&&bundle.checksum.toLowerCase()!==manifest.bundle.sha256)throw Error('checksum');
      await flush();emit({status:'applying',progress:100});await bridge.applyUpdate(bundle);
    }catch(error){const text=String(error?.message||'');emit({status:'error',error:['manifest','native','native-required','checksum'].includes(text)?text:text.includes('github-auth')?'github-auth':text.includes('release-missing')?'release-missing':'network'});}
  }
  return {state:()=>view,check(){if(!flight)flight=run(false).finally(()=>{flight=null;});return flight;},update(){if(!flight)flight=run(true).finally(()=>{flight=null;});return flight;}};
}
