"""Persist copilot run logs and analysis traces under repo Logs/copilot/."""

from __future__ import annotations

import json
import logging
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any

from .config import REPO_ROOT

LOG_DIR = REPO_ROOT / "Logs" / "copilot"

_logger: logging.Logger | None = None
_current_log_file: Path | None = None


def _ensure_logger() -> logging.Logger:
    global _logger, _current_log_file
    if _logger is not None:
        return _logger

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    _current_log_file = LOG_DIR / f"run_{stamp}.log"

    logger = logging.getLogger("copilot.run")
    logger.handlers.clear()
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    handler = logging.FileHandler(_current_log_file, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    _logger = logger
    return logger


def begin_run(*, model: str) -> Path:
    logger = _ensure_logger()
    logger.info("=== Copilot run started ===")
    logger.info("Model: %s", model)
    assert _current_log_file is not None
    return _current_log_file


def log_path() -> Path | None:
    return _current_log_file


def log_info(message: str) -> None:
    _ensure_logger().info(message)


def log_error(message: str, exc: BaseException | None = None) -> None:
    logger = _ensure_logger()
    logger.error(message)
    if exc is not None:
        logger.error(
            "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).rstrip()
        )


def log_step(step: str, status: str, message: str) -> None:
    _ensure_logger().info("[%s] %s — %s", step, status, message)


def log_llm_failure(
    *,
    step: str,
    model: str,
    error: BaseException,
    raw_response: str = "",
) -> None:
    log_error(f"LLM failure at {step} (model={model}): {error}", error)
    if raw_response:
        preview = raw_response if len(raw_response) <= 8000 else raw_response[:8000] + "\n...[truncated]"
        log_info(f"Raw model text at {step}:\n{preview}")


def log_analysis_result(result: dict[str, Any]) -> None:
    logger = _ensure_logger()
    halted = result.get("halted")
    halt_reason = result.get("halt_reason", "")
    recommendation = result.get("recommendation") or (
        (result.get("report_sections") or {}).get("final_recommendation") or {}
    ).get("recommendation")

    if halted:
        logger.error("Analysis halted: %s", halt_reason)
    else:
        logger.info("Analysis completed. Recommendation: %s", recommendation or "—")

    trace = result.get("trace") or []
    for entry in trace:
        log_step(entry.get("step", "?"), entry.get("status", "?"), entry.get("message", ""))

    if _current_log_file is None:
        return

    trace_file = _current_log_file.with_name(f"{_current_log_file.stem}_trace.json")
    payload = {
        "halted": halted,
        "halt_reason": halt_reason,
        "recommendation": recommendation,
        "trace": trace,
        "report_sections": result.get("report_sections"),
        "llm_error": result.get("llm_error"),
    }
    trace_file.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    logger.info("Trace JSON: %s", trace_file)
