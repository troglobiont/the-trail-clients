const account=binding=>binding?.accountPeerId||null;

export function sameTelegramDestination(binding,attempt){
  return Boolean(binding?.peerId)&&(!attempt.peerId||binding.peerId===attempt.peerId&&account(binding)===account(attempt));
}

export function prepareTelegramAttempt(previous,binding,{key,text,taskId}){
  if(!binding?.peerId)throw Error('Сначала привяжи переписку');
  if(previous&&!sameTelegramDestination(binding,previous))throw Error('Получатель изменился. Сначала закрой предыдущую попытку');
  const retry=previous?.text===text;
  if(previous&&!retry&&previous.delivery!=='not-sent')
    throw Error('Сначала проверь предыдущую попытку отправки');
  return {key:retry?previous.key:key,text,taskId:retry?previous.taskId:taskId,
    peerId:binding.peerId,accountPeerId:account(binding),delivery:'unknown'};
}

export function failedTelegramAttempt(operation,previous,error){
  const message=String(error?.message||'');
  const reason=/unable to resolve host|unknownhostexception|could not resolve host|err_name_not_resolved/i.test(message)
    ?'address':/проверь ключ сервиса|\bHTTP 401\b/i.test(message)
      ?'key':/сервис недоступен|timeout|timed out|failed to connect|unreachable|network/i.test(message)
        ?'service':'unconfirmed';
  // A definitive error on a retry cannot resolve a previous uncertain send.
  const uncertain=previous?.key===operation.key&&previous.delivery!=='not-sent';
  const delivery=!uncertain&&['address','key'].includes(reason)?'not-sent':'unknown';
  return {...operation,delivery,reason};
}

export function telegramDeliveryNotice(attempt){
  const reason={
    address:'Адрес сервиса Telegram недоступен.',
    key:'Сервис отклонил ключ подключения.',
    service:'Сервис Telegram не ответил. Проверь, доступен ли Mac.',
    unconfirmed:'Сервис не подтвердил отправку.'
  }[attempt.reason]||'Отправка не подтверждена.';
  return attempt.delivery==='not-sent'
    ?'Заготовка не отправлена. '+reason
    :reason+' Перед ручной отправкой проверь чат, чтобы не продублировать сообщение.';
}
