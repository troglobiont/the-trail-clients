"""Run interactively on your private server once, never in CI."""
import asyncio
import os
from pathlib import Path

async def main():
    from telethon import TelegramClient
    path = Path(os.environ.get("TELEGRAM_SESSION", "./server/data/telegram"))
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    client = TelegramClient(str(path), int(os.environ["TELEGRAM_API_ID"]), os.environ["TELEGRAM_API_HASH"])
    await client.start()
    try:
        print("Личный аккаунт подключён. Найди нужный ID для явной привязки клиента:")
        async for dialog in client.iter_dialogs():
            if dialog.is_user:
                print(dialog.id, dialog.name)
    finally:
        await client.disconnect()

if __name__ == "__main__":
    asyncio.run(main())
