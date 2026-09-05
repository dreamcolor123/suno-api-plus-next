"""Task-scoped runner for the public Suno Studio Fast Upload core.

The worker supplies a short-lived API Plus Bearer token at runtime, emits
newline-delimited JSON progress, and only removes clips proven to belong to
the current task.  No native extension, browser profile, or embedded secret
is required.
"""

from __future__ import annotations

import argparse
import base64
import importlib
import inspect
import json
import os
import re
import subprocess
import sys
import time
import traceback
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


SONG_URL_RE = re.compile(r"https://suno\.com/song/([a-f0-9-]+)", re.IGNORECASE)
PROJECT_URL_RE = re.compile(r"https://suno\.com/studio/([a-f0-9-]+)", re.IGNORECASE)
UUID_RE = re.compile(
    r"\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b",
    re.IGNORECASE,
)
TASK_PREFIX_RE = re.compile(
    r"^__sfp_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}_$",
    re.IGNORECASE,
)
SUNO_API_BASE = "https://studio-api-prod.suno.com"
_UPLOADED_ROWS_LOCK = threading.Lock()
DEFAULT_RETRY_MAX_DEPTH = 5
MIN_RETRY_MAX_DEPTH = 3
MAX_RETRY_MAX_DEPTH = 5

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def emit(event: str, **payload: Any) -> None:
    payload.update({"event": event, "ts": time.time()})
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def read_json(path: Path) -> Any:
    # The parent uses replace(2), but antivirus/indexers can transiently race a
    # Windows rename.  A short bounded retry keeps token refresh deterministic.
    last_error: Exception | None = None
    for _ in range(5):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # pragma: no cover - exact Windows race varies
            last_error = exc
            time.sleep(0.05)
    raise RuntimeError(f"TASK_TOKEN_READ_FAILED: {last_error}")


def read_task_token(token_file: str | Path) -> dict[str, Any]:
    payload = read_json(Path(token_file))
    if not isinstance(payload, dict) or not str(payload.get("token") or "").strip():
        raise RuntimeError("TASK_TOKEN_NOT_FOUND")
    return payload


def browser_token() -> str:
    inner = json.dumps(
        {"timestamp": int(time.time() * 1000)}, separators=(",", ":")
    ).encode()
    return json.dumps(
        {"token": base64.b64encode(inner).decode()}, separators=(",", ":")
    )


def suno_api_request(
    method: str,
    path: str,
    token_file: str | Path,
    payload: Any = None,
) -> dict[str, Any]:
    try:
        token = str(read_task_token(token_file)["token"])
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    data = None
    if payload is not None:
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        SUNO_API_BASE + path,
        data=data,
        method=method,
        headers={
            "Authorization": "Bearer " + token,
            "Browser-Token": browser_token(),
            "Origin": "https://suno.com",
            "Referer": "https://suno.com/create",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 "
                "Safari/537.36"
            ),
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read().decode("utf-8", "replace")
            parsed = json.loads(body) if body else {}
            return {
                "ok": 200 <= response.status < 300,
                "status": response.status,
                "response": parsed,
            }
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        return {"ok": False, "status": exc.code, "error": body[:1000]}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def extract_song_url(message: Any) -> str:
    match = SONG_URL_RE.search(str(message or ""))
    return match.group(0) if match else ""


def extract_project_id(message: Any) -> str:
    text = str(message or "")
    match = PROJECT_URL_RE.search(text)
    if match:
        return match.group(1)
    if "[project]" in text.lower():
        uuid_match = UUID_RE.search(text)
        if uuid_match:
            return uuid_match.group(0)
    return ""


def read_uploaded_rows(work_dir: str | Path) -> list[dict[str, Any]]:
    path = Path(work_dir) / "uploaded_rows.json"
    if not path.exists():
        return []
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _row_identity(row: dict[str, Any]) -> tuple[str, ...]:
    """Return stable, non-secret identities used to de-duplicate progress rows."""

    values: list[str] = []
    for key in (
        "clipId", "clip_id", "clipID",
        "uploadId", "upload_id", "uploadID",
        "fileName", "file_name", "filename",
    ):
        value = str(row.get(key) or "").strip()
        if value and value not in values:
            values.append(value)
    return tuple(values)


def record_uploaded_row(work_dir: str | Path, row: Any) -> list[dict[str, Any]]:
    """Atomically append one successful segment to the task progress file.

    The public uploader can finish several worker futures concurrently.
    Keeping this write in the adapter (rather than relying only on the core's
    final return value) means a later failure still leaves enough evidence to
    reconcile or safely retry the operation.
    """

    if not isinstance(row, dict):
        return read_uploaded_rows(work_dir)
    # Make a JSON-safe copy.  A future core version may return Path/UUID values
    # which should never make progress persistence fail after an upload.
    try:
        safe_row = json.loads(json.dumps(row, ensure_ascii=False, default=str))
    except Exception:
        safe_row = {str(key): str(value) for key, value in row.items()}
    if not isinstance(safe_row, dict):
        return read_uploaded_rows(work_dir)
    path = Path(work_dir) / "uploaded_rows.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with _UPLOADED_ROWS_LOCK:
        rows: list[dict[str, Any]] = []
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(value, list):
                rows = [item for item in value if isinstance(item, dict)]
        except Exception:
            rows = []
        incoming_ids = set(_row_identity(safe_row))
        replaced = False
        for index, existing in enumerate(rows):
            existing_ids = set(_row_identity(existing))
            if incoming_ids and existing_ids.intersection(incoming_ids):
                # Keep any fields the core supplied on the earlier write while
                # allowing a later retry to add status/URL fields.
                merged = dict(existing)
                merged.update(safe_row)
                rows[index] = merged
                replaced = True
                break
        if not replaced:
            rows.append(safe_row)
        temporary = path.with_name(f"{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
        temporary.write_text(
            json.dumps(rows, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, path)
        return rows


def _segment_row_summary(row: dict[str, Any]) -> dict[str, Any]:
    """Build a deliberately small progress event with no token/cookie data."""

    summary: dict[str, Any] = {}
    for output_key, input_keys in {
        "clipId": ("clipId", "clip_id", "clipID"),
        "uploadId": ("uploadId", "upload_id", "uploadID"),
        "fileName": ("fileName", "file_name", "filename"),
    }.items():
        for key in input_keys:
            value = str(row.get(key) or "").strip()
            if value:
                summary[output_key] = value[:256]
                break
    return summary


def unique_task_clip_ids(uploaded_rows: list[dict[str, Any]]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for row in uploaded_rows:
        clip_id = str(
            row.get("clipId") or row.get("clip_id") or row.get("clipID") or ""
        ).strip()
        if clip_id and clip_id not in seen:
            seen.add(clip_id)
            result.append(clip_id)
    return result


def project_task_clip_ids(project: Any, task_prefix: str) -> list[str]:
    state = project.get("state") if isinstance(project, dict) else {}
    result: list[str] = []
    seen: set[str] = set()
    for track in (state or {}).get("tracks") or []:
        for clip in (track or {}).get("clips") or []:
            if not isinstance(clip, dict):
                continue
            clip_id = str(clip.get("clipId") or clip.get("clip_id") or "").strip()
            name = str(
                clip.get("name")
                or clip.get("title")
                or clip.get("displayName")
                or ""
            )
            if clip_id and clip_id not in seen and task_prefix in name:
                seen.add(clip_id)
                result.append(clip_id)
    return result


def remove_task_clips_from_project(project: Any, task_prefix: str) -> dict[str, Any]:
    state = project.get("state") if isinstance(project, dict) else {}
    if not isinstance(state, dict):
        return {"state": state, "removed": [], "removedCount": 0}
    cleaned = json.loads(json.dumps(state))
    removed: list[str] = []
    for track in cleaned.get("tracks") or []:
        if not isinstance(track, dict):
            continue
        kept = []
        for clip in track.get("clips") or []:
            if not isinstance(clip, dict):
                kept.append(clip)
                continue
            name = str(
                clip.get("name")
                or clip.get("title")
                or clip.get("displayName")
                or ""
            )
            if task_prefix in name:
                clip_id = str(clip.get("clipId") or clip.get("clip_id") or "").strip()
                if clip_id:
                    removed.append(clip_id)
                continue
            kept.append(clip)
        track["clips"] = kept
    return {"state": cleaned, "removed": removed, "removedCount": len(removed)}


def cleanup_task_clips(
    uploaded_rows: list[dict[str, Any]],
    token_file: str | Path,
    project_id: str,
    task_prefix: str,
) -> dict[str, Any]:
    """Remove only ids from this task's rows or exact per-task prefix.

    There is intentionally no workspace/feed scan here.  A missing task proof
    results in no deletion, which is safer than guessing across an account.
    """
    project: dict[str, Any] | None = None
    clip_ids = unique_task_clip_ids(uploaded_rows)
    source = "uploaded_rows"
    if project_id:
        project_result = suno_api_request(
            "GET", "/api/studio/project/" + project_id, token_file
        )
        if project_result.get("ok"):
            candidate = project_result.get("response") or {}
            if isinstance(candidate, dict):
                project = candidate
            project_ids = project_task_clip_ids(project, task_prefix)
            if project_ids:
                clip_ids = list(dict.fromkeys([*clip_ids, *project_ids]))
                source = "task_prefixed_project_state"

    trash_result: dict[str, Any] = {"ok": True, "skipped": True}
    if clip_ids:
        trash_result = suno_api_request(
            "POST", "/api/gen/trash", token_file, {"trash": True, "clip_ids": clip_ids}
        )

    state_result: dict[str, Any] = {"ok": True, "skipped": True}
    if project_id and project is not None:
        cleaned = remove_task_clips_from_project(project, task_prefix)
        if cleaned["removedCount"]:
            state_result = suno_api_request(
                "POST",
                "/api/studio/save-project",
                token_file,
                {
                    "project_id": project_id,
                    "state": cleaned["state"],
                    "title": project.get("title") or project.get("name") or "",
                },
            )
            state_result.update(
                {
                    "removedCount": cleaned["removedCount"],
                    "removedIds": cleaned["removed"],
                }
            )

    return {
        "ok": bool(trash_result.get("ok", False))
        and bool(state_result.get("ok", False)),
        "count": len(clip_ids),
        "ids": clip_ids,
        "source": source,
        "trash": trash_result,
        "projectStateSave": state_result,
    }


def preserve_failure_evidence(
    task_dir: str | Path,
    source: str | Path,
    token_file: str | Path,
) -> dict[str, Any]:
    """Remove secrets while retaining upload rows/logs for reconciliation.

    A failed Studio project is a submission boundary.  Removing the entire
    task directory at that point destroys the only local proof of which
    segments succeeded and makes every later reconciliation indistinguishable
    from a fresh upload.  Keep ``work/uploaded_rows.json`` and ``worker.log``;
    delete only the source/token material that may contain user data or
    credentials.
    """

    removed: list[str] = []
    task_root = Path(task_dir).resolve()

    # The Studio core may materialize the original input under several names
    # (``source.mp3``, ``source.wav`` or a repaired ``source_*`` fragment).
    # Removing only the path passed to ``normalize_source`` left those copies
    # behind and, more importantly, made a failed job look as if its evidence
    # had been cleaned when it had not.  Only remove files directly owned by
    # this task directory; never follow a caller supplied path outside it.
    candidates: list[Path] = [Path(token_file), Path(source)]
    try:
        # Include files materialized in ``work``/nested temporary folders as
        # well.  Segment names produced by the Studio core commonly look like
        # ``source_part06_...wav`` and are otherwise easy to miss.
        candidates.extend(task_root.rglob("source.*"))
        candidates.extend(task_root.rglob("source_*"))
    except OSError:
        pass
    candidates.append(task_root / "work" / "normalized_input.wav")
    seen: set[str] = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
            if resolved != task_root and task_root not in resolved.parents:
                continue
            identity = str(resolved).casefold()
            if identity in seen:
                continue
            seen.add(identity)
        except OSError:
            continue
        try:
            candidate.unlink(missing_ok=True)
            removed.append(candidate.name)
        except OSError:
            pass
    return {
        "ok": True,
        "skipped": True,
        "reason": "failure_preserve_evidence",
        "removed_sensitive_files": removed,
    }


def normalize_source(source: str, work_dir: str, ffmpeg_exe: str) -> str:
    if not ffmpeg_exe or not Path(ffmpeg_exe).is_file():
        raise RuntimeError("FFMPEG_RUNTIME_NOT_FOUND")
    if not Path(source).is_file():
        raise RuntimeError("SOURCE_AUDIO_NOT_FOUND")
    Path(work_dir).mkdir(parents=True, exist_ok=True)
    null_target = "NUL" if os.name == "nt" else "/dev/null"
    checked = subprocess.run(
        [
            ffmpeg_exe,
            "-hide_banner",
            "-v",
            "error",
            "-xerror",
            "-i",
            source,
            "-f",
            "null",
            null_target,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if checked.returncode == 0:
        emit("audio_preflight_ok")
        return source
    normalized = str(Path(work_dir) / "normalized_input.wav")
    repaired = subprocess.run(
        [
            ffmpeg_exe,
            "-y",
            "-hide_banner",
            "-v",
            "warning",
            "-fflags",
            "+discardcorrupt",
            "-err_detect",
            "ignore_err",
            "-i",
            source,
            "-vn",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-acodec",
            "pcm_s16le",
            normalized,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if (
        repaired.returncode != 0
        or not Path(normalized).is_file()
        or Path(normalized).stat().st_size <= 44
    ):
        detail = (repaired.stderr or checked.stderr or "").strip()[-1600:]
        raise RuntimeError("FFMPEG_REPAIR_FAILED: " + detail)
    emit("audio_preflight_repaired")
    return normalized


def configure_core(args: argparse.Namespace) -> Any:
    core_dir = Path(args.core_dir).resolve()
    if not core_dir.exists():
        raise RuntimeError("FAST_UPLOAD_CORE_NOT_FOUND")
    module_path = core_dir if core_dir.is_file() else core_dir / "suno_studio_tool.py"
    import_dir = module_path.parent
    sys.path.insert(0, str(import_dir))
    ffmpeg_dir = str(Path(args.ffmpeg_exe).resolve().parent)
    os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
    os.environ["FFMPEG_BINARY"] = str(Path(args.ffmpeg_exe).resolve())
    os.environ["IMAGEIO_FFMPEG_EXE"] = str(Path(args.ffmpeg_exe).resolve())
    # Ensure a previous in-process import from a different task cannot leak
    # state into this worker when tests invoke configure_core repeatedly.
    sys.modules.pop("suno_studio_tool", None)
    core = importlib.import_module("suno_studio_tool")

    token_path = Path(args.token_file).resolve()

    def export_task_token(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return read_task_token(token_path)

    # The extension performs this lookup both at startup and from its token
    # refresh callback, so every call observes the parent's latest JWT.
    core.export_chrome_suno_token = export_task_token
    if hasattr(core, "DEFAULT_TOKEN_FILE"):
        core.DEFAULT_TOKEN_FILE = token_path

    # Wrap the public module functions so progress remains durable even when
    # ``upload_all`` raises on a later segment.  The wrapper is installed in
    # this worker process only; it never rewrites the source module.
    original_upload_one = getattr(core, "upload_one", None)
    original_upload_all = getattr(core, "upload_all", None)
    if callable(original_upload_one) and callable(original_upload_all):
        progress_path = Path(args.work_dir) / "uploaded_rows.json"
        try:
            upload_all_parameters = tuple(
                inspect.signature(original_upload_all).parameters
            )
        except (TypeError, ValueError):
            upload_all_parameters = ()

        def tracked_upload_one(*call_args: Any, **call_kwargs: Any) -> Any:
            row = original_upload_one(*call_args, **call_kwargs)
            if isinstance(row, dict):
                rows = record_uploaded_row(args.work_dir, row)
                emit("segment_uploaded", **_segment_row_summary(row), count=len(rows))
            return row

        def tracked_upload_all(*call_args: Any, **call_kwargs: Any) -> Any:
            positional = list(call_args)

            def set_named_argument(name: str, value: Any) -> None:
                if name not in upload_all_parameters:
                    return
                index = upload_all_parameters.index(name)
                if len(positional) > index:
                    positional[index] = value
                    call_kwargs.pop(name, None)
                else:
                    call_kwargs[name] = value

            # The public core exposes initialize_clip immediately
            # before progress_path.  Looking up the parameter name avoids the
            # previous positional off-by-one that could overwrite that flag.
            set_named_argument("progress_path", progress_path)

            # Keep retries bounded, but allow two additional bisections for a
            # short region rejected by Studio processing.  This extends the
            # core's own recursive repair without replaying the whole upload.
            retry_depth = int(
                getattr(args, "retry_max_depth", DEFAULT_RETRY_MAX_DEPTH)
            )
            if "retry_max_depth" in upload_all_parameters:
                retry_index = upload_all_parameters.index("retry_max_depth")
                if len(positional) > retry_index:
                    try:
                        retry_depth = max(retry_depth, int(positional[retry_index]))
                    except (TypeError, ValueError):
                        pass
                elif "retry_max_depth" in call_kwargs:
                    try:
                        retry_depth = max(
                            retry_depth, int(call_kwargs["retry_max_depth"])
                        )
                    except (TypeError, ValueError):
                        pass
                set_named_argument(
                    "retry_max_depth", min(MAX_RETRY_MAX_DEPTH, retry_depth)
                )
            return original_upload_all(*positional, **call_kwargs)

        try:
            core.upload_one = tracked_upload_one
            core.upload_all = tracked_upload_all
        except (AttributeError, TypeError):
            # A future extension may expose read-only Cython attributes.  The
            # explicit progress_path call is still attempted below by the
            # unwrapped function, so startup remains compatible.
            pass
    return core


def core_argv(args: argparse.Namespace, source: str) -> list[str]:
    values = [
        "suno_studio_tool.py",
        source,
        "--work-dir",
        args.work_dir,
        "--target-sec",
        str(args.target_sec),
        "--concurrency",
        str(args.concurrency),
        "--clip-reference",
        "clip-id",
        "--title",
        args.title,
    ]
    return values


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Task-scoped Suno Studio fast upload worker")
    parser.add_argument("source")
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--core-dir", required=True)
    parser.add_argument("--ffmpeg-exe", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--task-prefix", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--target-sec", type=float, default=4.5)
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument(
        "--retry-max-depth", type=int, default=DEFAULT_RETRY_MAX_DEPTH
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if not TASK_PREFIX_RE.fullmatch(args.task_prefix):
        emit("worker_error", error_type="InvalidTaskPrefix", error="INVALID_TASK_PREFIX")
        return 2
    if not 1 <= int(args.concurrency) <= 8:
        emit("worker_error", error_type="InvalidConcurrency", error="INVALID_CONCURRENCY")
        return 2
    if not MIN_RETRY_MAX_DEPTH <= int(args.retry_max_depth) <= MAX_RETRY_MAX_DEPTH:
        emit(
            "worker_error",
            error_type="InvalidRetryDepth",
            error="INVALID_RETRY_MAX_DEPTH",
        )
        return 2

    emit(
        "worker_started",
        taskPrefix=args.task_prefix,
        targetSec=args.target_sec,
        concurrency=args.concurrency,
    )
    final_song_url = ""
    final_project_id = ""
    uploaded_rows: list[dict[str, Any]] = []
    source_path = args.source
    try:
        core = configure_core(args)

        if hasattr(core, "set_log_callback"):

            def on_core_log(message: Any) -> None:
                nonlocal final_song_url, final_project_id
                text = str(message)
                emit("core_log", message=text)
                song_url = extract_song_url(text)
                if song_url:
                    final_song_url = song_url
                    emit("song_url", songUrl=song_url)
                project_id = extract_project_id(text)
                if project_id:
                    final_project_id = project_id
                    emit("project_id", projectId=project_id)

            core.set_log_callback(on_core_log)

        source = normalize_source(args.source, args.work_dir, args.ffmpeg_exe)
        source_path = source
        sys.argv = core_argv(args, source)
        core.main()
        uploaded_rows = read_uploaded_rows(args.work_dir)
        cleanup = cleanup_task_clips(
            uploaded_rows,
            args.token_file,
            final_project_id,
            args.task_prefix,
        )
        emit("cleanup_uploaded_parts", **cleanup)
        if not final_song_url:
            emit("worker_error", error_type="MissingSongUrl", error="COMPLETE_SONG_URL_NOT_FOUND")
            emit(
                "worker_finished",
                ok=False,
                exit_code=2,
                projectId=final_project_id,
                cleanup=cleanup,
            )
            return 2
        emit(
            "worker_finished",
            ok=True,
            songUrl=final_song_url,
            projectId=final_project_id,
            uploadedRows=uploaded_rows,
            cleanup=cleanup,
        )
        return 0
    except SystemExit as exc:
        code = int(exc.code or 0)
        uploaded_rows = read_uploaded_rows(args.work_dir)
        cleanup = preserve_failure_evidence(
            Path(args.work_dir).parent,
            source_path,
            args.token_file,
        )
        emit("cleanup_uploaded_parts", **cleanup, exit_reason="system_exit")
        emit("worker_error", error_type="SystemExit", error=f"CORE_EXITED_WITH_CODE_{code}")
        emit(
            "worker_finished",
            ok=False,
            exit_code=code or 2,
            projectId=final_project_id,
            cleanup=cleanup,
        )
        return code or 2
    except Exception as exc:
        uploaded_rows = read_uploaded_rows(args.work_dir)
        cleanup = preserve_failure_evidence(
            Path(args.work_dir).parent,
            source_path,
            args.token_file,
        )
        emit("cleanup_uploaded_parts", **cleanup, exit_reason="exception")
        emit(
            "worker_error",
            error_type=type(exc).__name__,
            error=str(exc),
            traceback=traceback.format_exc(),
        )
        emit(
            "worker_finished",
            ok=False,
            exit_code=1,
            projectId=final_project_id,
            cleanup=cleanup,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
