"""LangGraph node functions."""

from __future__ import annotations

import json
from typing import Any

from .evidence import EvidenceIndex
from .llm_client import call_llm_json
from .prompts import SYSTEM_NO_INVENT
from .schemas import (
    FitAnalysisResult,
    JobTypeResult,
    KeywordExtractionResult,
    KeywordGapAnalysisResult,
    LocationGateResult,
    RelevanceGateResult,
)
from .state import GraphState
from .trace_util import append_trace, halt, pass_step
from .validation import classify_location_from_jd, is_government_job_text, validate_gov_document_gate

_evidence_index: EvidenceIndex | None = None


def _company_context_block(state: GraphState) -> str:
    text = (state.get("company_context") or "").strip()
    if not text:
        return ""
    return f"Company context:\n{text}\n\n"


def get_evidence_index() -> EvidenceIndex | None:
    return _evidence_index


def reset_evidence_index() -> None:
    global _evidence_index
    _evidence_index = None


def parse_documents(state: GraphState) -> dict[str, Any]:
    resume = (state.get("resume_text") or "").strip()
    jd = (state.get("jd_text") or "").strip()
    if not resume:
        return halt(state, "parse_documents", "Analysis stopped. Resume text is missing.")
    if not jd:
        return halt(state, "parse_documents", "Analysis stopped. Job description text is missing.")
    return {
        "halted": False,
        "trace": pass_step(state, "parse_documents", "Resume and job description received."),
    }


def detect_job_type(state: GraphState) -> dict[str, Any]:
    if state.get("halted"):
        return {}
    jd = state["jd_text"]
    heuristic_gov = is_government_job_text(jd)
    try:
        result = call_llm_json(
            f"Classify this job as private_sector or government_state.\n\n"
            f"{_company_context_block(state)}"
            f"Job description:\n{jd[:6000]}",
            JobTypeResult,
            system=SYSTEM_NO_INVENT,
            max_tokens=512,
            step="detect_job_type",
        )
        if heuristic_gov and result.job_type == "private_sector":
            result = JobTypeResult(
                job_type="government_state",
                reason=f"Heuristic government keywords detected. {result.reason}",
            )
    except Exception as exc:
        return {
            **halt(state, "detect_job_type", f"Analysis stopped. Job type detection failed: {exc}"),
            "llm_error": str(exc),
        }
    return {
        "job_type": result.job_type,
        "job_type_reason": result.reason,
        "trace": pass_step(state, "detect_job_type", f"Job type: {result.job_type}. {result.reason}"),
    }


def document_completeness_gate(state: GraphState) -> dict[str, Any]:
    if state.get("halted"):
        return {}
    ok, message = validate_gov_document_gate(
        job_type=state.get("job_type", "private_sector"),
        duty_statement_text=state.get("duty_statement_text", ""),
    )
    if not ok:
        return halt(state, "document_completeness_gate", message)
    return {
        "trace": pass_step(state, "document_completeness_gate", message),
    }


def location_gate(state: GraphState) -> dict[str, Any]:
    if state.get("halted"):
        return {}
    profile = state.get("profile") or {}
    targets = profile.get("target_locations") or []
    rule = classify_location_from_jd(state["jd_text"], targets)

    if rule.get("requires_user_input"):
        reason = rule.get("user_input_reason", "Location could not be determined.")
        return halt(state, "location_gate", f"Analysis stopped. {reason}")

    if not rule["location_fit"]:
        return {
            "location_fit": False,
            "location_summary": rule["summary"],
            "trace": pass_step(
                state,
                "location_gate",
                f"Recommendation: Do not apply. Reason: {rule['summary']}",
            ),
        }

    try:
        llm = call_llm_json(
            f"""Confirm location fit for candidate targets: {targets}

{_company_context_block(state)}Job description excerpt:
{state['jd_text'][:5000]}

Rule-based result: {json.dumps(rule)}""",
            LocationGateResult,
            system=SYSTEM_NO_INVENT,
            max_tokens=512,
            step="location_gate",
        )
    except Exception as exc:
        return {
            **halt(state, "location_gate", f"Analysis stopped. Location analysis failed: {exc}"),
            "llm_error": str(exc),
        }

    if llm.requires_user_input:
        return halt(
            state,
            "location_gate",
            f"Analysis stopped. {llm.user_input_reason or llm.summary}",
        )
    if not llm.location_fit:
        return {
            "location_fit": False,
            "location_summary": llm.summary,
            "trace": pass_step(
                state,
                "location_gate",
                f"Recommendation: Do not apply. Reason: {llm.summary}",
            ),
        }
    return {
        "location_fit": True,
        "location_summary": llm.summary,
        "trace": pass_step(state, "location_gate", llm.summary),
    }


def relevance_gate(state: GraphState) -> dict[str, Any]:
    if state.get("halted"):
        return {}
    profile = state.get("profile") or {}
    themes = profile.get("target_role_themes") or []
    try:
        result = call_llm_json(
            f"""Evaluate role relevance for candidate target themes: {themes}

Candidate summary: {profile.get('summary', '')}
Candidate skills: {', '.join(profile.get('skills', []))}

{_company_context_block(state)}Job description:
{state['jd_text'][:7000]}""",
            RelevanceGateResult,
            system=SYSTEM_NO_INVENT,
            max_tokens=768,
            step="relevance_gate",
        )
    except Exception as exc:
        return {
            **halt(state, "relevance_gate", f"Analysis stopped. Relevance analysis failed: {exc}"),
            "llm_error": str(exc),
        }

    if result.relevance_level == "Do not apply":
        return {
            "relevance_level": result.relevance_level,
            "relevance_summary": result.summary,
            "trace": pass_step(
                state,
                "relevance_gate",
                f"Recommendation: Do not apply. {result.summary}",
            ),
        }

    return {
        "relevance_level": result.relevance_level,
        "relevance_summary": result.summary,
        "trace": pass_step(state, "relevance_gate", result.summary),
    }


def index_evidence(state: GraphState) -> dict[str, Any]:
    if state.get("halted"):
        return {}
    global _evidence_index
    try:
        _evidence_index = EvidenceIndex()
        _evidence_index.index(
            resume_text=state["resume_text"],
            knowledge_text=state.get("knowledge_text", ""),
            profile=state.get("profile") or {},
            duty_statement_text=state.get("duty_statement_text", ""),
            company_context=state.get("company_context", ""),
        )
    except Exception as exc:
        return halt(state, "index_evidence", f"Analysis stopped. Evidence indexing failed: {exc}")
    return {
        "trace": pass_step(
            state,
            "index_evidence",
            f"Indexed {_evidence_index.chunk_count} evidence chunks from resume, KB, and profile.",
        ),
    }


def analyze_fit(state: GraphState) -> dict[str, Any]:
    if state.get("halted"):
        return {}
    index = get_evidence_index()
    if index is None or index.chunk_count == 0:
        return halt(state, "analyze_fit", "Analysis stopped. Evidence index is empty.")

    try:
        jd_kw = call_llm_json(
            f"Extract 15-25 important keywords/skills from this job description:\n"
            f"{_company_context_block(state)}"
            f"{state['jd_text'][:7000]}",
            KeywordExtractionResult,
            system=SYSTEM_NO_INVENT,
            max_tokens=1024,
            step="analyze_fit.jd_keywords",
        )
        resume_kw = call_llm_json(
            f"Extract 15-25 important keywords/skills from this resume:\n{state['resume_text'][:7000]}",
            KeywordExtractionResult,
            system=SYSTEM_NO_INVENT,
            max_tokens=1024,
            step="analyze_fit.resume_keywords",
        )
    except Exception as exc:
        return {
            **halt(state, "analyze_fit", f"Analysis stopped. Keyword extraction failed: {exc}"),
            "llm_error": str(exc),
        }

    evidence = index.evidence_block(jd_kw.keywords[:12], per_query=2)
    try:
        gaps = call_llm_json(
            f"""Compare JD keywords to resume evidence. Only use this evidence:
{evidence}

JD keywords: {jd_kw.keywords}
Resume keywords: {resume_kw.keywords}

{_company_context_block(state)}Job description excerpt:
{state['jd_text'][:4000]}""",
            KeywordGapAnalysisResult,
            system=SYSTEM_NO_INVENT,
            max_tokens=4096,
            step="analyze_fit.keyword_gaps",
        )
        fit = call_llm_json(
            f"""Full fit analysis using only evidence below.

Evidence:
{evidence}

Profile summary: {(state.get('profile') or {}).get('summary', '')}
Location summary: {state.get('location_summary', '')}
Relevance summary: {state.get('relevance_summary', '')}
Keyword gaps: {gaps.model_dump_json()}

{_company_context_block(state)}Job description:
{state['jd_text'][:6000]}""",
            FitAnalysisResult,
            system=SYSTEM_NO_INVENT,
            max_tokens=4096,
            step="analyze_fit",
        )
    except Exception as exc:
        return {
            **halt(state, "analyze_fit", f"Analysis stopped. Fit analysis failed: {exc}"),
            "llm_error": str(exc),
        }

    return {
        "jd_keywords": jd_kw.keywords,
        "resume_keywords": resume_kw.keywords,
        "keyword_gaps": [g.model_dump() for g in gaps.gaps],
        "fit_score": fit.fit_score,
        "location_score": fit.location_score,
        "skill_score": fit.skill_score,
        "keyword_score": fit.keyword_score,
        "risk_level": fit.risk_level,
        "recommendation": fit.recommendation,
        "recommendation_reason": fit.main_reason,
        "next_action": fit.next_action,
        "objections": [o.model_dump() for o in fit.objections],
        "tailoring": fit.tailoring.model_dump(),
        "trace": pass_step(
            state,
            "analyze_fit",
            f"Recommendation: {fit.recommendation}. {fit.main_reason}",
        ),
    }


def format_report(state: GraphState) -> dict[str, Any]:
    if state.get("halted"):
        return {"report_sections": {"halt_reason": state.get("halt_reason", "")}}
    sections = {
        "final_recommendation": {
            "recommendation": state.get("recommendation"),
            "reason": state.get("recommendation_reason"),
            "next_action": state.get("next_action"),
        },
        "location_fit": {
            "fit": state.get("location_fit"),
            "summary": state.get("location_summary"),
        },
        "relevance_fit": {
            "level": state.get("relevance_level"),
            "summary": state.get("relevance_summary"),
        },
        "fit_score_breakdown": {
            "fit_score": state.get("fit_score"),
            "location_score": state.get("location_score"),
            "skill_score": state.get("skill_score"),
            "keyword_score": state.get("keyword_score"),
            "risk_level": state.get("risk_level"),
        },
        "jd_keywords": state.get("jd_keywords", []),
        "resume_keywords": state.get("resume_keywords", []),
        "keyword_gaps": state.get("keyword_gaps", []),
        "tailoring": state.get("tailoring", {}),
        "objections": state.get("objections", []),
    }
    return {
        "report_sections": sections,
        "trace": append_trace(state, "format_report", "completed", "Report formatted."),
    }
