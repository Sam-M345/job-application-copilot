import json
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

COPILOT_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = COPILOT_ROOT.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", COPILOT_ROOT / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    anthropic_api_key: str
    anthropic_model: str = "claude-sonnet-4-6"

    profile_path: Path = Field(default=REPO_ROOT / "data" / "profile.json")
    knowledge_path: Path = Field(default=REPO_ROOT / "Knowledge_Base_Source.txt")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def load_profile() -> dict:
    path = get_settings().profile_path
    if not path.is_file():
        raise FileNotFoundError(
            f"Profile not found: {path}. Create it from DOCS/copilot/profile.example.json"
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    missing = [k for k in ("target_locations", "target_role_themes") if not data.get(k)]
    if missing:
        raise ValueError(
            f"Profile missing required fields: {', '.join(missing)}. "
            f"See DOCS/copilot/profile.example.json"
        )
    return data


def load_knowledge_text(override: str | None = None) -> str:
    if override is not None and override.strip():
        return override.strip()
    path = get_settings().knowledge_path
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8").strip()
