import json
import pathlib
import sys
import tempfile
import wave

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "python"))
import suno_studio_tool as s


def test_segment_manifest_defaults():
    row = dict(index=1, path="x.wav", fileName="x.wav", srcStartSec=0, srcEndSec=1,
               nominalStartSec=0, nominalEndSec=1, timelineStartSec=0, timelineEndSec=1,
               duration=1)
    seg = s.segment_from_manifest(row)
    assert seg.path == pathlib.Path("x.wav")
    assert seg.fadeInSec == seg.fadeOutSec == 0.0


def test_wav_roundtrip():
    with tempfile.TemporaryDirectory() as td:
        p = pathlib.Path(td) / "a.wav"
        original = np.array([[1, 2], [3, -4]], dtype=np.int16)
        s.write_wav_np(p, original, 44100, 2)
        restored, rate, ch = s.read_wav_np(p)
        assert rate == 44100 and ch == 2
        assert np.array_equal(original, restored)


def test_client_headers(monkeypatch):
    c = s.SunoClient("TOKEN", "DEVICE")
    h = c.headers()
    assert h["Authorization"] == "Bearer TOKEN"
    assert h["Device-Id"] == "DEVICE"
    assert json.loads(h["Browser-Token"])["token"]


def test_cdp_base():
    assert s.cdp_base() == f"http://127.0.0.1:{s.CDP_PORT}"
