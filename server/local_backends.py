"""Private Mac backends. Reuse supported Codex login; never export auth tokens."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile


def process_environment():
    # Child processes must not receive Telegram/service/API credentials.
    names = ('HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL',
             'CODEX_HOME', 'SSL_CERT_FILE', 'CODEX_CA_CERTIFICATE')
    return {name: os.environ[name] for name in names if name in os.environ}


def codex_ready():
    binary = os.environ.get('TRAIL_CODEX_BIN', 'codex')
    try:
        result = subprocess.run([binary, 'login', 'status'], env=process_environment(),
                                capture_output=True, text=True, timeout=8)
        return result.returncode == 0 and 'Logged in using ChatGPT' in result.stdout + result.stderr
    except (OSError, subprocess.TimeoutExpired):
        return False


def codex_parse(payload, instructions, schema):
    if not codex_ready():
        raise RuntimeError('Войди в Codex на Mac через ChatGPT; API-ключ для этого режима не используется')
    directory = Path(os.environ.get('TRAIL_DATA_DIR', './server/data')) / 'codex-jobs'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    binary = os.environ.get('TRAIL_CODEX_BIN', 'codex')
    model = os.environ.get('TRAIL_CODEX_MODEL', 'gpt-6-luna')
    # A fresh job has no repository, plugins, MCP servers or inherited user config.
    # Shell, browser and delegation tools are disabled; only JSON extraction is needed.
    with tempfile.TemporaryDirectory(dir=directory, prefix='record-') as job:
        work = Path(job)
        schema_file, output_file = work / 'schema.json', work / 'result.json'
        schema_file.write_text(json.dumps(schema))
        command = [binary, 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
                   '--sandbox', 'read-only', '--model', model, '--color', 'never', '--json',
                   '--output-schema', str(schema_file), '--output-last-message', str(output_file),
                   '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
                   '-c', 'project_doc_max_bytes=0', '-c', 'model_reasoning_effort="low"']
        for feature in ('shell_tool', 'unified_exec', 'multi_agent', 'apps', 'plugins',
                        'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser',
                        'image_generation', 'view_image', 'code_mode', 'code_mode_host', 'hooks',
                        'goals', 'skill_search', 'sleep_tool', 'memories'):
            command.extend(['--disable', feature])
        prompt = instructions + '\nВерни только JSON по схеме. Не используй инструменты и файлы. Данные ниже относятся только к одному клиенту.\n'
        prompt += json.dumps(payload, ensure_ascii=False)
        try:
            result = subprocess.run(command + ['-'], input=prompt, cwd=work,
                                    env=process_environment(), capture_output=True, text=True, timeout=50)
        except subprocess.TimeoutExpired:
            raise RuntimeError('Codex не ответил за 50 секунд. Запись сохранена; можно повторить') from None
        except OSError:
            raise RuntimeError('Codex на Mac недоступен') from None
        if result.returncode or not output_file.exists():
            raise RuntimeError('Codex не обработал запись. Проверь вход и доступные лимиты на Mac')
        if output_file.stat().st_size > 128 * 1024:
            raise RuntimeError('Слишком большой ответ Codex')
        # Fail closed if the worker attempted an action rather than pure extraction.
        for line in result.stdout.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get('type') in ('item.started', 'item.completed') and event.get('item', {}).get('type') not in ('agent_message', 'reasoning', 'error'):
                raise RuntimeError('Codex попытался использовать инструмент; результат не применён')
        try:
            return json.loads(output_file.read_text())
        except (ValueError, UnicodeError):
            raise RuntimeError('Codex не вернул корректный JSON; запись сохранена') from None


def local_voice_ready():
    return bool(os.environ.get('TRAIL_SPEECH_PYTHON') and Path(os.environ['TRAIL_SPEECH_PYTHON']).is_file()
                and os.environ.get('TRAIL_WHISPER_MODEL') and (Path(os.environ['TRAIL_WHISPER_MODEL']) / 'model.bin').is_file())


def local_transcribe(audio, mime):
    if not local_voice_ready():
        raise RuntimeError('Локальная расшифровка на Mac ещё не настроена')
    command = [os.environ['TRAIL_SPEECH_PYTHON'], str(Path(__file__).with_name('whisper_worker.py')),
               os.environ['TRAIL_WHISPER_MODEL']]
    try:
        result = subprocess.run(command, input=json.dumps({'audio': base64.b64encode(audio).decode(), 'mime': mime}),
                                env=process_environment(), capture_output=True, text=True, timeout=50)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Расшифровка заняла больше 50 секунд. Аудио сохранено; попробуй более короткую запись') from None
    except OSError:
        raise RuntimeError('Не удалось запустить локальную расшифровку') from None
    if result.returncode:
        raise RuntimeError('Не удалось распознать аудио на Mac. Запись сохранена')
    try:
        value = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError('Локальная расшифровка не вернула текст') from None
    if not isinstance(value.get('text'), str) or not value['text'].strip() or len(value['text']) > 16000:
        raise RuntimeError('Речь не распознана. Попробуй ещё раз')
    return {'text': value['text'].strip()}
