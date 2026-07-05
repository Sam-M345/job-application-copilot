import re

BAY_AREA_TERMS = (
    "san francisco",
    "sf bay",
    "bay area",
    "mountain view",
    "palo alto",
    "san jose",
    "sunnyvale",
    "menlo park",
    "redwood city",
    "oakland",
    "fremont",
    "south bay",
    "peninsula",
)

REJECT_ONSITE_TERMS = (
    ("austin", "texas"),
    ("dallas", "texas"),
    ("houston", "texas"),
    ("los angeles",),
    ("la,",),
    ("new york",),
    ("nyc",),
    ("chicago",),
    ("boston",),
    ("seattle",),
    ("denver",),
    ("miami",),
)

GOV_KEYWORDS = re.compile(
    r"\b(state of california|california state|calcareers|duty statement|"
    r"class specification|job control|public sector|government|state agency|"
    r"county of|city of .{0,40} department)\b",
    re.I,
)


def is_government_job_text(jd_text: str) -> bool:
    return bool(GOV_KEYWORDS.search(jd_text))


def classify_location_from_jd(jd_text: str, target_locations: list[str]) -> dict:
    """Rule-based location classification for unit tests and first pass."""
    text = jd_text.lower()

    if re.search(r"\b(relocation required|must relocate|relocate to)\b", text):
        return {
            "location_fit": False,
            "summary": "Relocation is required. Target locations are remote or San Francisco Bay Area only.",
            "detected_location": "relocation required",
            "work_mode": "on_site",
            "requires_user_input": False,
        }

    is_remote = bool(
        re.search(
            r"\b(fully remote|100% remote|remote anywhere|work from anywhere|"
            r"remote -? (us|usa|united states)|telecommute|work from home)\b",
            text,
        )
    )
    if is_remote and not re.search(r"\b(on-?site required|in-?office required|must be located in)\b", text):
        return {
            "location_fit": True,
            "summary": "Role appears fully remote.",
            "detected_location": "remote",
            "work_mode": "remote",
            "requires_user_input": False,
        }

    in_bay = any(term in text for term in BAY_AREA_TERMS)
    hybrid = "hybrid" in text
    on_site = bool(re.search(r"\b(on-?site|in-?office|in office)\b", text))

    for terms in REJECT_ONSITE_TERMS:
        if all(t in text for t in terms):
            place = " ".join(terms)
            mode = "hybrid" if hybrid else "on-site"
            return {
                "location_fit": False,
                "summary": (
                    f"This role requires {mode} presence in {place.title()}. "
                    "Target location is remote or San Francisco Bay Area."
                ),
                "detected_location": place,
                "work_mode": "hybrid" if hybrid else "on_site",
                "requires_user_input": False,
            }

    if in_bay and (hybrid or on_site or "san francisco" in text):
        mode = "hybrid" if hybrid else ("on-site" if on_site else "hybrid/on-site")
        return {
            "location_fit": True,
            "summary": f"Role appears {mode} in the San Francisco Bay Area.",
            "detected_location": "San Francisco Bay Area",
            "work_mode": "hybrid" if hybrid else "on_site",
            "requires_user_input": False,
        }

    if on_site or hybrid:
        return {
            "location_fit": False,
            "summary": (
                "Role requires physical presence outside your accepted Bay Area / remote targets."
            ),
            "detected_location": "unspecified on-site/hybrid",
            "work_mode": "hybrid" if hybrid else "on_site",
            "requires_user_input": False,
        }

    if not re.search(r"\b(remote|location|based in|office|hybrid|on-?site)\b", text):
        return {
            "location_fit": False,
            "summary": "",
            "detected_location": "",
            "work_mode": "unknown",
            "requires_user_input": True,
            "user_input_reason": (
                "The job location could not be determined from the job description. "
                "Please confirm the role is fully remote or provide the location."
            ),
        }

    return {
        "location_fit": False,
        "summary": "Location requirements are unclear or outside accepted targets.",
        "detected_location": "unknown",
        "work_mode": "unknown",
        "requires_user_input": True,
        "user_input_reason": (
            "Location could not be matched to remote or Bay Area. "
            "Confirm remote status or provide the exact location."
        ),
    }


def validate_gov_document_gate(
    *,
    job_type: str,
    duty_statement_text: str,
) -> tuple[bool, str]:
    if job_type != "government_state":
        return True, "Private-sector role: no Duty Statement required."
    if duty_statement_text.strip():
        return True, "Duty Statement provided."
    return True, "No Duty Statement provided; continuing without it."
