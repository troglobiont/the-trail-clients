import {emptyState,validateState,clone} from './core.js';
const KEY='the-trail-clients-store-v1';
export async function createStore(adapter){
  let current;let tail=Promise.resolve();const listeners=new Set();
  const raw=await adapter.load();
  if(raw){try{current=validateState(JSON.parse(raw));}catch{throw Error('Не удалось прочитать базу. Она сохранена на устройстве; не удаляй приложение. Восстанови резервную копию.');}}
  else current=emptyState();
  return {
    state:()=>current,
    subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    mutate(fn){const operation=tail.then(async()=>{const next=clone(current),result=fn(next);if(result&&typeof result.then==='function')throw Error('Изменение базы должно быть синхронным');next.revision=current.revision+1;next.updatedAt=new Date().toISOString();validateState(next);await adapter.save(JSON.stringify(next));current=next;listeners.forEach(fn=>fn(current));return result;});tail=operation.catch(()=>{});return operation;},
    flush:()=>tail,
    async replace(incoming){validateState(incoming);return this.mutate(next=>{const revision=next.revision;Object.assign(next,clone(incoming),{revision});});}
  };
}
export function browserAdapter(){return {async load(){return localStorage.getItem(KEY);},async save(text){localStorage.setItem(KEY,text);}};}
