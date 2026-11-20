import * as C from './core.js';
import {mergeAthlete,sameAthleteValue} from './athlete.js';

// Caller verifies the account and maps the existing person before calling this controlled importer.
export function applyAthleteImport(state,clientId,payload){
  const client=state.clients[clientId];
  if(!client||client.mergedInto||payload.clientId!==clientId||payload.format!=='trail-athlete-import-v1'
    ||!payload.identity?.verifiedBy||!payload.identity?.evidenceRecordId)throw Error('Сначала проверь существующего спортсмена и основание сопоставления');
  const evidence=state.records[payload.identity.evidenceRecordId];
  if(!evidence||evidence.clientId!==clientId||payload.identity.workoutId&&!JSON.stringify(evidence).includes(payload.identity.workoutId))
    throw Error('Не найдено основание сопоставления теста с клиентом');
  const draft=C.clone(state),athlete=C.clone(payload.athlete),goal=payload.goal;
  if(goal){
    let existing=draft.goals[goal.id]||Object.values(draft.goals).find(g=>g.clientId===clientId&&!g.deletedAt&&C.normalizeSearch(g.title)===C.normalizeSearch(goal.title));
    if(existing&&existing.clientId!==clientId)throw Error('Цель принадлежит другому клиенту');
    if(!existing){
      existing={...goal,clientId,createdAt:goal.createdAt,updatedAt:goal.createdAt,deletedAt:null};
      draft.goals[goal.id]=existing;
    }
    athlete.goalId=existing.id;
  }
  mergeAthlete(draft.clients[clientId],athlete,{expectedCurrent:payload.expectedCurrent});
  for(const entry of payload.journal||[]){
    let existing=draft.records[entry.id];
    if(existing&&(existing.clientId!==clientId||existing.kind!=='journal'))throw Error('Конфликт записи журнала');
    if(!existing)existing=C.saveJournalEntry(draft,clientId,entry,entry.id);
    if(entry.references.some(ref=>!draft.clients[clientId].athlete.entries[ref]))throw Error('Не найдена связь журнала со спортивной записью');
    // A coach's edited journal text is preserved on reimport.
    existing.athleteRefs=[...new Set([...(existing.athleteRefs||[]),...entry.references])];
  }
  C.validateState(draft);
  if(sameAthleteValue(state,draft))return {changed:false};
  Object.assign(state,draft);return {changed:true};
}
