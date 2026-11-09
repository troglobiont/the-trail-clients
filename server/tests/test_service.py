import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from server.service import authorized, cached_operation, validate_result, telegram_send, transcribe

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

    def test_invalid_voice_never_calls_upstream(self):
        with self.assertRaises(ValueError):
            transcribe({"mime": "text/html", "audio": "invalid"})

if __name__ == "__main__":
    unittest.main()
