from typing import Any, Literal, TypedDict

RecommendationLevel = Literal[
    "Strong apply",
    "Apply with tailoring",
    "Low-priority apply",
    "Do not apply",
]

JobType = Literal["private_sector", "government_state"]


class TraceEntry(TypedDict):
    step: str
    status: str
    message: str


class GraphState(TypedDict, total=False):
    resume_text: str
    jd_text: str
    company_context: str
    duty_statement_text: str
    knowledge_text: str
    profile: dict[str, Any]

    halted: bool
    halt_reason: str
    trace: list[TraceEntry]

    job_type: JobType
    job_type_reason: str

    location_fit: bool
    location_summary: str
    location_requires_user_input: bool

    relevance_level: RecommendationLevel
    relevance_summary: str

    jd_keywords: list[str]
    resume_keywords: list[str]
    keyword_gaps: list[dict[str, Any]]

    fit_score: int
    location_score: int
    skill_score: int
    keyword_score: int
    risk_level: str
    recommendation: RecommendationLevel
    recommendation_reason: str
    next_action: str

    objections: list[dict[str, str]]
    tailoring: dict[str, Any]

    report_sections: dict[str, Any]
    cover_letter: str
    cover_letter_error: str

    llm_error: str
