import sys
from pathlib import Path

COPILOT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(COPILOT_ROOT))

from src.validation import (  # noqa: E402
    classify_location_from_jd,
    is_government_job_text,
    validate_gov_document_gate,
)

TARGETS = ["Remote", "San Francisco", "San Francisco Bay Area", "Hybrid in Bay Area"]


def test_remote_role_accepted():
    jd = "This is a fully remote role. Work from anywhere in the US."
    result = classify_location_from_jd(jd, TARGETS)
    assert result["location_fit"] is True
    assert result["work_mode"] == "remote"


def test_austin_onsite_rejected():
    jd = "On-site role in Austin, Texas. Must work from our Austin office."
    result = classify_location_from_jd(jd, TARGETS)
    assert result["location_fit"] is False
    assert "texas" in result["summary"].lower() or "austin" in result["summary"].lower()


def test_los_angeles_hybrid_rejected():
    jd = "Hybrid position based in Los Angeles, CA. 3 days in office."
    result = classify_location_from_jd(jd, TARGETS)
    assert result["location_fit"] is False


def test_bay_area_hybrid_accepted():
    jd = "Hybrid role in Mountain View, CA with 2 days in office."
    result = classify_location_from_jd(jd, TARGETS)
    assert result["location_fit"] is True


def test_unknown_location_requires_user_input():
    jd = "Join our team to build great products. No location mentioned at all."
    result = classify_location_from_jd(jd, TARGETS)
    assert result["requires_user_input"] is True


def test_gov_keyword_detection():
    assert is_government_job_text("State of California job control JC-123456")
    assert not is_government_job_text("Greenhouse startup data scientist role")


def test_gov_duty_gate_passes_without_statement():
    ok, msg = validate_gov_document_gate(
        job_type="government_state",
        duty_statement_text="",
    )
    assert ok is True
    assert "continuing without it" in msg


def test_gov_duty_gate_passes_with_statement():
    ok, _ = validate_gov_document_gate(
        job_type="government_state",
        duty_statement_text="Duty statement text here",
    )
    assert ok is True


def test_private_sector_skips_duty_gate():
    ok, msg = validate_gov_document_gate(
        job_type="private_sector",
        duty_statement_text="",
    )
    assert ok is True
    assert "no Duty Statement" in msg
