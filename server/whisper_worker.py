"""One short audio file, local CPU inference only. No model downloads at runtime."""
import base64
import io
import json
import os
from pathlib import Path
import sys

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'


def main():
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
    model_path = Path(sys.argv[1])
    payload = json.loads(sys.stdin.read(9 * 1024 * 1024))
    audio = base64.b64decode(payload['audio'], validate=True)
    samples = decode_audio(io.BytesIO(audio), sampling_rate=16000)
    if not 0 < len(samples) <= 120 * 16000:
        raise ValueError('Audio duration exceeds two minutes')
    model = WhisperModel(str(model_path), device='cpu', compute_type='int8', cpu_threads=4,
                         num_workers=1, local_files_only=True)
    segments, _ = model.transcribe(samples, language='ru', beam_size=3, vad_filter=True,
                                   condition_on_previous_text=False)
    text = ' '.join(segment.text.strip() for segment in segments).strip()
    print(json.dumps({'text': text}, ensure_ascii=False))


if __name__ == '__main__':
    main()
