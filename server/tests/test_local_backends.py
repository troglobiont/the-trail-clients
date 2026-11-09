import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from server.local_backends import codex_parse, process_environment
from server.service import parse_record, transcribe, response_schema


class LocalBackendsTests(unittest.TestCase):
    def payload(self):
        return {'client': {'id': 'a'}, 'record': {'id': 'r', 'clientId': 'a', 'text': 'Завтра спросить самочувствие'}, 'goals': []}

    def test_child_environment_does_not_inherit_service_or_api_credentials(self):
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'private', 'CODEX_API_KEY': 'private',
                                     'TRAIL_SERVICE_TOKEN': 'private', 'TELEGRAM_API_HASH': 'private', 'HOME': '/home/test'}, clear=True):
            self.assertEqual(process_environment(), {'HOME': '/home/test'})

    def test_codex_uses_stdin_schema_and_disables_tools_and_cleans_job(self):
        final = {'summary': 'ok', 'question': None, 'changes': []}
        jobs = []
        def execute(command, **options):
            if command[1:3] == ['login', 'status']:
                return SimpleNamespace(returncode=0, stdout='', stderr='Logged in using ChatGPT')
            self.assertIn('--ignore-user-config', command)
            self.assertIn('--ephemeral', command)
            self.assertEqual(command[command.index('--sandbox') + 1], 'read-only')
            self.assertIn('shell_tool', command)
            self.assertIn('multi_agent', command)
            self.assertEqual(command[-1], '-')
            self.assertNotIn('Завтра', ' '.join(command))
            self.assertIn('Завтра', options['input'])
            self.assertNotIn('OPENAI_API_KEY', options['env'])
            output = Path(command[command.index('--output-last-message') + 1])
            jobs.append(output.parent)
            output.write_text(json.dumps(final))
            return SimpleNamespace(returncode=0, stdout=json.dumps({'type': 'item.completed', 'item': {'type': 'error', 'message': 'Optional tool unavailable'}}) + '\n' + json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message'}}), stderr='')
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'TRAIL_DATA_DIR': folder}), patch('server.local_backends.subprocess.run', execute):
            self.assertEqual(codex_parse(self.payload(), 'Extract JSON', response_schema()), final)
            self.assertTrue(jobs)
            self.assertFalse(jobs[0].exists())

    def test_codex_failure_never_falls_back_to_billed_api(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'TRAIL_AGENT_BACKEND': 'codex', 'TRAIL_DATA_DIR': folder, 'OPENAI_API_KEY': 'saved-but-unused'}), patch('server.local_backends.codex_parse', side_effect=RuntimeError('Not logged in')), patch('server.service.openai_request') as upstream:
            with self.assertRaises(RuntimeError):
                parse_record(self.payload())
            upstream.assert_not_called()

    def test_codex_result_still_cannot_change_a_foreign_goal(self):
        result = {'changes': [{'type': 'goal', 'id': 'other', 'title': 'Run', 'status': 'Согласовано'}]}
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'TRAIL_AGENT_BACKEND': 'codex', 'TRAIL_DATA_DIR': folder}), patch('server.local_backends.codex_parse', return_value=result), self.assertRaises(ValueError):
            parse_record(self.payload())

    def test_local_audio_is_idempotent_and_never_uses_openai(self):
        payload = {'idempotencyKey': 'test-audio', 'mime': 'audio/webm;codecs=opus', 'audio': base64.b64encode(b'fake audio').decode()}
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'TRAIL_VOICE_BACKEND': 'local', 'TRAIL_DATA_DIR': folder}), patch('server.local_backends.local_transcribe', return_value={'text': 'Завтра спросить'}) as local, patch('server.service.openai_request') as upstream:
            self.assertEqual(transcribe(payload), {'text': 'Завтра спросить'})
            self.assertEqual(transcribe(payload), {'text': 'Завтра спросить'})
            local.assert_called_once_with(b'fake audio', 'audio/webm')
            upstream.assert_not_called()

    def test_timeouts_and_tool_actions_are_not_accepted_as_results(self):
        for failure in ('timeout', 'tool'):
            def execute(command, **options):
                if command[1:3] == ['login', 'status']:
                    return SimpleNamespace(returncode=0, stdout='Logged in using ChatGPT', stderr='')
                if failure == 'timeout':
                    raise subprocess.TimeoutExpired(command, 50)
                output = Path(command[command.index('--output-last-message') + 1])
                output.write_text('{"changes": []}')
                return SimpleNamespace(returncode=0, stdout=json.dumps({'type': 'item.completed', 'item': {'type': 'command_execution'}}), stderr='')
            with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'TRAIL_DATA_DIR': folder}), patch('server.local_backends.subprocess.run', execute), self.assertRaises(RuntimeError):
                codex_parse(self.payload(), 'JSON', response_schema())


if __name__ == '__main__':
    unittest.main()
