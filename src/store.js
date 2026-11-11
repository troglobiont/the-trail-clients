import {emptyState,validateState,clone,parseImport,mergeState} from './core.js';
import {trackCloudChanges} from './cloud-state.js';
const KEY='the-trail-clients-store-v1';
export async function createStore(adapter){
  let current;let tail=Promise.resolve();const listeners=new Set();
  const raw=await adapter.load();
  if(raw){try{current=validateState(JSON.parse(raw));}catch{throw Error('Не удалось прочитать базу. Она сохранена на устройстве; не удаляй приложение. Восстанови резервную копию.');}}
  else current=emptyState();
  // A personal installer may supply an initial database outside the public bundle.
  // Commit the import and its marker together so a restart never reapplies it.
  const initial=await adapter.loadInitialData?.();
  if(initial){
    const envelope=JSON.parse(initial),datasetId=envelope.initialDatasetId;
    if(typeof datasetId!=='string'||!/^[-a-zA-Z0-9_]{1,180}$/.test(datasetId))throw Error('Некорректная начальная база');
    const applied=current.settings.initialDatasetIds||[];
    if(!Array.isArray(applied))throw Error('Некорректные отметки начальной базы');
    if(!applied.includes(datasetId)){
      const next=mergeState(current,parseImport(initial));
      next.settings.initialDatasetIds=[...applied,datasetId];
      next.revision=current.revision+1;next.updatedAt=new Date().toISOString();
      validateState(next);await adapter.save(JSON.stringify(next));current=next;
    }
  }
  return {
    state:()=>current,
    subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    mutate(fn,{trackCloud=true}={}){const operation=tail.then(async()=>{const next=clone(current),result=fn(next);if(result&&typeof result.then==='function')throw Error('Изменение базы должно быть синхронным');if(trackCloud)trackCloudChanges(current,next);next.revision=current.revision+1;next.updatedAt=new Date().toISOString();validateState(next);await adapter.save(JSON.stringify(next));current=next;listeners.forEach(fn=>fn(current));return result;});tail=operation.catch(()=>{});return operation;},
    flush:()=>tail,
    async replace(incoming){validateState(incoming);return this.mutate(next=>{const revision=next.revision;for(const key of Object.keys(next))delete next[key];Object.assign(next,clone(incoming),{revision});});}
  };
}
export function browserAdapter(){return {async load(){return localStorage.getItem(KEY);},async save(text){localStorage.setItem(KEY,text);}};}
