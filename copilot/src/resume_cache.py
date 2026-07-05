import json
from pathlib import Path

COPILOT_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = COPILOT_ROOT / ".cache"
META_PATH = CACHE_DIR / "last_resume.json"


def _resume_file_path(extension: str) -> Path:
    ext = extension if extension.startswith(".") else f".{extension}"
    return CACHE_DIR / f"last_resume{ext.lower()}"


def save_cached_resume(data: bytes, filename: str) -> Path:
    if not data:
        raise ValueError("Cannot save empty resume file.")
    if not filename.strip():
        raise ValueError("Resume filename is required.")

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    for old in CACHE_DIR.glob("last_resume.*"):
        if old.name != "last_resume.json":
            old.unlink(missing_ok=True)

    ext = Path(filename).suffix.lower() or ".bin"
    dest = _resume_file_path(ext)
    dest.write_bytes(data)

    meta = {
        "filename": filename,
        "path": str(dest.resolve()),
    }
    META_PATH.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return dest


def load_cached_resume() -> tuple[bytes, str, str] | None:
    if not META_PATH.is_file():
        return None
    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    path = Path(meta.get("path", ""))
    filename = meta.get("filename", path.name)
    if not path.is_file():
        return None
    return path.read_bytes(), filename, str(path.resolve())


def clear_cached_resume() -> None:
    if META_PATH.is_file():
        meta = json.loads(META_PATH.read_text(encoding="utf-8"))
        path = Path(meta.get("path", ""))
        if path.is_file():
            path.unlink()
        META_PATH.unlink()
    for leftover in CACHE_DIR.glob("last_resume.*"):
        if leftover.name != "last_resume.json":
            leftover.unlink(missing_ok=True)


def has_cached_resume() -> bool:
    return load_cached_resume() is not None
