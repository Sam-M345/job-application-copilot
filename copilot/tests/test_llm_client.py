import sys
from pathlib import Path

import pytest

COPILOT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(COPILOT_ROOT))

from src.llm_client import _extract_json_object, _parse_model_json  # noqa: E402
from src.normalize import normalize_relevance_level  # noqa: E402
from src.schemas import RelevanceGateResult  # noqa: E402


def test_extract_json_object_ignores_trailing_text():
    raw = '{"relevance_level": "Do not apply", "summary": "Mismatch"}\nExtra note'
    extracted = _extract_json_object(raw)
    assert extracted.endswith('"summary": "Mismatch"}')


def test_extract_json_object_from_markdown_fence():
    raw = """```json
{"relevance_level": "Strong apply", "summary": "Good fit"}
```"""
    extracted = _extract_json_object(raw)
    parsed = RelevanceGateResult.model_validate_json(extracted)
    assert parsed.relevance_level == "Strong apply"


def test_parse_model_json_rejects_schema_shaped_payload():
    raw = '{"properties": {"relevance_level": {"type": "string"}}, "summary": "x"}'
    with pytest.raises(Exception):
        _parse_model_json(RelevanceGateResult, raw)


def test_normalize_relevance_level_maps_not_a_fit():
    assert normalize_relevance_level("Not a fit") == "Do not apply"


def test_relevance_gate_result_accepts_normalized_alias():
    result = RelevanceGateResult.model_validate(
        {"relevance_level": "Not a fit", "summary": "Role mismatch."}
    )
    assert result.relevance_level == "Do not apply"
