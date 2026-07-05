import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

COPILOT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(COPILOT_ROOT))

from src.llm_client import _message_text  # noqa: E402
from src import run_log  # noqa: E402


def test_message_text_skips_thinking_block():
    response = SimpleNamespace(
        content=[
            SimpleNamespace(type="thinking", thinking="internal reasoning"),
            SimpleNamespace(type="text", text='{"relevance_level": "Do not apply", "summary": "Mismatch"}'),
        ]
    )
    text = _message_text(response)
    assert "relevance_level" in text
    assert "internal reasoning" not in text


def test_message_text_joins_multiple_text_blocks():
    response = SimpleNamespace(
        content=[
            SimpleNamespace(type="text", text='{"a": 1,'),
            SimpleNamespace(type="text", text=' "b": 2}'),
        ]
    )
    assert _message_text(response) == '{"a": 1,\n "b": 2}'


def test_message_text_raises_when_only_thinking_blocks():
    response = SimpleNamespace(
        content=[SimpleNamespace(type="thinking", thinking="only thinking")]
    )
    with pytest.raises(ValueError, match="No text block"):
        _message_text(response)


def test_run_log_writes_log_and_trace(tmp_path, monkeypatch):
    monkeypatch.setattr(run_log, "LOG_DIR", tmp_path)
    run_log._logger = None
    run_log._current_log_file = None

    log_file = run_log.begin_run(model="claude-sonnet-5-test")
    run_log.log_error("Relevance analysis failed", ValueError("demo failure"))
    run_log.log_analysis_result(
        {
            "halted": True,
            "halt_reason": "Relevance analysis failed: demo failure",
            "trace": [{"step": "relevance_gate", "status": "halted", "message": "demo failure"}],
            "report_sections": {},
        }
    )

    assert log_file.is_file()
    log_text = log_file.read_text(encoding="utf-8")
    assert "Relevance analysis failed" in log_text
    assert "demo failure" in log_text

    trace_file = log_file.with_name(f"{log_file.stem}_trace.json")
    assert trace_file.is_file()
    assert "relevance_gate" in trace_file.read_text(encoding="utf-8")
