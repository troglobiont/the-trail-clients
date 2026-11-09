export function parseConnection(text){
  if(typeof text!=='string'||text.length>6000)throw Error('Нужен код подключения с твоего Mac');
  let value;try{value=JSON.parse(text.trim());}catch{throw Error('Вставь весь текст из QR-кода подключения');}
  if(!value||value.format!=='the-trail-connection-v1'||Object.keys(value).some(k=>!['format','serviceURL','key'].includes(k)))throw Error('Это не код подключения THE.TRAIL');
  let url;try{url=new URL(value.serviceURL);}catch{throw Error('Некорректный адрес сервиса');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Нужен HTTPS-адрес сервиса без дополнительных данных');
  if(typeof value.key!=='string'||value.key.length<24||value.key.length>4096||/[^A-Za-z0-9_-]/.test(value.key))throw Error('Некорректный ключ подключения');
  return {serviceURL:url.origin,key:value.key};
}
