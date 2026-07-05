import sys
from pathlib import Path

COPILOT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(COPILOT_ROOT))

from src.resume_cache import (  # noqa: E402
    clear_cached_resume,
    load_cached_resume,
    save_cached_resume,
)


def test_save_and_load_cached_resume(tmp_path, monkeypatch):
    cache_dir = tmp_path / ".cache"
    meta_path = cache_dir / "last_resume.json"
    monkeypatch.setattr("src.resume_cache.CACHE_DIR", cache_dir)
    monkeypatch.setattr("src.resume_cache.META_PATH", meta_path)

    data = b"%PDF-1.4 sample"
    dest = save_cached_resume(data, "Alex-Chen-Resume.pdf")
    assert dest.is_file()

    loaded = load_cached_resume()
    assert loaded is not None
    assert loaded[0] == data
    assert loaded[1] == "Alex-Chen-Resume.pdf"
    assert loaded[2].endswith("last_resume.pdf")


def test_clear_cached_resume(tmp_path, monkeypatch):
    cache_dir = tmp_path / ".cache"
    meta_path = cache_dir / "last_resume.json"
    monkeypatch.setattr("src.resume_cache.CACHE_DIR", cache_dir)
    monkeypatch.setattr("src.resume_cache.META_PATH", meta_path)

    save_cached_resume(b"hello", "resume.docx")
    assert load_cached_resume() is not None
    clear_cached_resume()
    assert load_cached_resume() is None
