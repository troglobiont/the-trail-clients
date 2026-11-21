import assert from 'node:assert/strict';
import test from 'node:test';
import {failedTelegramAttempt,prepareTelegramAttempt,sameTelegramDestination,telegramDeliveryNotice} from '../src/telegram-delivery.js';

const binding={peerId:'123',accountPeerId:'456'};
const first={key:'message-1',text:'Привет! Как дела?',taskId:'task-1'};
const next={key:'message-2',text:'Привет! Как самочувствие?',taskId:'task-2'};

test('DNS or rejected key before an uncertain request keeps other templates available',()=>{
  for(const message of ['Unable to resolve host: no address associated with hostname','Проверь ключ сервиса']){
    const operation=prepareTelegramAttempt(null,binding,first);
    const failure=failedTelegramAttempt(operation,null,Error(message));
    assert.equal(failure.delivery,'not-sent');
    assert.match(telegramDeliveryNotice(failure),/Заготовка не отправлена/);
    assert.equal(prepareTelegramAttempt(failure,binding,next).key,next.key);
  }
});

test('a retry uses the same id, task and recipient even after a restart or a later DNS error',()=>{
  const previous={...first};
  const retry=prepareTelegramAttempt(previous,binding,{...first,key:'message-3',taskId:'task-3'});
  assert.equal(retry.key,first.key);
  assert.equal(retry.taskId,first.taskId);
  assert.equal(retry.accountPeerId,binding.accountPeerId);
  const failure=failedTelegramAttempt(retry,previous,Error('UnknownHostException'));
  assert.equal(failure.delivery,'unknown');
  assert.match(telegramDeliveryNotice(failure),/Перед ручной отправкой проверь чат/);
  assert.throws(()=>prepareTelegramAttempt(failure,binding,next),/предыдущую попытку/);
  assert(!sameTelegramDestination({...binding,accountPeerId:'777'},failure));
  assert.throws(()=>prepareTelegramAttempt(failure,{...binding,peerId:'888'},first),/Получатель изменился/);
});

test('tunnel failures and lost confirmations never imply that Telegram did not receive the message',()=>{
  for(const message of ['Сервис недоступен (530)','Read timed out','Сервис не подтвердил отправку']){
    const operation=prepareTelegramAttempt(null,binding,first);
    const failure=failedTelegramAttempt(operation,null,Error(message));
    assert.equal(failure.delivery,'unknown');
    assert.equal(prepareTelegramAttempt(failure,binding,{...first,key:'message-3'}).key,first.key);
  }
});
