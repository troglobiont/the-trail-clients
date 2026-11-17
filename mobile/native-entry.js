import {Capacitor,CapacitorHttp,registerPlugin} from '@capacitor/core';
import {App} from '@capacitor/app';
import {Filesystem,Directory,Encoding} from '@capacitor/filesystem';
import {Share} from '@capacitor/share';
import {CapacitorUpdater} from '@capgo/capacitor-updater';
import {APP_ID,readPublicRelease} from '../src/updates.js';
import {activateNativeUpdate,downloadNativeUpdate} from './update-bridge.js';
const Device=registerPlugin('TrailDevice');
const native=Capacitor.isNativePlatform();
const updateVersionKey='trail-update-version';
const updateRouteKey='trail-update-route';
let appInfo;
window.TrailNative={
  native,
  adapter:{async load(){return (await Device.load()).text||null;},async save(text){await Device.save({text});},async loadInitialData(){const info=await App.getInfo();if(Number(info.build)<4)return null;return (await Device.loadInitialData()).text||null;}},
  async ready(version){
    if(!native)return false;
    await CapacitorUpdater.notifyAppReady();
    const expected=sessionStorage.getItem(updateVersionKey);
    sessionStorage.removeItem(updateVersionKey);
    return expected===version;
  },
  async info(){const info=await App.getInfo();return {nativeVersion:info.version,runtime:1};},
  async setLauncherPalette(palette) {
    if (!native) return;
    appInfo ??= App.getInfo().catch(error => { appInfo = undefined; throw error; });
    if (Number((await appInfo).build) >= 10) await Device.setLauncherPalette({ palette });
  },
  async openTelegram({ peerId, accountPeerId, username }) {
    if (!native) return { opened:false };
    appInfo ??= App.getInfo().catch(error => { appInfo = undefined; throw error; });
    if (Number((await appInfo).build) < 11) return { opened:false };
    return Device.openTelegram({ peerId, accountPeerId:accountPeerId || '', username:username || '' });
  },
  async setSecret(key,value){return Device.setSecret({key,value});},
  async getSecret(key){return (await Device.getSecret({key})).value||'';},
  async cloudRequest(options){return CapacitorHttp.request(options);},
  async saveVoice(value){return Device.saveVoice({text:JSON.stringify(value)});},
  async loadVoice(){const {text}=await Device.loadVoice();return text?JSON.parse(text):null;},
  async clearVoice(){return Device.clearVoice();},
  async microphonePermission(){if(Number((await App.getInfo()).build)<6)return {state:'native-update-required'};return Device.microphonePermission();},
  async requestMicrophonePermission(){if(Number((await App.getInfo()).build)<6)return {state:'native-update-required'};return Device.requestMicrophonePermission();},
  async openMicrophoneSettings(){return Device.openMicrophoneSettings();},
  async readRelease(){return readPublicRelease(options=>CapacitorHttp.get(options));},
  async downloadUpdate(manifest,onProgress){
    const url=manifest.direct?manifest.bundle.url:(await Device.resolveAsset({assetId:manifest.assetId})).url;
    return downloadNativeUpdate(CapacitorUpdater,manifest,url,onProgress);
  },
  async applyUpdate(bundle){
    return activateNativeUpdate(CapacitorUpdater,bundle,{
      saveUpdate(version){
        sessionStorage.setItem(updateRouteKey,location.hash);
        sessionStorage.setItem(updateVersionKey,version);
      },
      async servedVersion(){
        const url=new URL('./build-info.json',location.href);
        url.searchParams.set('reload',String(Date.now()));
        const controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(),1800);
        try{
          const response=await fetch(url,{cache:'no-store',signal:controller.signal});
          if(!response.ok)return null;
          const info=await response.json();
          return info.appId===APP_ID ? info.version : null;
        }finally{clearTimeout(timer);}
      },
      reloadFresh(){
        const url=new URL(location.href);
        url.searchParams.set('reload',String(Date.now()));
        location.replace(url.href);
      }
    });
  },
  async exportJSON(text){const file=await Filesystem.writeFile({path:'THE-TRAIL-Clients-backup.json',data:text,directory:Directory.Cache,encoding:Encoding.UTF8});await Share.share({title:'База THE.TRAIL Clients',files:[file.uri],dialogTitle:'Сохранить резервную копию'});},
  async request(url,method='GET',body=null,token=''){return Device.requestService({url,method,body:body===null?'':JSON.stringify(body),token});}
};
if(native){
  const saved=sessionStorage.getItem(updateRouteKey);
  if(saved&&/^#(?:todo|clients|account|settings|client\/[a-zA-Z0-9_-]+)$/.test(saved))location.hash=saved;
  sessionStorage.removeItem(updateRouteKey);
  App.addListener('backButton',()=>{if(document.querySelector('dialog[open]'))document.querySelector('dialog[open]').close();else if(location.hash.startsWith('#client/'))history.back();else if(location.hash!=='#todo')location.hash='#todo';else App.minimizeApp();});
  App.addListener('appStateChange',state=>{if(state.isActive)window.dispatchEvent(new Event('trail-app-active'));});
}
