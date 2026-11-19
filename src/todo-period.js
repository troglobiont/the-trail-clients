import {addDays} from './model-utils.js';

// Dates are already resolved by taskDate: waiting tasks use their reply-check date.
export function todoPeriodEntries(entries,period,today) {
  if (period===null) return entries;
  if (period===-1) return entries.filter(item=>item.due && item.due<today);
  const until=addDays(today,period);
  return entries.filter(item=>item.due && item.due>=today && item.due<=until);
}
