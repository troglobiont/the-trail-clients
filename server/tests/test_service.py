import os
from pathlib import Path
import tempfile
import unittest
import asyncio
from types import SimpleNamespace
from unittest.mock import patch
from server.service import authorized, cached_operation, validate_result, telegram_send, transcribe, telegram_search, telegram_status

class ServiceTests(unittest.TestCase):
    def test_auth_never_accepts_unconfigured_service(self):
        self.assertFalse(authorized("Bearer ", ""))
        self.assertFalse(authorized("Bearer short", "short"))
        self.assertTrue(authorized("Bearer " + "x" * 32, "x" * 32))
        self.assertFalse(authorized("Bearer " + "y" * 32, "x" * 32))

    def test_durable_idempotency_and_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"TRAIL_DATA_DIR": tmp}):
            calls = []
            def work():
                calls.append(True)
                return {"messageId": "123"}
            self.assertEqual(cached_operation("request-1", {"text": "hello"}, work), {"messageId": "123"})
            self.assertEqual(cached_operation("request-1", {"text": "hello"}, work), {"messageId": "123"})
            self.assertEqual(len(calls), 1)
            with self.assertRaises(ValueError):
                cached_operation("request-1", {"text": "changed"}, work)

    def test_agent_cannot_reference_other_client_goal(self):
        payload = {"client": {"id": "a"}, "goals": [{"id": "g", "clientId": "b"}]}
        with self.assertRaises(ValueError):
            validate_result({"changes": [{"type": "goal", "id": "g", "title": "Run", "status": "Согласовано"}]}, payload)

    def test_invalid_date_and_ambiguous_changes_rejected(self):
        payload = {"client": {"id": "a"}, "goals": []}
        with self.assertRaises(ValueError):
            validate_result({"changes": [{"type": "task", "title": "Ask", "due": "2026-02-30"}]}, payload)
        with self.assertRaises(ValueError):
            validate_result({"question": "When?", "changes": [{"type": "task", "title": "Ask"}]}, payload)

    def test_telegram_only_explicit_private_recipient_and_template(self):
        with self.assertRaises(ValueError):
            telegram_send({"peerId": "-100123", "text": "Привет! Как дела?"})
        with self.assertRaises(ValueError):
            telegram_send({"peerId": "123", "text": "Unrequested generated message"})
        with self.assertRaises(ValueError):
            telegram_send({"peerId": "123", "accountPeerId": "wrong", "text": "Привет! Как дела?"})

    def test_invalid_voice_never_calls_upstream(self):
        with self.assertRaises(ValueError):
            transcribe({"mime": "text/html", "audio": "invalid"})

    def test_telegram_status_without_credentials_does_not_attempt_login(self):
        with patch.dict(os.environ, {}, clear=True), patch('server.service.telegram_operation') as operation:
            self.assertEqual(telegram_status({}), {"connected": False, "reason": "not-configured"})
            operation.assert_not_called()

    def test_contact_search_filters_and_never_returns_phone_or_other_private_fields(self):
        class User(SimpleNamespace):
            pass
        users = [User(id=101, first_name='Тренер', last_name='Тестовый', username='test_coach', phone='private', is_self=False),
                 User(id=102, first_name='Другой', last_name='Контакт', username='other'),
                 User(id=103, first_name='Тренер', bot=True), User(id=104, first_name='Тренер', is_self=True)]
        class Client:
            async def __call__(self, _request):
                return SimpleNamespace(users=users)
        functions = SimpleNamespace(contacts=SimpleNamespace(GetContactsRequest=lambda **kw: kw))
        def operation(fn):
            return asyncio.run(fn(Client(), functions, SimpleNamespace(User=User)))
        with patch('server.service.telegram_operation', operation):
            result = telegram_search({'query': 'тренер тестовый'})
            self.assertEqual(result, {'contacts': [{'peerId':'101','displayName':'Тренер Тестовый','username':'test_coach'}]})

    def test_contact_search_falls_back_to_existing_private_dialogs(self):
        class User(SimpleNamespace):
            pass
        class Client:
            async def __call__(self, _request):
                return SimpleNamespace(users=[])
            async def iter_dialogs(self, limit):
                yield SimpleNamespace(entity=User(id=101, first_name='Личный', last_name='Контакт', username=None))
                yield SimpleNamespace(entity=SimpleNamespace(id=103, title='Личный контакт'))
        functions = SimpleNamespace(contacts=SimpleNamespace(GetContactsRequest=lambda **kw: kw))
        def operation(fn):
            return asyncio.run(fn(Client(), functions, SimpleNamespace(User=User)))
        with patch('server.service.telegram_operation', operation):
            self.assertEqual(telegram_search({'query':'личный контакт'}),
                {'contacts':[{'peerId':'101','displayName':'Личный Контакт','username':None}]})

    def test_username_resolution_excludes_groups_and_invalid_queries_never_connect(self):
        class User(SimpleNamespace):
            pass
        class Client:
            async def get_entity(self, query):
                return SimpleNamespace(id=123, title='Group')
        def operation(fn):
            return asyncio.run(fn(Client(), None, SimpleNamespace(User=User)))
        with patch('server.service.telegram_operation', operation):
            self.assertEqual(telegram_search({'query':'@test_group'}), {'contacts':[]})
        with patch('server.service.telegram_operation') as op:
            for query in ['', 'a', '@', '@invalid/path', ['name']]:
                with self.assertRaises(ValueError):
                    telegram_search({'query':query})
            op.assert_not_called()

    def test_confirmed_name_alias_is_scoped_to_owner_and_returns_verified_user(self):
        class User(SimpleNamespace):
            pass
        class Client:
            async def __call__(self, _request):
                return SimpleNamespace(users=[])
            async def get_me(self):
                return SimpleNamespace(id=9001)
            async def get_entity(self, peer_id):
                self.asserted_peer = peer_id
                return User(id=102, first_name='Короткое имя', username='test_contact')
        client = Client()
        functions = SimpleNamespace(contacts=SimpleNamespace(GetContactsRequest=lambda **kw: kw))
        def operation(fn):
            return asyncio.run(fn(client, functions, SimpleNamespace(User=User)))
        with patch('server.service.telegram_operation', operation), patch.dict(os.environ, {
            'TELEGRAM_OWNER_ID':'9001', 'TELEGRAM_CONTACT_ALIASES':'{"Тестовый Тренёр":"102"}'
        }):
            self.assertEqual(telegram_search({'query':'тренер тестовый'}), {'contacts':[{'peerId':'102','displayName':'Короткое имя','username':'test_contact'}]})
            self.assertEqual(client.asserted_peer, 102)
            with patch.dict(os.environ, {'TELEGRAM_OWNER_ID':'9002'}), self.assertRaises(RuntimeError):
                telegram_search({'query':'Тестовый Тренёр'})

if __name__ == "__main__":
    unittest.main()
