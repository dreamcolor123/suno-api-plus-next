#!/usr/bin/env python3
"""Public Suno Studio upload client.

This module is a clean-room, source-only implementation of the Fast Upload
workflow.  Credentials are supplied at runtime; no browser profile, cookie,
token, native extension, or private runtime is required.  The implementation
keeps the historical function names used by API Plus while making mutation
boundaries explicit and recoverable.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures as cf
import copy
import hashlib
import json
import math
import mimetypes
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import uuid
import wave
import tempfile
import threading
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

try:
    import numpy as np
except ImportError:  # imported lazily by audio helpers
    np = None

try:
    import requests
except ImportError:
    requests = None


_log_callback = None


def set_log_callback(callback):
    global _log_callback
    _log_callback = callback


def log(msg, flush=True):
    if _log_callback is not None:
        _log_callback(msg)
    else:
        print(msg, flush=flush)


BASE_DIR = pathlib.Path(__file__).resolve().parent
DEFAULT_TOKEN_FILE = pathlib.Path(
    os.environ.get("SUNO_TOKEN_FILE", str(BASE_DIR / "current_browser_token.json"))
)


class SubmissionUnknownError(RuntimeError):
    """A mutation may have reached Suno but its response was not observed."""

    submission_state = "submission_unknown"


class ProviderError(RuntimeError):
    """A deterministic provider failure before a mutation was committed."""

    submission_state = "not_submitted"


class CancelledError(RuntimeError):
    """No further mutation is allowed for a cancelled task."""


# Keep this compatibility name for clients that already classified the old
# worker's exception name.  Both names have the same no-replay semantics.
SubmissionUnknown = SubmissionUnknownError


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     default=str).encode()).hexdigest()


def _public_result(value: Any) -> Any:
    """Persist identifiers, not signed URLs, form credentials or provider text."""
    allowed = {"id", "clip_id", "clipId", "upload_id", "uploadId", "project_id",
               "projectId", "version_id", "versionId", "render_id", "renderId",
               "status", "type", "clips", "clip", "archived", "deleted"}
    if isinstance(value, list):
        return [_public_result(item) for item in value]
    if isinstance(value, dict):
        return {key: _public_result(item) for key, item in value.items() if key in allowed}
    if isinstance(value, (str, int, bool, float)) or value is None:
        return value
    return None


class MutationJournal:
    """Task-private write-ahead mutation log. Unknown entries never replay."""

    def __init__(self, path: pathlib.Path | str | None):
        self.path = pathlib.Path(path) if path else None
        self.lock = threading.RLock()
        self.value = {"version": 1, "operations": {}, "segments": {}}
        if self.path and self.path.exists():
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict) or loaded.get("version") != 1:
                raise SubmissionUnknownError("invalid mutation journal; manual reconciliation required")
            self.value.update(loaded)
        if not isinstance(self.value.get("operations"), dict):
            raise SubmissionUnknownError("invalid mutation journal operations; manual reconciliation required")
        if not isinstance(self.value.get("segments"), dict):
            self.value["segments"] = {}

    def write(self) -> None:
        if self.path:
            atomic_write_json(self.path, self.value)

    def get(self, key: str) -> dict[str, Any] | None:
        with self.lock:
            return copy.deepcopy(self.value["operations"].get(key))

    def begin(self, key: str, descriptor: Any) -> None:
        with self.lock:
            existing = self.value["operations"].get(key)
            if existing:
                if existing.get("fingerprint") != _fingerprint(descriptor):
                    raise SubmissionUnknownError("mutation parameters changed across resume")
                raise SubmissionUnknownError("mutation already journaled; reconciliation required")
            self.value["operations"][key] = {
                "fingerprint": _fingerprint(descriptor),
                "state": "submission_unknown", "started_at": time.time(),
            }
            self.write()

    def finish(self, key: str, response: Any, state: str = "complete") -> None:
        with self.lock:
            entry = self.value["operations"][key]
            entry.update(state=state, response=_public_result(response), finished_at=time.time())
            self.write()

    def segment(self, key: str, update: dict[str, Any] | None = None) -> dict[str, Any]:
        with self.lock:
            value = self.value["segments"].setdefault(key, {})
            if update:
                value.update(update)
                self.write()
            return copy.deepcopy(value)


def atomic_write_json(path: pathlib.Path | str, value: Any) -> None:
    """Write JSON via same-directory replace, preserving the last valid file."""

    target = pathlib.Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent)
    )
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def find_ffmpeg() -> str:
    """Find the bundled or system ffmpeg binary."""
    base = pathlib.Path(__file__).resolve().parent
    names = ["ffmpeg.exe", "ffmpeg"] if os.name == "nt" else ["ffmpeg", "ffmpeg.exe"]
    for name in names:
        candidate = base / name
        if candidate.is_file():
            return str(candidate)
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    raise RuntimeError("ffmpeg 未找到")


def decode_to_wav(src: pathlib.Path, wav_path: pathlib.Path):
    ffmpeg = find_ffmpeg()
    wav_path.parent.mkdir(parents=True, exist_ok=True)
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    subprocess.run(
        [ffmpeg, "-y", "-i", str(src), "-acodec", "pcm_s16le", "-ar", "44100", str(wav_path)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )


def read_wav_np(path: pathlib.Path):
    if np is None:
        raise RuntimeError("numpy is required")
    with wave.open(str(path), "rb") as w:
        ch = w.getnchannels()
        rate = w.getframerate()
        if w.getsampwidth() != 2:
            raise RuntimeError("只支持 16-bit PCM")
        raw = w.readframes(w.getnframes())
    arr = np.frombuffer(raw, dtype=np.int16).reshape(-1, ch)
    return arr, rate, ch


def write_wav_np(path: pathlib.Path, arr: "np.ndarray", rate: int, ch: int):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = np.ascontiguousarray(arr).astype(np.int16).tobytes()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(raw)


@dataclass
class Segment:
    index: Any
    path: pathlib.Path
    fileName: str
    srcStartSec: float
    srcEndSec: float
    nominalStartSec: float
    nominalEndSec: float
    timelineStartSec: float
    timelineEndSec: float
    duration: float
    fadeInSec: float
    fadeOutSec: float


def segment_from_manifest(item: Dict[str, Any]) -> Segment:
    return Segment(
        index=item["index"],
        path=pathlib.Path(item["path"]),
        fileName=item["fileName"],
        srcStartSec=float(item["srcStartSec"]),
        srcEndSec=float(item["srcEndSec"]),
        nominalStartSec=float(item["nominalStartSec"]),
        nominalEndSec=float(item["nominalEndSec"]),
        timelineStartSec=float(item["timelineStartSec"]),
        timelineEndSec=float(item["timelineEndSec"]),
        duration=float(item["duration"]),
        fadeInSec=float(item.get("fadeInSec", 0.0)),
        fadeOutSec=float(item.get("fadeOutSec", 0.0)),
    )


def split_audio(
    src: pathlib.Path,
    out_dir: pathlib.Path,
    target_sec: float,
    max_sec: float,
    search_sec: float,
    overlap_sec: float,
) -> Tuple[List[Segment], Dict]:
    """Decode, slow to quarter speed, and split into balanced upload clips.

    The inspected build labels this algorithm ``v2``.  It first transforms the
    audio with rubberband tempo/pitch 0.25, then balances the transformed audio
    into near-equal chunks capped around forty seconds.  This is the observable
    behavior of the supplied build; the CLI's historical tuning parameters are
    retained for API compatibility.
    """
    log("[split] starting audio segmentation")
    src, out_dir = pathlib.Path(src), pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    wav_full = out_dir / "decoded_original.wav"
    decode_to_wav(src, wav_full)
    arr, rate, ch = read_wav_np(wav_full)
    total_sec = len(arr) / rate

    ffmpeg = find_ffmpeg()
    wav_slow = out_dir / "decoded_slow.wav"
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    subprocess.run(
        [ffmpeg, "-y", "-i", str(wav_full), "-filter:a", "rubberband=tempo=0.25:pitch=0.25",
         "-acodec", "pcm_s16le", "-ar", "44100", str(wav_slow)],
        check=True,
        creationflags=creationflags,
    )
    arr_slow, rate_slow, ch_slow = read_wav_np(wav_slow)
    total_sec_slow = len(arr_slow) / rate_slow
    log("[split] 音频重置完成")

    # Native behavior produces equal-sized parts around 40 transformed seconds.
    num_segments = max(1, math.ceil(total_sec_slow / 40.0))
    cuts_slow = [total_sec_slow * i / num_segments for i in range(num_segments + 1)]
    seg_dir = out_dir / "segments"
    seg_dir.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^a-zA-Z0-9_\-]+", "_", src.stem).strip("_") or "audio"
    segs: List[Segment] = []
    for i in range(num_segments):
        src_start, src_end = cuts_slow[i], cuts_slow[i + 1]
        a, b = round(src_start * rate_slow), round(src_end * rate_slow)
        seg_arr = arr_slow[a:b]
        name = f"{stem}_part{i + 1:02d}_{src_start:.2f}s-{src_end:.2f}s.wav"
        seg_path = seg_dir / name
        write_wav_np(seg_path, seg_arr, rate_slow, ch_slow)
        segs.append(Segment(i + 1, seg_path, name, src_start, src_end, src_start, src_end,
                            src_start, src_end, src_end - src_start, 0.0, 0.0))

    manifest = {"algo_version": "v2"}
    atomic_write_json(
        out_dir / "split_manifest.json",
        {"algo_version": "v2", "source": str(src), "original_duration": total_sec,
         "segments": [{**s.__dict__, "path": str(s.path)} for s in segs]},
    )
    log(f"[DEBUG] segs length = {len(segs)}")
    return segs, manifest


API = "https://studio-api.prod.suno.com"


class SunoClient:
    def __init__(self, token: str, device_id: str = "", token_refresh=None,
                 journal_path: pathlib.Path | str | None = None,
                 cancelled=None):
        self.token = token
        self.device_id = device_id
        self.token_refresh = token_refresh
        self.session = requests.Session() if requests else None
        self.journal_path = pathlib.Path(journal_path) if journal_path else None
        self.cancelled = cancelled
        self.mutation_journal = MutationJournal(self.journal_path) if self.journal_path else None

    def browser_token(self):
        data = json.dumps({"timestamp": int(time.time() * 1000)}, separators=(",", ":"))
        return json.dumps({"token": base64.b64encode(data.encode()).decode()}, separators=(",", ":"))

    def headers(self) -> Dict[str, str]:
        h = {
            "Authorization": f"Bearer {self.token}",
            "Browser-Token": self.browser_token(),
            "Origin": "https://suno.com",
            "Referer": "https://suno.com/studio",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json, text/plain, */*",
        }
        if self.device_id:
            h["Device-Id"] = self.device_id
        return h

    def _journal(self, method: str, path: str, state: str, request_id: str,
                 status: int | None = None, error: str | None = None) -> None:
        if not self.journal_path:
            return
        # Legacy list journals remain readable for diagnostics, while new
        # requests use MutationJournal's keyed records below.
        if self.mutation_journal is None:
            return
        key = request_id
        entry = self.mutation_journal.get(key) or {"request_id": request_id,
                                                   "method": method, "path": path}
        entry.update(state=state, ts=time.time())
        if status is not None:
            entry["status"] = status
        if error:
            entry["error"] = str(error)[:500]
        self.mutation_journal.value["operations"][key] = entry
        self.mutation_journal.write()

    def begin_mutation(self, key: str, descriptor: Any) -> None:
        if self.mutation_journal:
            prior = self.mutation_journal.get(key)
            if prior:
                if prior.get("state") == "complete":
                    return
                raise SubmissionUnknownError(f"mutation {key} requires reconciliation")
            self.mutation_journal.begin(key, descriptor)

    def finish_mutation(self, key: str, response: Any = None,
                        state: str = "complete") -> None:
        if self.mutation_journal:
            self.mutation_journal.finish(key, response or {}, state)

    def api(self, method: str, path: str, json_body=None, timeout: int = 180,
            mutation_key: str | None = None):
        if not self.session:
            raise RuntimeError("requests is required for SunoClient")
        method = str(method).upper()
        mutation = method not in {"GET", "HEAD", "OPTIONS"}
        request_id = str(uuid.uuid4())
        if mutation:
            if callable(self.cancelled) and self.cancelled():
                raise ProviderError("upload cancelled before mutation")
            descriptor = {"method": method, "path": path, "body": json_body,
                          "mutation_key": mutation_key or ""}
            request_key = mutation_key or f"{method}:{path}:{_fingerprint(descriptor)}"
            if self.mutation_journal:
                prior = self.mutation_journal.get(request_key)
                if prior:
                    if prior.get("fingerprint") and prior.get("fingerprint") != _fingerprint(descriptor):
                        raise SubmissionUnknownError(
                            f"mutation {method} {path} parameters changed across resume"
                        )
                    state = str(prior.get("state") or "")
                    raise SubmissionUnknownError(
                        f"mutation {method} {path} was already journaled as {state}; reconcile before retry"
                    )
                self.mutation_journal.begin(request_key, descriptor)
            else:
                self._journal(method, path, "prepared", request_id)
        headers = self.headers()
        data = None
        if json_body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(json_body, separators=(",", ":"))
        attempts = 2 if not mutation else 1
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                response = self.session.request(
                    method, API + path, headers=headers, data=data, timeout=timeout
                )
            except Exception as exc:
                last_error = exc
                if mutation:
                    if self.mutation_journal:
                        self.mutation_journal.finish(request_key, {"error": str(exc)[:200]}, "submission_unknown")
                    else:
                        self._journal(method, path, "submission_unknown", request_id, error=exc)
                    raise SubmissionUnknownError(
                        f"{method} {path} transport result is unknown"
                    ) from exc
                if attempt + 1 < attempts:
                    time.sleep(min(1.0, 0.25 * (attempt + 1)))
                    continue
                raise
            if response.status_code == 401 and not mutation and self.token_refresh and attempt == 0:
                token_data = self.token_refresh()
                self.token = str(token_data.get("token") or "")
                headers = self.headers()
                if json_body is not None:
                    headers["Content-Type"] = "application/json"
                continue
            if 200 <= response.status_code < 300:
                if not response.content:
                    parsed: Any = {}
                else:
                    try:
                        parsed = response.json()
                    except Exception:
                        try:
                            parsed = json.loads(getattr(response, "text", "") or "{}")
                        except Exception as exc:
                            if mutation and self.mutation_journal:
                                self.mutation_journal.finish(request_key, {"status": response.status_code}, "submission_unknown")
                            raise SubmissionUnknownError(
                                f"{method} {path} returned an unreadable response"
                            ) from exc
                if mutation and self.mutation_journal:
                    self.mutation_journal.finish(request_key, parsed, "complete")
                elif mutation:
                    self._journal(method, path, "committed", request_id, response.status_code)
                return parsed
            if response.status_code >= 500 and mutation:
                if self.mutation_journal:
                    self.mutation_journal.finish(request_key, {"status": response.status_code}, "submission_unknown")
                else:
                    self._journal(method, path, "submission_unknown", request_id,
                                  response.status_code, getattr(response, "text", ""))
                raise SubmissionUnknownError(
                    f"{method} {path} returned {response.status_code}; submission is unknown"
                )
            if response.status_code >= 500 and attempt + 1 < attempts:
                time.sleep(min(1.0, 0.25 * (attempt + 1)))
                continue
            detail = (getattr(response, "text", "") or "")[:300]
            if mutation:
                if self.mutation_journal:
                    self.mutation_journal.finish(request_key, {"status": response.status_code}, "rejected")
                else:
                    self._journal(method, path, "rejected", request_id, response.status_code, detail)
            raise ProviderError(f"{method} {path} -> {response.status_code}: {detail}")
        raise RuntimeError(f"{method} {path} failed: {last_error}")


class UploadProcessingError(RuntimeError):
    def __init__(self, seg: Segment, status_payload: Dict):
        self.seg = seg
        super().__init__(f"{seg.fileName} 处理失败")


def _presigned_upload_descriptor(init: Dict[str, Any]) -> tuple[str, Dict[str, str], str]:
    """Normalize Suno's presigned POST response without dropping form fields."""

    if not isinstance(init, dict):
        raise ProviderError("audio upload initialization returned a non-object")
    nested = init.get("upload") if isinstance(init.get("upload"), dict) else {}
    url = str(init.get("url") or nested.get("url") or "").strip()
    fields_raw = init.get("fields") or nested.get("fields") or {}
    if not url:
        raise ProviderError("audio upload initialization did not return a presigned URL")
    if not isinstance(fields_raw, dict):
        raise ProviderError("audio upload initialization returned invalid presigned fields")
    fields = {str(key): str(value) for key, value in fields_raw.items()}
    upload_id = str(init.get("id") or init.get("upload_id") or init.get("uploadId")
                    or nested.get("id") or "").strip()
    if not upload_id:
        raise ProviderError("audio upload initialization did not return an upload id")
    return url, fields, upload_id


def upload_one(client: SunoClient, seg: Segment, idx: int, total: int, initialize_clip: bool = True) -> Dict:
    if requests is None:
        raise RuntimeError("requests is required for Fast Upload")
    log("[upload] 处理音频...")
    mime = mimetypes.guess_type(seg.fileName)[0] or "audio/wav"
    if mime == "audio/x-wav":
        mime = "audio/wav"
    segment_key = f"segment:{seg.index}:{seg.fileName}"
    init = client.api("POST", "/api/uploads/audio/", {"extension": seg.path.suffix.lstrip(".") or "wav",
                                                        "upload_type": "studio_file_upload"},
                      mutation_key=segment_key + ":init")
    upload_url, fields, upload_id = _presigned_upload_descriptor(init)
    if callable(client.cancelled) and client.cancelled():
        raise ProviderError("upload cancelled before presigned transfer")
    with seg.path.open("rb") as fp:
        try:
            # S3-compatible presigned POSTs require every field returned by the
            # initializer (policy, key, credential, signature, ...).  Sending
            # only the file appears to work with some mocks but yields a 403
            # in production and can leave an orphaned upload row.
            r = requests.post(upload_url, data=fields,
                              files={"file": (seg.fileName, fp, mime)},
                              timeout=(180, 1800), proxies={"http": None, "https": None})
        except Exception as exc:
            raise SubmissionUnknownError("presigned upload result is unknown") from exc
    if not r.ok:
        raise ProviderError(f"presigned upload failed: {r.status_code}")
    client.api("POST", f"/api/uploads/audio/{upload_id}/upload-finish/",
               {"upload_type": "studio_file_upload", "upload_filename": seg.fileName},
               mutation_key=segment_key + ":finish")

    poll_ms, max_poll = 1.8, 1600
    st = None
    for _ in range(max_poll):
        st = client.api("GET", f"/api/uploads/audio/{upload_id}/")
        # The service returns processing state under different keys across
        # versions; completion is also implied by an available clip id.
        status_row = st.get("data") if isinstance(st, dict) and isinstance(st.get("data"), dict) else st
        status_row = status_row if isinstance(status_row, dict) else {}
        status = str(status_row.get("status", status_row.get("state", ""))).lower()
        if status in {"complete", "completed", "ready", "success", "succeeded", "finished", "done"} or status_row.get("clip_id") or status_row.get("clipId"):
            break
        if re.search(r"failed|rejected|blocked|error", status):
            raise UploadProcessingError(seg, st)
        time.sleep(poll_ms)
    else:
        raise RuntimeError(f"Timeout waiting for {seg.fileName}")

    status_row = st.get("data") if isinstance(st, dict) and isinstance(st.get("data"), dict) else st
    status_row = status_row if isinstance(status_row, dict) else {}
    clip_id = status_row.get("clip_id") or status_row.get("clipId") or status_row.get("clip_id_value")
    if initialize_clip:
        ic = client.api("POST", f"/api/uploads/audio/{upload_id}/initialize-clip/",
                        {"is_audio_upload_tos_accepted": True},
                        mutation_key=segment_key + ":initialize")
        clip_id = ic.get("clip_id") or ic.get("clipId") or ic.get("song_id") or ic.get("id") or clip_id
    if initialize_clip and not clip_id:
        raise ProviderError(f"{seg.fileName} completed without a Clip id")
    row = {**seg.__dict__, "path": str(seg.path), "upload_id": upload_id, "uploadId": upload_id,
           "clip_id": clip_id, "clipId": clip_id}
    log("[upload] 音频处理完成")
    return row


def upload_all(
    client: SunoClient,
    segs: List[Segment],
    concurrency: int = 2,
    retry_min_sec: float = 0.2,
    retry_overlap_sec: float = 0.08,
    retry_max_depth: int = 3,
    initialize_clip: bool = True,
    progress_path: Optional[pathlib.Path] = None,
) -> List[Dict]:
    progress_file = pathlib.Path(progress_path) if progress_path else None
    cached: list[dict[str, Any]] = []
    if progress_file and progress_file.exists():
        try:
            value = json.loads(progress_file.read_text(encoding="utf-8"))
            if isinstance(value, list):
                cached = [row for row in value if isinstance(row, dict)]
        except Exception:
            # A torn/invalid checkpoint must not cause a second mutation.  The
            # caller can reconcile the journal and decide whether to resume.
            raise RuntimeError("UPLOAD_PROGRESS_INVALID")

    def identity(row: dict[str, Any]) -> tuple[str, str]:
        return (str(row.get("index") or ""), str(row.get("fileName") or row.get("file_name") or ""))

    cached_by_identity = {identity(row): row for row in cached}
    results: list[Optional[Dict]] = [None] * len(segs)
    for i, seg in enumerate(segs):
        existing = cached_by_identity.get((str(seg.index), seg.fileName))
        if existing is None:
            existing = next((row for row in cached
                             if str(row.get("fileName") or row.get("file_name") or "") == seg.fileName), None)
        path_matches = bool(existing) and (
            not existing.get("path")
            or pathlib.Path(str(existing.get("path"))).resolve() == seg.path.resolve()
        )
        if existing and path_matches and (existing.get("clip_id") or existing.get("clipId")
                         or (not initialize_clip and (existing.get("upload_id") or existing.get("uploadId")))):
            results[i] = dict(existing)

    def retryable(exc: BaseException) -> bool:
        if isinstance(exc, (SubmissionUnknownError, ProviderError, UploadProcessingError)):
            return False
        if requests and isinstance(exc, requests.exceptions.RequestException):
            return True
        text = str(exc).lower()
        return any(token in text for token in ("timeout", "temporarily", "connection reset", "503"))

    max_attempts = max(1, min(5, int(retry_max_depth)))

    def do_segment(i: int, seg: Segment) -> tuple[int, Dict]:
        if results[i] is not None:
            return i, results[i]  # type: ignore[return-value]
        last: BaseException | None = None
        for attempt in range(max_attempts):
            try:
                row = upload_one(client, seg, i, len(segs), initialize_clip)
                return i, row
            except BaseException as exc:
                last = exc
                if not retryable(exc) or attempt + 1 >= max_attempts:
                    raise
                backoff = max(float(retry_min_sec), float(retry_overlap_sec))
                time.sleep(min(2.0, backoff * (2 ** attempt)))
        raise RuntimeError(str(last))

    pending = [(i, seg) for i, seg in enumerate(segs) if results[i] is None]
    first_error: BaseException | None = None
    with cf.ThreadPoolExecutor(max_workers=max(1, min(8, concurrency))) as ex:
        futures = {ex.submit(do_segment, i, seg): i for i, seg in pending}
        for future in cf.as_completed(futures):
            try:
                i, row = future.result()
                results[i] = row
                if progress_file:
                    # Keep the stable input ordering so a resumed job can compare
                    # the checkpoint without relying on completion order.
                    atomic_write_json(progress_file, [item for item in results if item is not None])
            except BaseException as exc:
                # Drain every future before propagating.  A segment that
                # completed concurrently must still be checkpointed so resume
                # never re-submits it after a later segment fails.
                first_error = first_error or exc
    if first_error is not None:
        if progress_file:
            atomic_write_json(progress_file, [item for item in results if item is not None])
        raise first_error
    final = [item for item in results if item is not None]
    if progress_file:
        atomic_write_json(progress_file, final)
    return final


def create_studio_project(client: SunoClient, title: str) -> str:
    resp = client.api("POST", "/api/studio/create-project?title=" + urllib.parse.quote(title), None,
                      mutation_key="project:create:" + _fingerprint(title))
    pid = resp.get("id")
    if not pid:
        raise RuntimeError("创建项目失败")
    log(f"[project] 项目ID: {pid}")
    return pid


def _eq():
    return {
        "enabled": True,
        "band1": {"q": .7, "type": "highpass", "enabled": False, "frequency": 55., "gain": 0.},
        "band2": {"q": .7, "type": "lowshelf", "enabled": True, "frequency": 180., "gain": 1.},
        "band3": {"q": .7, "type": "peaking", "enabled": True, "frequency": 500., "gain": .5},
        "band4": {"q": .7, "type": "peaking", "enabled": True, "frequency": 1300., "gain": -.5},
        "band5": {"q": .7, "type": "highshelf", "enabled": True, "frequency": 3500., "gain": 1.},
        "band6": {"q": .7, "type": "lowpass", "enabled": False, "frequency": 8500., "gain": 0.},
    }


def _track(name, track_id, clips):
    return {"color": "#FF5500", "takeLanes": [], "clips": clips, "solo": False, "mute": False,
            "instrument": {"type": "song"}, "type": "audio", "eq": _eq(), "clipCreationIntents": [],
            "amplitude": 1.0, "takeLanesExpanded": False, "balance": 0.0, "signalChain": [],
            "name": name, "id": track_id, "routingMode": "linear", "arm": False, "height": 88.0}


def assemble_render(
    client: SunoClient,
    project_id: str,
    rows: List[Dict],
    title: str,
    out_dir: pathlib.Path,
    render: bool = True,
    clip_reference: str = "clip-id",
) -> Dict:
    if not rows:
        raise ValueError("at least one uploaded segment is required")
    try:
        proj = client.api("GET", f"/api/studio/project/{project_id}")
    except Exception as exc:
        raise ProviderError("unable to load Studio project") from exc
    source_state = proj.get("state") if isinstance(proj, dict) else {}
    source_state = copy.deepcopy(source_state) if isinstance(source_state, dict) else {}
    timing = source_state.get("timing") if isinstance(source_state.get("timing"), dict) else {}
    bps = float(timing.get("bps") or timing.get("fallbackBPS") or 2.0)
    if not math.isfinite(bps) or bps <= 0:
        bps = 2.0

    palette = ["#02AF4A", "#3B82F6", "#F64044", "#A02DFF", "#F59E0B"]
    markers: dict[str, Any] = {}
    clips: list[dict[str, Any]] = []
    uploaded: list[dict[str, Any]] = []
    for i, source_row in enumerate(rows):
        row = dict(source_row)
        start_sec = float(row.get("timelineStartSec", row.get("srcStartSec", 0.0)))
        end_sec = float(row.get("timelineEndSec", row.get("srcEndSec", start_sec)))
        duration_sec = float(row.get("duration", max(0.0, end_sec - start_sec)))
        # bps is beats per second.  Segment manifest values are seconds on the
        # restored Studio timeline, therefore seconds -> beats is multiplication.
        start_beats, end_beats = start_sec * bps, end_sec * bps
        duration_beats = max(0.0, duration_sec * bps)
        fade_in_beats = max(0.0, float(row.get("fadeInSec", 0.0)) * bps)
        fade_out_beats = max(0.0, float(row.get("fadeOutSec", 0.0)) * bps)
        # A stable marker key allows an interrupted save to be retried without
        # producing duplicate inline marker arrays.
        marker_value = {"0": 0}
        marker_hash = "warp_" + _fingerprint(marker_value)[:24]
        markers.setdefault(marker_hash, marker_value)
        ref = (row.get("upload_id") or row.get("uploadId")) if clip_reference == "upload-id" else (
            row.get("clip_id") or row.get("clipId"))
        if not ref:
            raise ProviderError(f"{row.get('fileName', 'segment')} has no uploaded Clip id")
        clip = {
            "type": "audio", "streaming": False,
            "name": str(row.get("fileName") or f"part-{i + 1:02d}.wav"),
            "color": palette[i % len(palette)], "amplitude": 1,
            "transposition": int(row.get("transposition", 24)), "readStartBeats": 0,
            "fadeInBeats": fade_in_beats, "fadeOutBeats": fade_out_beats,
            "fadeInCurve": 1, "fadeOutCurve": 1, "startBeats": start_beats, "endBeats": end_beats,
            "loop": {"startBeats": 0, "endBeats": duration_beats, "enabled": False},
            "warp": {"enabled": False, "awaitingAnalysis": True, "markersHash": marker_hash},
            "id": str(uuid.uuid4()), "clipId": ref if clip_reference == "clip-id" else None,
            "uploadId": ref if clip_reference == "upload-id" else None,
            "mute": False, "reversed": False, "awaitingContentAlignment": False,
        }
        clips.append(clip)
        row.update(start_beats=start_beats, end_beats=end_beats,
                   fade_in_beats=fade_in_beats, fade_out_beats=fade_out_beats,
                   duration_beats=duration_beats, marker_hash=marker_hash)
        uploaded.append(row)

    # Keep non-audio tracks and project metadata intact.  Replace only the
    # source audio track's clips; an empty project receives the same minimal
    # structure that Studio itself creates for a first audio track.
    tracks = source_state.get("tracks") if isinstance(source_state.get("tracks"), list) else []
    audio_index = next((i for i, track in enumerate(tracks)
                        if isinstance(track, dict) and str(track.get("type", "")).lower() == "audio"), None)
    if audio_index is None:
        tracks = [_track("Vocal Track", str(uuid.uuid4()), clips)] + [
            track for track in tracks if isinstance(track, dict)
        ]
    else:
        template = copy.deepcopy(tracks[audio_index])
        template["clips"] = clips
        template["takeLanes"] = []
        template["clipCreationIntents"] = []
        template["name"] = template.get("name") or "Vocal Track"
        tracks[audio_index] = template
    new_state = source_state or {
        "timing": {}, "markersRegistry": {}, "sections": {}, "tracks": [],
        "routing": {}, "amplitude": 1.0, "songFadeOutBeats": 0, "songFadeInBeats": 0,
        "masterRoutingMode": "linear", "metronome": {"enabled": False, "amplitude": 1.0},
        "editorPointerModes": {"midi": "select", "audio": "select"},
        "timeSignatureChanges": [{"beatsPerSubdivision": 1.0, "subdivisionsPerBar": 4.0,
                                  "startBeats": 0.0}],
        "masterSignalChain": [], "lyricsCorrectionsByClipId": {},
    }
    new_state["timing"] = {**timing, "type": timing.get("type") or "original", "bps": bps,
                            "lockBPS": True, "firstBeatSeconds": float(timing.get("firstBeatSeconds") or 0.0),
                            "bpsAutomation": timing.get("bpsAutomation") or []}
    new_state["tracks"] = tracks
    new_state["markersRegistry"] = {**(new_state.get("markersRegistry") or {}), **markers}
    total_end = max(float(row.get("timelineEndSec", row.get("srcEndSec", 0.0))) for row in rows)
    save_payload = {"project_id": project_id, "state": new_state, "title": title}
    save_resp = client.api("POST", "/api/studio/save-project", save_payload, timeout=120,
                           mutation_key="project:save:" + project_id)
    result: dict[str, Any] = {"projectId": project_id, "uploaded": uploaded,
                              "bps": bps, "durationSeconds": total_end, "save": _public_result(save_resp)}
    if not render:
        return result

    # This is the complete-song Studio export endpoint; it is unrelated to the
    # deprecated Advanced Split multitrack renderer.
    render_payload = {
        "title": title, "lyrics": "", "state": new_state, "project_id": project_id,
        "from_studio_project_id": project_id, "start_beats": 0,
        "end_beats": total_end * bps,
        "downbeats": proj.get("downbeats") if isinstance(proj, dict) else None,
        "web_client_pathname": "/studio/" + project_id,
        "export_mode": "rendered_context_window", "render_engine": "v1",
    }
    render_resp = client.api("POST", "/api/studio/render-state", render_payload, timeout=120,
                             mutation_key="project:render:" + project_id)
    result["render"] = _public_result(render_resp)

    def find_id(value: Any) -> str:
        if isinstance(value, dict):
            for key in ("clip_id", "clipId", "song_id", "songId"):
                candidate = str(value.get(key) or "")
                if re.fullmatch(r"[a-f0-9-]{36}", candidate, re.I):
                    return candidate
            typed = str(value.get("type") or value.get("kind") or "").lower()
            if typed in {"clip", "song", "audio", "generation", "output"}:
                candidate = str(value.get("id") or "")
                if re.fullmatch(r"[a-f0-9-]{36}", candidate, re.I):
                    return candidate
            preferred = [value[key] for key in ("clip", "song", "output", "data", "result", "clips") if key in value]
            for child in preferred:
                found = find_id(child)
                if found:
                    return found
        elif isinstance(value, list):
            for child in value:
                found = find_id(child)
                if found:
                    return found
        return ""

    render_id = ""
    if isinstance(render_resp, dict):
        render_id = str(render_resp.get("render_id") or render_resp.get("renderId") or "")
        if not render_id:
            candidate = find_id(render_resp)
            if candidate and candidate != project_id:
                result.update(clipId=candidate, songUrl=f"https://suno.com/song/{candidate}")
    if render_id:
        completed: dict[str, Any] | None = None
        max_polls = max(1, int(os.environ.get("SUNO_RENDER_MAX_POLLS", "600")))
        for _ in range(max_polls):
            status_payload = client.api("GET", f"/api/gen/{render_id}/")
            status = str(status_payload.get("status") or status_payload.get("state") or "").lower()
            if status in {"complete", "completed", "success", "succeeded", "finished", "done"}:
                completed = status_payload
                break
            if re.search(r"failed|rejected|blocked|error", status):
                raise ProviderError(f"render failed: {status}")
            time.sleep(2)
        if completed is None:
            raise TimeoutError("RENDER_TIMEOUT")
        result["render"] = _public_result(completed)
        clip_id = find_id(completed)
        if clip_id and clip_id != project_id:
            result.update(clipId=clip_id, songUrl=f"https://suno.com/song/{clip_id}")
    if not result.get("clipId"):
        raise ProviderError("render completed without a concrete Clip id")
    pathlib.Path(out_dir).mkdir(parents=True, exist_ok=True)
    atomic_write_json(pathlib.Path(out_dir) / "studio_result.json", result)
    log(f"[result] Song URL: {result['songUrl']}")
    return result


ROOT = BASE_DIR
IS_WINDOWS = os.name == "nt"
CDP_PORT = int(os.getenv("SUNO_CDP_PORT", "23922"))
_BROWSER_PROFILE_TEMP: tempfile.TemporaryDirectory[str] | None = None
BROWSER_PROFILE = pathlib.Path(os.environ["SUNO_CDP_USER_DATA_DIR"]).resolve() \
    if os.environ.get("SUNO_CDP_USER_DATA_DIR") else None
USE_CDP_BROWSER = True
_CDP_DISABLED = False
_CDP_PAGE_ID = None


def cdp_base() -> str:
    return f"http://127.0.0.1:{CDP_PORT}"


def cdp_alive() -> bool:
    try:
        r = requests.get(cdp_base() + "/json/version", timeout=1.5,
                         proxies={"http": None, "https": None})
        return r.status_code == 200
    except Exception:
        return False


def cdp_request(path: str, method: str = "GET") -> Any:
    url = cdp_base() + path
    fn = getattr(requests, method.lower())
    r = fn(url, timeout=5, proxies={"http": None, "https": None})
    r.raise_for_status()
    return r.json()


def cdp_pages() -> List[Dict[str, Any]]:
    try:
        pages = cdp_request("/json/list")
        return pages if isinstance(pages, list) else []
    except Exception:
        return []


def cdp_new_page(url: str) -> Dict[str, Any]:
    q = urllib.parse.quote(url, safe="")
    try:
        p = cdp_request("/json/new?" + q, "PUT")
    except Exception:
        try:
            p = cdp_request("/json/new?" + q, "GET")
        except Exception as e:
            raise RuntimeError("CDP 新建页面失败") from e
    if not isinstance(p, dict):
        raise RuntimeError("CDP 新建页面失败")
    return p


def cdp_pick_page(url: str = "https://suno.com/") -> Dict[str, Any]:
    global _CDP_PAGE_ID
    pages = cdp_pages()
    for p in pages:
        if p.get("type") == "page" and "suno.com" in str(p.get("url", "")):
            _CDP_PAGE_ID = p.get("id")
            return p
    for p in pages:
        if p.get("type") == "page" and p.get("webSocketDebuggerUrl"):
            _CDP_PAGE_ID = p.get("id")
            return p
    p = cdp_new_page(url)
    _CDP_PAGE_ID = p.get("id")
    return p


def cdp_call(ws_url: str, method: str, params: Optional[Dict] = None, timeout_sec: int = 60) -> Any:
    import websocket
    ws = websocket.create_connection(ws_url, timeout=timeout_sec, origin="http://localhost")
    try:
        msg_id = 1
        ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        deadline = time.time() + timeout_sec
        while time.time() < deadline:
            msg = json.loads(ws.recv())
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError("CDP error: " + json.dumps(msg["error"], ensure_ascii=False))
                return msg.get("result")
        raise RuntimeError("CDP timeout")
    finally:
        ws.close()


def cdp_navigate(url: str) -> None:
    p = cdp_pick_page(url)
    ws = p["webSocketDebuggerUrl"]
    cdp_call(ws, "Page.navigate", {"url": url})


def cdp_eval(js: str) -> str:
    last = None
    for attempt in range(2):
        try:
            p = cdp_pick_page()
            res = cdp_call(p["webSocketDebuggerUrl"], "Runtime.evaluate",
                           {"expression": js, "awaitPromise": True, "returnByValue": True,
                            "userGesture": True}, 60)
            if res.get("exceptionDetails"):
                raise RuntimeError("CDP JS exception")
            return res.get("result", {}).get("value", "")
        except Exception as e:
            last = e
            time.sleep(.5)
    raise RuntimeError("CDP eval failed") from last


def browser_candidates() -> List[str]:
    pf, pfx86, local = os.getenv("ProgramFiles", r"C:\Program Files"), os.getenv(
        "ProgramFiles(x86)", r"C:\Program Files (x86)"), os.getenv("LocalAppData", "")
    return [
        str(pathlib.Path(pf) / "Microsoft/Edge/Application/msedge.exe"),
        str(pathlib.Path(pfx86) / "Microsoft/Edge/Application/msedge.exe"),
        str(pathlib.Path(local) / "Microsoft/Edge/Application/msedge.exe"), "msedge",
        str(pathlib.Path(pf) / "Google/Chrome/Application/chrome.exe"),
        str(pathlib.Path(pfx86) / "Google/Chrome/Application/chrome.exe"),
        str(pathlib.Path(local) / "Google/Chrome/Application/chrome.exe"), "chrome",
    ]


def find_browser_binaries() -> List[pathlib.Path]:
    out, seen = [], set()
    for c in browser_candidates():
        found = shutil.which(c) if pathlib.Path(c).name == c else (c if pathlib.Path(c).is_file() else None)
        if found:
            p = pathlib.Path(found)
            key = str(p).lower()
            if key not in seen:
                seen.add(key)
                out.append(p)
    return out


def launch_cdp_browser(url: str = "https://suno.com/") -> bool:
    if cdp_alive():
        return True
    browsers = find_browser_binaries()
    if not browsers:
        log("[auth] 未找到 Chrome/Edge")
        return False
    global _BROWSER_PROFILE_TEMP
    profile = BROWSER_PROFILE
    if profile is None:
        _BROWSER_PROFILE_TEMP = _BROWSER_PROFILE_TEMP or tempfile.TemporaryDirectory(prefix="suno-cdp-")
        profile = pathlib.Path(_BROWSER_PROFILE_TEMP.name)
    profile.mkdir(parents=True, exist_ok=True)
    for exe in browsers:
        args = [str(exe), f"--remote-debugging-port={CDP_PORT}", "--remote-allow-origins=*",
                f"--user-data-dir={profile}", "--no-first-run", "--new-window", url]
        try:
            subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0)
            deadline = time.time() + 15
            while time.time() < deadline:
                if cdp_alive():
                    return True
                time.sleep(.25)
        except Exception:
            pass
    return False


def browser_eval_js(js: str) -> str:
    if not cdp_alive() and not launch_cdp_browser():
        raise RuntimeError("CDP browser unavailable")
    return cdp_eval(js)


_CDP_EXPORT_JS = r"""
    (async () => {
        let token = '';
        try {
            if (window.Clerk && window.Clerk.session) {
                token = await window.Clerk.session.getToken();
            }
        } catch(e) {}
        if (!token) {
            const match = document.cookie.match(/__session=([^;]+)/);
            if (match) token = match[1];
        }
        return JSON.stringify({
            token: token,
            tokenSource: token ? (window.Clerk ? 'clerk' : 'cookie') : '',
            href: location.href,
            ts: Date.now()
        });
    })();
"""


def export_chrome_suno_token(
    token_file: pathlib.Path,
    login_timeout: int = 600,
    require_project_keys: bool = False,
    login_url: str = "https://suno.com/",
) -> Dict[str, Any]:
    token_file = pathlib.Path(token_file)
    deadline, last_prompt = time.time() + login_timeout, 0.0
    if not launch_cdp_browser(login_url):
        raise RuntimeError("无法启动浏览器")
    cdp_navigate(login_url)
    while time.time() < deadline:
        try:
            raw = browser_eval_js(_CDP_EXPORT_JS)
            data = json.loads(raw) if isinstance(raw, str) else raw
            if data and data.get("token"):
                token_file.parent.mkdir(parents=True, exist_ok=True)
                token_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                log("[auth] 已获取 token")
                return data
        except Exception:
            pass
        if time.time() - last_prompt > 15:
            log("[auth] 请在浏览器中登录 Suno...")
            last_prompt = time.time()
        time.sleep(1)
    raise RuntimeError("登录超时")


def main():
    ap = argparse.ArgumentParser(description="Suno Studio Fast Upload")
    ap.add_argument("source", help="音频文件路径")
    ap.add_argument("--title")
    ap.add_argument("--work-dir", default="suno_output")
    ap.add_argument("--target-sec", type=float, default=5.0)
    ap.add_argument("--max-sec", type=float, default=5.5)
    ap.add_argument("--search-sec", type=float, default=1.0)
    ap.add_argument("--overlap-sec", type=float, default=0.08)
    ap.add_argument("--concurrency", type=int, default=2)
    ap.add_argument("--no-render", action="store_true")
    ap.add_argument("--clip-reference", choices=["clip-id", "upload-id"], default="clip-id")
    ap.add_argument("--token", default=None, help="Suno Bearer token (prefer SUNO_TOKEN or --token-file)")
    ap.add_argument("--token-file", default=None, help="JSON file containing {\"token\": \"...\"}")
    args = ap.parse_args()
    src, out_dir = pathlib.Path(args.source), pathlib.Path(args.work_dir)
    if not src.exists():
        log(f"[ERROR] 文件不存在: {src}")
        raise SystemExit(1)
    title = args.title or f"{src.stem} - 混音"
    try:
        log(f"[main] 处理: {src}")
        token_data: dict[str, Any] = {}
        token_file = pathlib.Path(args.token_file or DEFAULT_TOKEN_FILE)
        if args.token:
            token_data = {"token": args.token}
        elif os.environ.get("SUNO_TOKEN"):
            token_data = {"token": os.environ["SUNO_TOKEN"]}
        elif token_file.exists():
            token_data = json.loads(token_file.read_text(encoding="utf-8"))
        if not str(token_data.get("token") or "").strip():
            raise RuntimeError("SUNO_TOKEN_REQUIRED: pass --token, SUNO_TOKEN, or --token-file")

        def refresh_token():
            if args.token:
                return {"token": args.token}
            if os.environ.get("SUNO_TOKEN"):
                return {"token": os.environ["SUNO_TOKEN"]}
            return json.loads(token_file.read_text(encoding="utf-8"))

        client = SunoClient(
            token_data["token"],
            token_data.get("device_id", ""),
            token_refresh=refresh_token,
            journal_path=out_dir / "mutation_journal.json",
            cancelled=lambda: (out_dir / "cancelled").exists(),
        )
        segs, _ = split_audio(src, out_dir, args.target_sec, args.max_sec, args.search_sec, args.overlap_sec)
        project_id = create_studio_project(client, title)
        initialize_clip = args.clip_reference == "clip-id"
        rows = upload_all(client, segs, args.concurrency, initialize_clip=initialize_clip,
                          progress_path=out_dir / "upload_progress.json")
        assemble_render(client, project_id, rows, title, out_dir, render=not args.no_render,
                        clip_reference=args.clip_reference)
        log("\n[SUCCESS] 完成!")
        log(f"   项目: https://suno.com/studio/{project_id}")
        log(f"   工作目录: {out_dir}")
    except Exception as e:
        log(f"[ERROR] 处理失败: {e}")
        raise


if __name__ == "__main__":
    main()
