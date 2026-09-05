"""Acceptance-only worker that crosses the project submission boundary then fails."""

from __future__ import annotations

import json
import sys
import time
import uuid


project_id = str(uuid.uuid4())
print(json.dumps({"event": "worker_started", "ts": time.time()}), flush=True)
print(
    json.dumps(
        {"event": "project_id", "projectId": project_id, "ts": time.time()}
    ),
    flush=True,
)
print(
    json.dumps(
        {
            "event": "worker_finished",
            "ok": False,
            "exit_code": 97,
            "projectId": project_id,
            "ts": time.time(),
        }
    ),
    flush=True,
)
raise SystemExit(97)
