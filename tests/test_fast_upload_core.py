"""Behavioral tests for the source-only Studio Fast Upload core.

These tests deliberately use fake HTTP responses.  They exercise the mutation
boundaries and checkpoint behavior without requiring Suno credentials, a
browser profile, or a network connection.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest


CORE_PATH = Path(__file__).parents[1] / "python" / "suno_studio_tool.py"
SPEC = importlib.util.spec_from_file_location("public_suno_studio_tool", CORE_PATH)
assert SPEC and SPEC.loader
CORE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CORE
SPEC.loader.exec_module(CORE)


class FakeResponse:
    def __init__(self, status: int, payload: Any = None):
        self.status_code = status
        self._payload = payload if payload is not None else {}
        self.ok = 200 <= status < 300
        self.content = json.dumps(self._payload).encode()

    def json(self):
        return self._payload


class FakeUploadClient:
    def __init__(self, responses: list[Any]):
        self.responses = list(responses)
        self.calls: list[tuple[str, str, Any]] = []
        self.cancelled = None

    def api(self, method: str, path: str, json_body=None, **_kwargs):
        self.calls.append((method, path, json_body))
        if not self.responses:
            raise AssertionError(f"unexpected API call: {method} {path}")
        value = self.responses.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value


def make_segment(tmp_path: Path, index: int = 1, name: str | None = None):
    filename = name or f"part{index:02d}.wav"
    path = tmp_path / filename
    path.write_bytes(b"RIFF-test-audio")
    return CORE.Segment(
        index=index,
        path=path,
        fileName=filename,
        srcStartSec=float(index - 1),
        srcEndSec=float(index),
        nominalStartSec=float(index - 1),
        nominalEndSec=float(index),
        timelineStartSec=float(index - 1),
        timelineEndSec=float(index),
        duration=1.0,
        fadeInSec=0.0,
        fadeOutSec=0.0,
    )


def test_atomic_write_json_keeps_last_valid_file_when_replace_fails(tmp_path, monkeypatch):
    target = tmp_path / "progress.json"
    target.write_text('{"completed": 1}\n', encoding="utf-8")
    original_replace = CORE.os.replace

    def fail_replace(source, destination):
        if Path(destination) == target:
            raise OSError("simulated interrupted rename")
        return original_replace(source, destination)

    monkeypatch.setattr(CORE.os, "replace", fail_replace)
    with pytest.raises(OSError):
        CORE.atomic_write_json(target, {"completed": 2})
    assert json.loads(target.read_text(encoding="utf-8")) == {"completed": 1}
    assert not list(tmp_path.glob(f".{target.name}.*.tmp"))


def test_upload_one_forwards_every_presigned_field_and_preserves_mutation_order(
    tmp_path, monkeypatch
):
    segment = make_segment(tmp_path)
    fields = {
        "key": "uploads/task/part01.wav",
        "policy": "encoded-policy",
        "x-amz-algorithm": "AWS4-HMAC-SHA256",
        "x-amz-credential": "credential",
        "x-amz-date": "20260905T000000Z",
        "x-amz-signature": "signature",
        "content-type": "audio/wav",
    }
    client = FakeUploadClient(
        [
            {
                "id": "upload-1",
                "url": "https://s3.example/upload",
                "fields": fields,
            },
            {"ok": True},
            {"status": "complete", "clip_id": "clip-1"},
            {"clip_id": "clip-1"},
        ]
    )
    observed: dict[str, Any] = {}

    def fake_post(url, **kwargs):
        observed.update(url=url, **kwargs)
        return FakeResponse(204)

    monkeypatch.setattr(CORE.requests, "post", fake_post)
    result = CORE.upload_one(client, segment, 0, 1, initialize_clip=True)

    assert observed["url"] == "https://s3.example/upload"
    assert observed["data"] == fields
    assert observed["files"]["file"][0] == segment.fileName
    assert observed["files"]["file"][2] == "audio/wav"
    assert [call[1] for call in client.calls] == [
        "/api/uploads/audio/",
        "/api/uploads/audio/upload-1/upload-finish/",
        "/api/uploads/audio/upload-1/",
        "/api/uploads/audio/upload-1/initialize-clip/",
    ]
    assert result["clip_id"] == "clip-1"


def test_sunoclient_does_not_replay_a_mutating_post_after_provider_failure(
    monkeypatch, tmp_path
):
    client = CORE.SunoClient("runtime-token", journal_path=tmp_path / "journal.json")
    calls = []

    def request(method, url, **_kwargs):
        calls.append((method, url))
        return FakeResponse(503, {"detail": "temporary provider error"})

    monkeypatch.setattr(client.session, "request", request)
    with pytest.raises(Exception) as exc_info:
        client.api("POST", "/api/studio/save-project", {"project_id": "p1"})
    assert len(calls) == 1
    assert getattr(exc_info.value, "submission_state", "not_submitted") in {
        "not_submitted",
        "submission_unknown",
    }


def test_sunoclient_get_has_bounded_retry(monkeypatch):
    client = CORE.SunoClient("runtime-token")
    calls = []
    responses = [FakeResponse(502), FakeResponse(200, {"status": "complete"})]

    def request(method, url, **_kwargs):
        calls.append((method, url))
        return responses.pop(0)

    monkeypatch.setattr(client.session, "request", request)
    monkeypatch.setattr(CORE.time, "sleep", lambda _seconds: None)
    assert client.api("GET", "/api/uploads/audio/upload-1/") == {"status": "complete"}
    assert len(calls) == 2


def test_sunoclient_cancel_fence_blocks_mutation_before_http(monkeypatch):
    client = CORE.SunoClient("runtime-token", cancelled=lambda: True)
    calls = []
    monkeypatch.setattr(
        client.session,
        "request",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )
    with pytest.raises(Exception):
        client.api("POST", "/api/uploads/audio/", {"extension": "wav"})
    assert calls == []


def test_mutation_journal_blocks_replay_after_restart(tmp_path, monkeypatch):
    journal = tmp_path / "journal.json"
    first = CORE.SunoClient("runtime-token", journal_path=journal)
    monkeypatch.setattr(first.session, "request", lambda *args, **kwargs: FakeResponse(503))
    with pytest.raises(CORE.SubmissionUnknownError):
        first.api("POST", "/api/studio/create-project?title=Song", None,
                  mutation_key="project:create:test")
    second = CORE.SunoClient("runtime-token", journal_path=journal)
    calls = []
    monkeypatch.setattr(second.session, "request", lambda *args, **kwargs: calls.append(args))
    with pytest.raises(CORE.SubmissionUnknownError):
        second.api("POST", "/api/studio/create-project?title=Song", None,
                   mutation_key="project:create:test")
    assert calls == []


def test_upload_all_resumes_completed_segments_and_returns_input_order(tmp_path, monkeypatch):
    segments = [make_segment(tmp_path, i) for i in range(1, 4)]
    progress = tmp_path / "uploaded.json"
    completed = {
        "index": 1,
        "fileName": segments[0].fileName,
        "path": str(segments[0].path),
        "clip_id": "clip-1",
        "upload_id": "upload-1",
    }
    progress.write_text(json.dumps([completed]), encoding="utf-8")
    calls = []

    def fake_upload_one(client, segment, idx, total, initialize_clip=True):
        calls.append(segment.index)
        return {
            "index": segment.index,
            "fileName": segment.fileName,
            "path": str(segment.path),
            "clip_id": f"clip-{segment.index}",
            "upload_id": f"upload-{segment.index}",
        }

    monkeypatch.setattr(CORE, "upload_one", fake_upload_one)
    result = CORE.upload_all(
        SimpleNamespace(),
        segments,
        concurrency=1,
        initialize_clip=True,
        progress_path=progress,
    )
    assert calls == [2, 3]
    assert [row["index"] for row in result] == [1, 2, 3]
    assert [row["clip_id"] for row in json.loads(progress.read_text())] == [
        "clip-1",
        "clip-2",
        "clip-3",
    ]


def test_upload_all_does_not_reuse_checkpoint_for_different_source_path(tmp_path, monkeypatch):
    segment = make_segment(tmp_path, 1)
    progress = tmp_path / "uploaded.json"
    progress.write_text(json.dumps([{
        "index": 1, "fileName": segment.fileName,
        "path": str(tmp_path / "other" / segment.fileName),
        "clip_id": "stale-clip",
    }]), encoding="utf-8")
    calls = []

    def fake_upload_one(_client, current, *_args, **_kwargs):
        calls.append(current.path)
        return {"index": 1, "fileName": current.fileName,
                "path": str(current.path), "clip_id": "fresh-clip"}

    monkeypatch.setattr(CORE, "upload_one", fake_upload_one)
    result = CORE.upload_all(SimpleNamespace(), [segment], concurrency=1,
                             progress_path=progress)
    assert calls == [segment.path]
    assert result[0]["clip_id"] == "fresh-clip"


def test_upload_all_keeps_successful_checkpoint_when_later_segment_fails(
    tmp_path, monkeypatch
):
    segments = [make_segment(tmp_path, i) for i in range(1, 3)]
    progress = tmp_path / "uploaded.json"

    def fake_upload_one(_client, segment, _idx, _total, initialize_clip=True):
        if segment.index == 2:
            raise CORE.ProviderError("segment rejected before submission")
        return {
            "index": segment.index,
            "fileName": segment.fileName,
            "path": str(segment.path),
            "clip_id": "clip-1",
            "upload_id": "upload-1",
        }

    monkeypatch.setattr(CORE, "upload_one", fake_upload_one)
    with pytest.raises(CORE.ProviderError):
        CORE.upload_all(
            SimpleNamespace(),
            segments,
            concurrency=1,
            progress_path=progress,
        )
    rows = json.loads(progress.read_text(encoding="utf-8"))
    assert [row["index"] for row in rows] == [1]


def test_assemble_render_uses_studio_context_and_returns_song_url(tmp_path):
    segment = make_segment(tmp_path)
    row = {
        "index": 1,
        "fileName": segment.fileName,
        "path": str(segment.path),
        "timelineStartSec": 0.0,
        "timelineEndSec": 1.0,
        "duration": 1.0,
        "clip_id": "11111111-1111-4111-8111-111111111111",
    }
    project_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    render_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    song_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

    class Client:
        def __init__(self):
            self.calls = []
            self.render_polls = 0

        def api(self, method, path, body=None, **kwargs):
            self.calls.append((method, path, body, kwargs))
            if path == f"/api/studio/project/{project_id}":
                return {"id": project_id, "state": {"timing": {"bps": 2.0}, "tracks": []}}
            if path == "/api/studio/save-project":
                return {"version_id": "version-1"}
            if path == "/api/studio/render-state":
                return {"render_id": render_id}
            if path == f"/api/gen/{render_id}/":
                self.render_polls += 1
                return {"status": "complete", "clip_id": song_id}
            raise AssertionError(path)

    client = Client()
    result = CORE.assemble_render(client, project_id, [row], "Test", tmp_path)
    assert result["clipId"] == song_id
    assert result["songUrl"] == f"https://suno.com/song/{song_id}"
    render_call = next(call for call in client.calls if call[1] == "/api/studio/render-state")
    payload = render_call[2]
    assert payload["export_mode"] == "rendered_context_window"
    assert payload["from_studio_project_id"] == project_id
    assert payload["end_beats"] == 2.0


def test_assemble_render_timeout_is_not_reported_as_success(tmp_path, monkeypatch):
    segment = make_segment(tmp_path)
    row = {"index": 1, "fileName": segment.fileName, "timelineStartSec": 0,
           "timelineEndSec": 1, "duration": 1, "clip_id": "11111111-1111-4111-8111-111111111111"}
    project_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    render_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    class Client:
        def api(self, method, path, body=None, **kwargs):
            if path.endswith(project_id):
                return {"state": {"timing": {"bps": 2.0}, "tracks": []}}
            if path == "/api/studio/save-project":
                return {"version_id": "version-1"}
            if path == "/api/studio/render-state":
                return {"render_id": render_id}
            return {"status": "processing"}

    monkeypatch.setattr(CORE.time, "sleep", lambda _seconds: None)
    # Avoid a 20-minute fake poll while preserving the production timeout path.
    monkeypatch.setenv("SUNO_RENDER_MAX_POLLS", "2")
    with pytest.raises(TimeoutError, match="RENDER_TIMEOUT"):
        CORE.assemble_render(Client(), project_id, [row], "Test", tmp_path)
