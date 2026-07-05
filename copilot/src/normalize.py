"""Normalize LLM string outputs to canonical enum values."""

from __future__ import annotations

RELEVANCE_LEVELS = (
    "Strong apply",
    "Apply with tailoring",
    "Low-priority apply",
    "Do not apply",
)

RECOMMENDATIONS = RELEVANCE_LEVELS

GAP_TYPES = (
    "Present and strong",
    "Present but weak",
    "Skill exists but keyword missing",
    "Missing and should not be added",
    "Missing but can be truthfully added based on project experience",
)

_RELEVANCE_ALIASES: dict[str, str] = {
    "not a fit": "Do not apply",
    "no fit": "Do not apply",
    "not fit": "Do not apply",
    "poor fit": "Do not apply",
    "bad fit": "Do not apply",
    "weak fit": "Low-priority apply",
    "low fit": "Low-priority apply",
    "do not apply": "Do not apply",
    "dont apply": "Do not apply",
    "don't apply": "Do not apply",
    "strong apply": "Strong apply",
    "strong fit": "Strong apply",
    "strong match": "Strong apply",
    "good fit": "Strong apply",
    "apply with tailoring": "Apply with tailoring",
    "apply with some tailoring": "Apply with tailoring",
    "needs tailoring": "Apply with tailoring",
    "low priority": "Low-priority apply",
    "low-priority": "Low-priority apply",
    "low priority apply": "Low-priority apply",
}


def normalize_relevance_level(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("relevance_level must be a string")
    text = value.strip()
    if text in RELEVANCE_LEVELS:
        return text

    lower = text.lower()
    if lower in _RELEVANCE_ALIASES:
        return _RELEVANCE_ALIASES[lower]

    if any(phrase in lower for phrase in ("do not apply", "not a fit", "not fit", "no fit", "poor fit")):
        return "Do not apply"
    if "tailor" in lower:
        return "Apply with tailoring"
    if any(phrase in lower for phrase in ("low priority", "low-priority", "weak")):
        return "Low-priority apply"
    if any(phrase in lower for phrase in ("strong", "good fit")):
        return "Strong apply"

    return "Low-priority apply"


def normalize_recommendation(value: object) -> str:
    return normalize_relevance_level(value)


def normalize_gap_type(value: object) -> str:
    default = "Skill exists but keyword missing"
    if not isinstance(value, str):
        return default
    text = value.strip()
    if text in GAP_TYPES:
        return text
    lower = text.lower()
    if "should not be added" in lower:
        return "Missing and should not be added"
    if "truthfully added" in lower or "can be added" in lower:
        return "Missing but can be truthfully added based on project experience"
    if "present and strong" in lower or lower == "strong":
        return "Present and strong"
    if "present but weak" in lower or lower == "weak":
        return "Present but weak"
    if "keyword missing" in lower:
        return "Skill exists but keyword missing"
    return default


def normalize_keyword_gaps(value: object) -> list[dict[str, object]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("gaps must be a list")

    normalized: list[dict[str, object]] = []
    for item in value:
        if isinstance(item, str):
            keyword = item.strip()
            if not keyword:
                continue
            normalized.append(
                {
                    "jd_keyword": keyword,
                    "found_in_resume": False,
                    "evidence": "",
                    "gap_type": "Skill exists but keyword missing",
                    "recommendation": (
                        f"Check whether '{keyword}' can be supported from resume or knowledge base."
                    ),
                }
            )
            continue

        if isinstance(item, dict):
            keyword = str(
                item.get("jd_keyword") or item.get("keyword") or item.get("skill") or ""
            ).strip()
            if not keyword:
                continue
            normalized.append(
                {
                    "jd_keyword": keyword,
                    "found_in_resume": bool(item.get("found_in_resume", item.get("found", False))),
                    "evidence": str(item.get("evidence", "")),
                    "gap_type": normalize_gap_type(item.get("gap_type", "")),
                    "recommendation": str(
                        item.get("recommendation", "") or f"Review evidence for '{keyword}'."
                    ),
                }
            )

    return normalized
