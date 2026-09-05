import importlib.util
import argparse
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


WORKER_PATH = Path(__file__).parents[1] / "python" / "fast_upload_worker.py"
SPEC = importlib.util.spec_from_file_location("fast_upload_worker", WORKER_PATH)
assert SPEC and SPEC.loader
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)


def test_token_reader_observes_atomic_parent_refresh(tmp_path: Path) -> None:
    token_file = tmp_path / "token.json"
    token_file.write_text(json.dumps({"token": "first"}), encoding="utf-8")
    assert WORKER.read_task_token(token_file)["token"] == "first"
    replacement = tmp_path / "token.next"
    replacement.write_text(json.dumps({"token": "second"}), encoding="utf-8")
    os.replace(replacement, token_file)
    assert WORKER.read_task_token(token_file)["token"] == "second"


def test_uploaded_rows_are_written_incrementally_and_deduplicated(tmp_path: Path) -> None:
    first = {
        "clipId": "11111111-1111-4111-8111-111111111111",
        "uploadId": "upload-1",
        "fileName": "part01.wav",
    }
    second = {
        "clip_id": first["clipId"],
        "status": "complete",
    }
    rows = WORKER.record_uploaded_row(tmp_path, first)
    assert len(rows) == 1
    rows = WORKER.record_uploaded_row(tmp_path, second)
    assert len(rows) == 1
    assert rows[0]["status"] == "complete"
    assert WORKER.read_uploaded_rows(tmp_path) == rows


def test_failure_evidence_cleanup_removes_secrets_but_keeps_progress(tmp_path: Path) -> None:
    task_dir = tmp_path / "task"
    work_dir = task_dir / "work"
    work_dir.mkdir(parents=True)
    source = task_dir / "source.mp3"
    token = task_dir / "token.json"
    source.write_bytes(b"audio")
    (task_dir / "source_part06_868.18s-1041.81s_retry1a.wav").write_bytes(b"segment")
    nested = work_dir / "source_repaired.wav"
    nested.write_bytes(b"repaired")
    token.write_text('{"token":"secret"}', encoding="utf-8")
    WORKER.record_uploaded_row(work_dir, {"clipId": "clip-1", "fileName": "part.wav"})
    (task_dir / "worker.log").write_text("progress", encoding="utf-8")

    result = WORKER.preserve_failure_evidence(task_dir, source, token)

    assert result["skipped"] is True
    assert not source.exists()
    assert not (task_dir / "source_part06_868.18s-1041.81s_retry1a.wav").exists()
    assert not nested.exists()
    assert not token.exists()
    assert (work_dir / "uploaded_rows.json").exists()
    assert (task_dir / "worker.log").exists()


def test_core_wrapper_preserves_initialize_flag_and_extends_retry_depth(
    tmp_path: Path,
) -> None:
    ffmpeg = tmp_path / "ffmpeg.exe"
    token = tmp_path / "token.json"
    ffmpeg.write_bytes(b"binary")
    token.write_text('{"token":"test"}', encoding="utf-8")
    observed = {}

    def upload_one(*_args, **_kwargs):
        return {"clipId": "clip-1", "fileName": "part.wav"}

    def upload_all(
        client,
        segs,
        concurrency=2,
        retry_min_sec=0.2,
        retry_overlap_sec=0.08,
        retry_max_depth=3,
        initialize_clip=True,
        progress_path=None,
    ):
        observed.update(
            retry_max_depth=retry_max_depth,
            initialize_clip=initialize_clip,
            progress_path=progress_path,
        )
        return []

    core = SimpleNamespace(upload_one=upload_one, upload_all=upload_all)
    args = argparse.Namespace(
        core_dir=str(tmp_path),
        ffmpeg_exe=str(ffmpeg),
        token_file=str(token),
        work_dir=str(tmp_path / "work"),
        retry_max_depth=5,
    )
    with (
        mock.patch.object(WORKER.importlib, "import_module", return_value=core),
        mock.patch.object(
            WORKER.os, "add_dll_directory", return_value=object(), create=True
        ),
    ):
        configured = WORKER.configure_core(args)

    configured.upload_all("client", [], 1, 0.2, 0.08, 3, False, None)

    assert observed["retry_max_depth"] == 5
    assert observed["initialize_clip"] is False
    assert observed["progress_path"] == tmp_path / "work" / "uploaded_rows.json"


def test_system_exit_cleanup_event_keeps_original_reason(tmp_path: Path) -> None:
    source = tmp_path / "source.mp3"
    token = tmp_path / "token.json"
    source.write_bytes(b"audio")
    token.write_text('{"token":"test"}', encoding="utf-8")
    core = SimpleNamespace(main=mock.Mock(side_effect=SystemExit(1)))
    events = []

    def capture(event, **payload):
        events.append((event, payload))

    with (
        mock.patch.object(WORKER, "configure_core", return_value=core),
        mock.patch.object(WORKER, "normalize_source", return_value=str(source)),
        mock.patch.object(WORKER, "emit", side_effect=capture),
    ):
        code = WORKER.main([
            str(source),
            "--work-dir", str(tmp_path / "work"),
            "--core-dir", str(tmp_path),
            "--ffmpeg-exe", str(tmp_path / "ffmpeg.exe"),
            "--token-file", str(token),
            "--task-prefix", "__sfp_11111111-1111-4111-8111-111111111111_",
            "--title", "test",
        ])

    assert code == 1
    cleanup = next(payload for event, payload in events if event == "cleanup_uploaded_parts")
    assert cleanup["reason"] == "failure_preserve_evidence"
    assert cleanup["exit_reason"] == "system_exit"


def test_cleanup_is_limited_to_uploaded_rows_and_exact_task_prefix() -> None:
    prefix = "__sfp_11111111-1111-4111-8111-111111111111_"
    project = {
        "title": "project",
        "state": {
            "tracks": [{
                "clips": [
                    {"type": "audio", "clipId": "task-project", "name": prefix + "part"},
                    {"type": "audio", "clipId": "other-task", "name": "other__part1"},
                    {"type": "audio", "clipId": "normal", "name": "real song"},
                ]
            }]
        },
    }
    calls = []

    def request(method, path, token_file, payload=None):
        calls.append((method, path, payload))
        if method == "GET":
            return {"ok": True, "response": project}
        return {"ok": True}

    with mock.patch.object(WORKER, "suno_api_request", side_effect=request):
        result = WORKER.cleanup_task_clips(
            [{"clipId": "task-row"}],
            "token.json",
            "project-id",
            prefix,
        )

    assert set(result["ids"]) == {"task-row", "task-project"}
    trash = next(call for call in calls if call[1] == "/api/gen/trash")
    assert set(trash[2]["clip_ids"]) == {"task-row", "task-project"}
    saved = next(call for call in calls if call[1] == "/api/studio/save-project")
    remaining = saved[2]["state"]["tracks"][0]["clips"]
    assert {clip["clipId"] for clip in remaining} == {"other-task", "normal"}


def test_invalid_prefix_stops_before_loading_proprietary_core(tmp_path: Path) -> None:
    with mock.patch.object(WORKER, "configure_core") as configure:
        code = WORKER.main([
            str(tmp_path / "audio.mp3"),
            "--work-dir", str(tmp_path / "work"),
            "--core-dir", str(tmp_path),
            "--ffmpeg-exe", str(tmp_path / "ffmpeg.exe"),
            "--token-file", str(tmp_path / "token.json"),
            "--task-prefix", "__part",
            "--title", "test",
        ])
    assert code == 2
    configure.assert_not_called()
