import {addDays,localDate} from './model-utils.js';

// Kept in the device database, never in the public bundle or financial sync data.
export function createCalendarData({read,saved,save,now=Date.now}) {
  let cached,loading;
  const valid = value => value && Array.isArray(value.events) && Number.isFinite(Date.parse(value.asOf))
    && typeof value.from==='string' && typeof value.to==='string'
    && value.events.every(event=>typeof event.id==='string' && typeof event.title==='string'
      && Number.isFinite(Date.parse(event.start)) && Number.isFinite(Date.parse(event.end)));
  const current = () => cached || (valid(saved()) ? saved() : null);
  const snapshot = () => {
    const value = current();
    if (!value) return null;
    return {...value,mode:'saved',coversToday:value.from<=localDate(new Date(now())) && value.to>localDate(new Date(now()))};
  };
  const refresh = (force=false) => {
    if (loading) return loading;
    const today = localDate(new Date(now())),from=today.slice(0,7)+'-01',to=addDays(today,30);
    if (!force && cached?.from===from && cached.to===to && now()-Date.parse(cached.asOf)<60000) return Promise.resolve(cached);
    loading = (async()=>{
      // Both parts must succeed before replacing the previous complete snapshot.
      const [upcoming,history] = await Promise.all([read(today,to),read(from,addDays(today,1))]);
      if (upcoming.mode!=='live' || history.mode!=='live') throw Error('Google Календарь ещё не подключён');
      const events = new Map([...history.events,...upcoming.events].map(event=>[event.id,event]));
      const value = {...upcoming,from,to,asOf:new Date(now()).toISOString(),
        events:[...events.values()].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start))};
      if (!valid(value)) throw Error('Не удалось прочитать расписание');
      await save(value);
      cached = value;
      return value;
    })().finally(()=>{loading=null;});
    return loading;
  };
  return {snapshot,refresh,invalidate(){cached=null;},async load(force=false){
    try { return await refresh(force); }
    catch(error) {
      const value = snapshot();
      if (!value) throw error;
      return {...value,refreshError:error.message};
    }
  }};
}
