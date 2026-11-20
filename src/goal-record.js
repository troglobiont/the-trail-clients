import {raceCatalog,GOAL_TYPES} from './client-details.js';

const words=value=>String(value||'').toLowerCase().replace(/торник/g,'tornik').replace(/рейс|рэйс/g,'race').normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[\p{L}\d]+/gu)||[];
const tokens=value=>words(value).filter(word=>!['race','trail','run','the','marathon','трейл','марафон','полумарафон','старт'].includes(word)&&!/^20\d\d$/.test(word));
export function goalProposal(state,text,options={}){
  const lower=String(text).toLowerCase(),title=String(text).trim().slice(0,500),input=new Set(words(text)),year=lower.match(/\b20\d{2}\b/)?.[0];
  const candidates=raceCatalog(state,{includeRecommended:true}).filter(race=>{
    if(year&&!race.date.startsWith(year))return false;
    const names=[race.name,race.shortName,...(race.searchNames||[])].filter(Boolean);
    return names.some(name=>{const parts=tokens(name);return parts.length&&parts.every(part=>input.has(part));});
  });
  const race=candidates.length===1?candidates[0]:null;
  const type=options.goalType|| (race||candidates.length||/старт|марафон|полумарафон|трейл|trail|race|забег|соревнован/.test(lower)?'race':/вес|похуд|здоров|форму|кардио/.test(lower)?'fitness':/общени|компани|клуб|кемп/.test(lower)?'community':/регуляр|привыч|начать бег|бегать/.test(lower)?'regularity':'other');
  let status=options.goalStatus;
  if(!status)status=/рабочая цель тренера|цель тренера/.test(lower)?'Рабочая цель тренера':/предлагаю|предложить|предложение тренера/.test(lower)?'Предложение тренера':/согласовал|согласован|договорил|зарегистрирова/.test(lower)?'Согласовано':'Желание клиента';
  let distance=null;
  if(type==='race'){
    const explicit=lower.match(/(\d+(?:[.,]\d+)?)\s*(?:км|km)(?![\p{L}\d])/u);
    if(explicit)distance=explicit[1].replace(',','.')+' км';
    else if(/максимальн|сам(?:ая|ую) длинн|длинн(?:ая|ую) дистанц/.test(lower)&&race?.distances?.length){
      const numeric=race.distances.map(label=>({label,km:Number(label.match(/^\s*(\d+(?:[.,]\d+)?)\s*(?:км|km)\s*$/i)?.[1]?.replace(',','.'))}));
      if(numeric.every(item=>Number.isFinite(item.km)))distance=numeric.sort((a,b)=>b.km-a.km)[0].label;
    }
  }
  return {title:race&&type==='race'?[race.name,year||race.date.slice(0,4),distance].filter(Boolean).join(' · '):title,status,type:Object.hasOwn(GOAL_TYPES,type)?type:'other',
    raceId:type==='race'?race?.id||null:null,raceStage:type==='race'&&race?(/зарегистрирова/.test(lower)?'registered':'selected'):'choosing',distance,
    matched:!!race,notice:type!=='race'?'':race?'Старт найден в каталоге. Проверь дату и дистанцию.':candidates.length?'Найдено несколько стартов. Выбери нужный.':'Точный старт в каталоге не найден. Можно выбрать его или добавить с датой.'};
}
