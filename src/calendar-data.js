import {addDays,localDate,validDate} from './model-utils.js';

// Kept in the device database, never in the public bundle or financial sync data.
export function createCalendarData({read,saved,save,now=Date.now}) {
  let cached,loading;
  const archives = new Map(), archiveLoads = new Map();
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
  function historyRange(month) {
    const today = localDate(new Date(now())), from = month+'-01';
    if (!validDate(from) || from>today) throw Error('Некорректный месяц расписания');
    const next = addDays(from,32).slice(0,7)+'-01';
    return {from,to:next<=today?next:addDays(today,1)};
  }
  function rangeSlice(value, {from,to}) {
    if (!value || value.from>from || value.to<to) return null;
    const events = value.events.filter(event=>{
      const day = localDate(new Date(event.start));
      return day>=from && day<to;
    });
    return {...value,from,to,events};
  }
  function historySnapshot(month) {
    const range = historyRange(month);
    const value = rangeSlice(archives.get(range.from),range) || rangeSlice(current(),range);
    return value && {...value,mode:'saved'};
  }
  async function loadHistory(month, force=false) {
    const range = historyRange(month);
    const {from,to} = range;
    const recent = rangeSlice(archives.get(from),range) || rangeSlice(cached,range);
    if (!force && recent && now()-Date.parse(recent.asOf)<60000) return recent;
    const key = from+'|'+to;
    if (!archiveLoads.has(key)) archiveLoads.set(key,(async()=>{
      const result = await read(from,to);
      if (result.mode!=='live') throw Error('Google Календарь ещё не подключён');
      const value = {...result,from,to,asOf:new Date(now()).toISOString()};
      if (!valid(value)) throw Error('Не удалось прочитать расписание');
      archives.set(from,value);
      return rangeSlice(value,range);
    })().finally(()=>archiveLoads.delete(key)));
    try { return await archiveLoads.get(key); }
    catch(error) {
      const value = historySnapshot(month);
      if (!value) throw error;
      return value;
    }
  }
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
  async function load(force=false) {
    try { return await refresh(force); }
    catch(error) {
      const value = snapshot();
      if (!value) throw error;
      return {...value,refreshError:error.message};
    }
  }
  async function loadWeek(from) {
    const range = {from,to:addDays(from,7)};
    const recent = rangeSlice(cached,range);
    if (recent && now()-Date.parse(recent.asOf)<60000) return recent;
    const today = localDate(new Date(now()));
    if (from>=today.slice(0,7)+'-01' && range.to<=addDays(today,30)) {
      const week = rangeSlice(await load(),range);
      if (week) return week;
    }
    try {
      const result = await read(range.from,range.to);
      if (result.mode!=='live') throw Error('Google Календарь ещё не подключён');
      const value = {...result,...range,asOf:new Date(now()).toISOString()};
      if (!valid(value)) throw Error('Не удалось прочитать расписание');
      return rangeSlice(value,range);
    } catch(error) {
      const week = rangeSlice(snapshot(),range);
      if (week) return week;
      throw error;
    }
  }
  return {snapshot,refresh,historySnapshot,loadHistory,load,loadWeek,invalidate(){cached=null;archives.clear();}};
}
