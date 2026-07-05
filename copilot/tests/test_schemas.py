import sys
from pathlib import Path

COPILOT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(COPILOT_ROOT))

from src.schemas import KeywordGapAnalysisResult  # noqa: E402


def test_keyword_gap_analysis_accepts_string_list():
    result = KeywordGapAnalysisResult.model_validate(
        {
            "gaps": [
                "CTEs",
                "window functions",
                "Zendesk",
            ]
        }
    )
    assert len(result.gaps) == 3
    assert result.gaps[0].jd_keyword == "CTEs"
    assert result.gaps[0].gap_type == "Skill exists but keyword missing"
    assert result.gaps[0].found_in_resume is False


def test_keyword_gap_analysis_accepts_object_list():
    result = KeywordGapAnalysisResult.model_validate(
        {
            "gaps": [
                {
                    "jd_keyword": "SQL",
                    "found_in_resume": True,
                    "evidence": "Used in CDPH project",
                    "gap_type": "Present and strong",
                    "recommendation": "Keep visible in skills.",
                }
            ]
        }
    )
    assert result.gaps[0].jd_keyword == "SQL"
    assert result.gaps[0].found_in_resume is True
