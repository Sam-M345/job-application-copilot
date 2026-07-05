from typing import Literal

from pydantic import BaseModel, Field, field_validator

from .normalize import (
    normalize_gap_type,
    normalize_keyword_gaps,
    normalize_recommendation,
    normalize_relevance_level,
)


class JobTypeResult(BaseModel):
    job_type: Literal["private_sector", "government_state"]
    reason: str


class LocationGateResult(BaseModel):
    location_fit: bool
    summary: str
    detected_location: str = ""
    work_mode: Literal["remote", "hybrid", "on_site", "unknown"] = "unknown"
    requires_user_input: bool = False
    user_input_reason: str = ""


class RelevanceGateResult(BaseModel):
    relevance_level: Literal[
        "Strong apply",
        "Apply with tailoring",
        "Low-priority apply",
        "Do not apply",
    ]
    summary: str

    @field_validator("relevance_level", mode="before")
    @classmethod
    def _normalize_relevance_level(cls, value: object) -> str:
        return normalize_relevance_level(value)


class KeywordExtractionResult(BaseModel):
    keywords: list[str] = Field(default_factory=list)


class KeywordGapItem(BaseModel):
    jd_keyword: str
    found_in_resume: bool
    evidence: str
    gap_type: Literal[
        "Present and strong",
        "Present but weak",
        "Skill exists but keyword missing",
        "Missing and should not be added",
        "Missing but can be truthfully added based on project experience",
    ]
    recommendation: str

    @field_validator("gap_type", mode="before")
    @classmethod
    def _normalize_gap_type(cls, value: object) -> str:
        return normalize_gap_type(value)


class KeywordGapAnalysisResult(BaseModel):
    gaps: list[KeywordGapItem]

    @field_validator("gaps", mode="before")
    @classmethod
    def _normalize_gaps(cls, value: object) -> list[dict[str, object]]:
        return normalize_keyword_gaps(value)


class ObjectionItem(BaseModel):
    concern: str
    mitigation: str


class TailoringResult(BaseModel):
    summary_edits: list[str] = Field(default_factory=list)
    skills_additions: list[str] = Field(default_factory=list)
    project_bullet_improvements: list[str] = Field(default_factory=list)
    experience_bullet_improvements: list[str] = Field(default_factory=list)
    keywords_to_add: list[str] = Field(default_factory=list)
    keywords_not_to_add: list[str] = Field(default_factory=list)
    top_three_bullets_to_customize: list[str] = Field(default_factory=list)


class FitAnalysisResult(BaseModel):
    fit_score: int = Field(ge=0, le=100)
    location_score: int = Field(ge=0, le=100)
    skill_score: int = Field(ge=0, le=100)
    keyword_score: int = Field(ge=0, le=100)
    risk_level: Literal["Low", "Medium", "High"]
    recommendation: Literal[
        "Strong apply",
        "Apply with tailoring",
        "Low-priority apply",
        "Do not apply",
    ]
    main_reason: str
    next_action: str
    objections: list[ObjectionItem] = Field(default_factory=list)
    tailoring: TailoringResult

    @field_validator("recommendation", mode="before")
    @classmethod
    def _normalize_recommendation(cls, value: object) -> str:
        return normalize_recommendation(value)


class CoverLetterResult(BaseModel):
    cover_letter: str


class ResumeJobEntry(BaseModel):
    title_line: str = Field(
        description="Job title and employer, e.g. 'Senior Data Analyst | Acme Corp'"
    )
    date_range: str = Field(description="Employment dates, e.g. 'Jan 2020 – Present'")
    location: str = Field(default="", description="Optional city/state in muted gray")
    bullet_points: list[str] = Field(default_factory=list)


class ResumeSectionContent(BaseModel):
    heading: str
    bullet_points: list[str] = Field(default_factory=list)
    paragraphs: list[str] = Field(default_factory=list)
    job_entries: list[ResumeJobEntry] = Field(
        default_factory=list,
        description="Use for Experience (and similar) sections; dates render on the same line as title",
    )


class CustomizedResumeContent(BaseModel):
    company_name: str
    header_lines: list[str] = Field(default_factory=list)
    sections: list[ResumeSectionContent] = Field(default_factory=list)
