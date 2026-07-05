"""Optional apply materials: cover letter and customized resume."""

from __future__ import annotations

import json
from typing import Any

from .llm_client import call_llm_json, call_llm_text
from .nodes import get_evidence_index
from .prompts import COVER_LETTER_SYSTEM, RESUME_CUSTOMIZE_SYSTEM
from .resume_docx import (
    MIN_RESUME_WORDS,
    build_resume_docx,
    count_resume_words,
    resume_download_filename,
)
from .schemas import CustomizedResumeContent
from .state import GraphState


def generate_cover_letter(state: GraphState) -> dict[str, Any]:
    if not (state.get("resume_text") or "").strip():
        return {"cover_letter_error": "Resume text is missing."}
    if not (state.get("jd_text") or "").strip():
        return {"cover_letter_error": "Job description text is missing."}

    index = get_evidence_index()
    evidence = index.evidence_block(state.get("jd_keywords", [])[:8], per_query=2) if index else ""
    profile = state.get("profile") or {}
    try:
        letter = call_llm_text(
            f"""Write a cover letter for this job.

Candidate: {profile.get('first_name', '')} {profile.get('last_name', '')}
Company context: {state.get('company_context', '') or 'Not provided'}

Evidence only:
{evidence}

Job description:
{state['jd_text'][:5000]}

Recommendation context: {state.get('recommendation_reason', '')}""",
            system=COVER_LETTER_SYSTEM,
            max_tokens=2048,
            step="generate_cover_letter",
        )
    except Exception as exc:
        return {"cover_letter_error": f"Cover letter generation failed: {exc}"}
    return {"cover_letter": letter, "cover_letter_error": ""}


def generate_customized_resume(state: GraphState) -> dict[str, Any]:
    if not (state.get("resume_text") or "").strip():
        return {"custom_resume_error": "Resume text is missing."}
    if not (state.get("jd_text") or "").strip():
        return {"custom_resume_error": "Job description text is missing."}

    index = get_evidence_index()
    evidence = index.evidence_block(state.get("jd_keywords", [])[:10], per_query=2) if index else ""
    profile = state.get("profile") or {}
    tailoring = state.get("tailoring") or {}
    keyword_gaps = state.get("keyword_gaps") or []
    company_context = state.get("company_context", "") or "Not provided"

    profile_fields = (
        "location",
        "email",
        "phone",
        "linkedin",
        "github",
        "portfolio",
        "kaggle",
        "summary",
        "skills",
        "certifications",
        "experience",
        "projects",
        "education",
    )
    profile_blob = {k: profile.get(k) for k in profile_fields if profile.get(k)}

    base_prompt = f"""Create a full job-tailored resume for this application.

Candidate: {profile.get('first_name', '')} {profile.get('last_name', '')}
Company context: {company_context}

Original resume:
{state.get('resume_text', '')[:12000]}

Job description:
{state['jd_text'][:7000]}

Tailoring recommendations:
{json.dumps(tailoring)}

Keyword gaps:
{json.dumps(keyword_gaps[:20])}

Evidence (only use supported facts):
{evidence}

Profile:
{json.dumps(profile_blob)}

Return company_name for the employer name (from JD or company context).
Do not return header_lines; the DOCX builder adds the header from profile with clickable links.
sections: ALL CAPS headings. Use job_entries for EXPERIENCE (title_line, date_range, location, bullet_points).
Use paragraphs for SUMMARY; bullet_points for SKILLS and PROJECTS.
Hard requirement: at least {MIN_RESUME_WORDS} words across all section text combined."""

    try:
        content = call_llm_json(
            base_prompt,
            CustomizedResumeContent,
            system=RESUME_CUSTOMIZE_SYSTEM,
            max_tokens=8192,
            step="generate_customized_resume",
        )
        word_count = count_resume_words(content)
        if word_count < MIN_RESUME_WORDS:
            content = call_llm_json(
                f"""{base_prompt}

REVISION REQUIRED: The previous draft was only {word_count} words.
Expand every section with supported, job-relevant detail until the resume body reaches at least {MIN_RESUME_WORDS} words.
Add more EXPERIENCE and PROJECT bullets, a fuller SUMMARY, and richer SKILLS coverage.""",
                CustomizedResumeContent,
                system=RESUME_CUSTOMIZE_SYSTEM,
                max_tokens=8192,
                step="generate_customized_resume_expand",
            )
            word_count = count_resume_words(content)
            if word_count < MIN_RESUME_WORDS:
                return {
                    "custom_resume_error": (
                        f"Resume customization failed: generated only {word_count} words; "
                        f"minimum is {MIN_RESUME_WORDS}."
                    )
                }

        docx_bytes = build_resume_docx(content, profile)
        filename = resume_download_filename(content, profile)
    except Exception as exc:
        return {"custom_resume_error": f"Resume customization failed: {exc}"}

    return {
        "custom_resume_docx": docx_bytes,
        "custom_resume_filename": filename,
        "custom_resume_error": "",
    }
