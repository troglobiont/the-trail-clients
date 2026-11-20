export function syncIndicatorState({view,pending=false,online=true,saving=false,saveError=false}={}) {
  let status=saveError?'save-error':saving?'saving':view?.status||'local';
  if(!saveError&&!saving) {
    if(status==='disconnected')status='local';
    else if(!online&&!['working','conflict','local'].includes(status))status='offline';
    else if(pending&&status==='synced')status='pending';
  }
  const definitions={
    local:['off','Синхронизация не подключена','Открыть настройки синхронизации'],
    synced:['check','Синхронизировано','Проверить синхронизацию сейчас'],
    pending:['upload','Есть изменения для синхронизации','Синхронизировать сейчас'],
    working:['refresh','Синхронизация…','Дождись завершения'],
    offline:['off','Нет сети','Повторить попытку синхронизации'],
    error:['warning','Не удалось синхронизировать','Повторить попытку синхронизации'],
    conflict:['warning','Нужно выбрать версию записей','Открыть сравнение версий'],
    saving:['dots','Сохраняю на устройстве…','Дождись сохранения'],
    'save-error':['warning','Изменение не сохранено на устройстве','Посмотреть пояснение']
  };
  const [icon,label,action]=definitions[status]||definitions.local;
  return {status,icon,label,action,disabled:['working','saving'].includes(status),
    detail:status==='error'?view?.error||'':status==='offline'&&pending?'Изменения сохранены на устройстве и ждут отправки.':''};
}

const NS='http://www.w3.org/2000/svg';
function node(document,tag,attributes={}) {
  const element=document.createElementNS(NS,tag);
  for(const [name,value] of Object.entries(attributes))element.setAttribute(name,String(value));
  return element;
}
function iconBase(document) {
  return node(document,'svg',{viewBox:'0 0 32 32',width:28,height:28,fill:'none',stroke:'currentColor','stroke-width':1.8,
    'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'});
}
export function cloudIcon(document,type='off') {
  const svg=iconBase(document);
  svg.append(node(document,'path',{d:'M8.5 24H24a6 6 0 0 0 .7-12 9 9 0 0 0-17.2 1.2A5.6 5.6 0 0 0 8.5 24Z'}),
    node(document,'circle',{cx:24,cy:24,r:7,class:'sync-badge-bg',stroke:'none'}));
  const paths={check:'M20.5 24l2.3 2.3 4.3-4.6',upload:'M24 28v-8m-3 3 3-3 3 3',
    warning:'M24 20v5m0 3h.01',off:'M21 27l6-6',refresh:'M20 23a4 4 0 1 1 1 4m-1-7v4h4'};
  if(type==='dots')for(const x of [20.5,24,27.5])svg.append(node(document,'circle',{cx:x,cy:24,r:.8,fill:'currentColor',stroke:'none'}));
  else svg.append(node(document,'path',{d:paths[type]||paths.off,class:type==='refresh'?'sync-badge-mark':''}));
  return svg;
}

// A simple original eight-spoked wheel, drawn for this interface.
export function settingsWheel(document) {
  const svg=iconBase(document);
  svg.append(node(document,'circle',{cx:16,cy:16,r:10.5}),node(document,'circle',{cx:16,cy:16,r:3}));
  for(let i=0;i<8;i++) {
    const angle=i*Math.PI/4;
    const point=radius=>({x:16+Math.cos(angle)*radius,y:16+Math.sin(angle)*radius});
    const start=point(3),end=point(13);
    svg.append(node(document,'line',{x1:start.x,y1:start.y,x2:end.x,y2:end.y}),
      node(document,'circle',{cx:end.x,cy:end.y,r:1,fill:'currentColor',stroke:'none'}));
  }
  return svg;
}
