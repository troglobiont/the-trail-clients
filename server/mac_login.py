"""Interactive personal-account login. All sensitive input stays in the terminal."""
import asyncio
import datetime as dt
from getpass import getpass
import json
import os
from pathlib import Path
import re
import sys

def save_config(path, settings):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as out:
        os.chmod(temporary, 0o600)
        json.dump(settings, out, indent=2)
    temporary.replace(path)

async def main(path):
    from telethon import TelegramClient, errors
    os.umask(0o077)
    config = json.loads(path.read_text())
    print('THE.TRAIL — вход в личный Telegram. Ввод скрыт; данные не попадают в чат.')
    if not config.get('TELEGRAM_API_ID') or not config.get('TELEGRAM_API_HASH'):
        api_id = getpass('API ID из my.telegram.org: ').strip()
        api_hash = getpass('API hash из my.telegram.org: ').strip()
        if not re.fullmatch(r'[1-9][0-9]{0,10}', api_id) or not re.fullmatch(r'[a-fA-F0-9]{32}', api_hash):
            raise ValueError('Проверь API ID и API hash на странице Telegram Core.')
        config.update(TELEGRAM_API_ID=api_id, TELEGRAM_API_HASH=api_hash)
        save_config(path, config)
    client = TelegramClient(config['TELEGRAM_SESSION'], int(config['TELEGRAM_API_ID']), config['TELEGRAM_API_HASH'],
                            device_model='THE.TRAIL Clients — Mac', app_version='0.1.4')
    await client.connect()
    try:
        if not await client.is_user_authorized():
            phone = getpass('Твой номер Telegram в международном формате: ').strip()
            if not re.fullmatch(r'\+[1-9][0-9]{6,14}', phone):
                raise ValueError('Нужен номер вида +381… или +7…')
            sent = await client.send_code_request(phone)
            print('Код придёт в официальный Telegram. Введи его здесь; символы не отображаются.')
            code = getpass('Код Telegram: ').strip().replace(' ', '')
            try:
                await client.sign_in(phone, code=code, phone_code_hash=sent.phone_code_hash)
            except errors.SessionPasswordNeededError:
                await client.sign_in(password=getpass('Облачный пароль Telegram: '))
        me = await client.get_me()
        if me.bot:
            raise ValueError('Нужен личный аккаунт, а не бот.')
        account = {'peerId': str(me.id), 'displayName': ' '.join(filter(None, [me.first_name, me.last_name])), 'username': me.username}
        config['TELEGRAM_OWNER_ID'] = str(me.id)
        save_config(path, config)
        save_config(path.parent / 'authorization-status.json', {'connected': True, 'account': account, 'at': dt.datetime.now(dt.timezone.utc).isoformat()})
        print('Аккаунт подключён: ' + account['displayName'] + (' · @' + me.username if me.username else ''))
        print('Сессия сохранена локально. Сообщения не отправлялись.')
    finally:
        await client.disconnect()

if __name__ == '__main__':
    try:
        asyncio.run(main(Path(sys.argv[1]).resolve()))
    except (KeyboardInterrupt, EOFError):
        print('\nВход отменён. Можно запустить снова.')
    except Exception as error:
        # RPC exceptions may include input values; do not print their messages.
        print('Вход не завершён (' + type(error).__name__ + '). Проверь данные и повтори.')
        sys.exit(1)
