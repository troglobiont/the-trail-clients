import {Capacitor,registerPlugin} from '@capacitor/core';
import {App} from '@capacitor/app';
import {Filesystem,Directory,Encoding} from '@capacitor/filesystem';
import {Share} from '@capacitor/share';
import {CapacitorUpdater} from '@capgo/capacitor-updater';
const Device=registerPlugin('TrailDevice');
const native=Capacitor.isNativePlatform();
window.TrailNative={
  native,
  adapter:{async load(){return (await Device.load()).text||null;},async save(text){await Device.save({text});},async loadInitialData(){const info=await App.getInfo();if(Number(info.build)<4)return null;return (await Device.loadInitialData()).text||null;}},
  async ready(){if(native)await CapacitorUpdater.notifyAppReady();},
  async info(){const info=await App.getInfo();return {nativeVersion:info.version,runtime:1};},
  async setSecret(key,value){return Device.setSecret({key,value});},
  async getSecret(key){return (await Device.getSecret({key})).value||'';},
  async saveVoice(value){return Device.saveVoice({text:JSON.stringify(value)});},
  async loadVoice(){const {text}=await Device.loadVoice();return text?JSON.parse(text):null;},
  async clearVoice(){return Device.clearVoice();},
  async readRelease(){return Device.readRelease();},
  async downloadUpdate(manifest,onProgress){
    const resolved=await Device.resolveAsset({assetId:manifest.assetId});
    const listener=await CapacitorUpdater.addListener('download',e=>{if(e.bundle?.version===manifest.version)onProgress(e.percent);});
    try{return await CapacitorUpdater.download({version:manifest.version,url:resolved.url,checksum:manifest.bundle.sha256});}
    finally{await listener.remove();}
  },
  async applyUpdate(bundle){sessionStorage.setItem('trail-update-route',location.hash);await CapacitorUpdater.set({id:bundle.id});},
  async exportJSON(text){const file=await Filesystem.writeFile({path:'THE-TRAIL-Clients-backup.json',data:text,directory:Directory.Cache,encoding:Encoding.UTF8});await Share.share({title:'База THE.TRAIL Clients',files:[file.uri],dialogTitle:'Сохранить резервную копию'});},
  async request(url,method='GET',body=null,token=''){return Device.requestService({url,method,body:body===null?'':JSON.stringify(body),token});}
};
if(native){
  const saved=sessionStorage.getItem('trail-update-route');
  if(saved&&/^#(?:todo|clients|settings|client\/[a-zA-Z0-9_-]+)$/.test(saved))location.hash=saved;
  sessionStorage.removeItem('trail-update-route');
  App.addListener('backButton',()=>{if(document.querySelector('dialog[open]'))document.querySelector('dialog[open]').close();else if(location.hash.startsWith('#client/'))history.back();else if(location.hash!=='#todo')location.hash='#todo';else App.minimizeApp();});
}
