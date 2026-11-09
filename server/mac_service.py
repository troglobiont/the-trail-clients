"""Start the local test API using a private, user-owned configuration file."""
import json
import os
from pathlib import Path
import sys

if __name__ == '__main__':
    os.umask(0o077)
    settings = json.loads(Path(sys.argv[1]).read_text())
    for key, value in settings.items():
        if key.startswith(('TRAIL_', 'TELEGRAM_', 'OPENAI_')):
            os.environ[key] = str(value)
    from server.service import main
    main()
