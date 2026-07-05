import importlib
import sys
from pathlib import Path

COPILOT_ROOT = Path(__file__).resolve().parent
if str(COPILOT_ROOT) not in sys.path:
    sys.path.insert(0, str(COPILOT_ROOT))

import streamlit as st

# Streamlit re-runs app.py but keeps sys.modules; graph loads prompts before materials
# needs names added later (e.g. RESUME_CUSTOMIZE_SYSTEM). Reload so disk edits apply.
import src.prompts as _prompts

importlib.reload(_prompts)

from src.config import get_settings, load_knowledge_text, load_profile
from src.graph import run_analysis
from src.materials import generate_cover_letter, generate_customized_resume
from src.parsers import ParseError, parse_document_text, parse_optional_document_text
from src.resume_cache import clear_cached_resume, load_cached_resume, save_cached_resume
from src import run_log

st.set_page_config(page_title="Job Application Intelligence Copilot", layout="wide")

st.title("Job Application Intelligence Copilot")
st.caption(
    "Analyze a job description against your resume, identify fit, gaps, keywords, and application strategy."
)

with st.sidebar:
    st.header("Settings")
    st.markdown("Knowledge base loaded from `Knowledge_Base_Source.txt`. Edit below for this session only.")
    if "kb_override" not in st.session_state:
        st.session_state.kb_override = load_knowledge_text()
    kb_override = st.text_area(
        "Knowledge Base override (session only)",
        height=280,
        key="kb_override",
    )

SAMPLE_JD_PATH = COPILOT_ROOT.parent / "DOCS" / "copilot" / "samples" / "harvey_support_ops_jd.txt"

col1, col2 = st.columns(2)

with col1:
    st.subheader("Resume")
    resume_paste = st.text_area("Paste resume text", height=220, label_visibility="collapsed")
    resume_upload = st.file_uploader("Or upload resume PDF or Word", type=["pdf", "docx"], key="resume_upload")

    if resume_upload is not None:
        save_cached_resume(resume_upload.getvalue(), resume_upload.name)

    cached_resume = load_cached_resume()
    if cached_resume and resume_upload is None:
        cached_bytes, cached_name, cached_path = cached_resume
        info_col, remove_col = st.columns([4, 1])
        with info_col:
            st.caption(f"Saved resume: **{cached_name}**")
            st.caption(f"`{cached_path}`")
        with remove_col:
            if st.button("Remove", key="remove_saved_resume", help="Clear saved resume"):
                clear_cached_resume()
                st.rerun()

with col2:
    jd_title_col, jd_sample_col = st.columns([5, 1], vertical_alignment="center")
    with jd_title_col:
        st.subheader("Job Description")
    with jd_sample_col:
        if st.button("Sample", key="load_jd_sample", use_container_width=True):
            st.session_state.jd_paste = SAMPLE_JD_PATH.read_text(encoding="utf-8")
            st.rerun()
    jd_paste = st.text_area(
        "Paste job description",
        height=220,
        label_visibility="collapsed",
        key="jd_paste",
    )
    jd_pdf = st.file_uploader("Or upload JD PDF", type=["pdf"], key="jd_pdf")

company_context = st.text_input(
    "Company context (optional)",
    help="Employer name, mission, team, or other details not fully in the JD. Used in analysis and apply materials.",
)

duty_paste = ""
duty_upload = None
duty_statement_enabled = st.toggle("Duty Statement", value=False, key="duty_statement_enabled")
if duty_statement_enabled:
    duty_paste = st.text_area("Paste duty statement", height=120, label_visibility="collapsed")
    duty_upload = st.file_uploader(
        "Or upload duty statement PDF or Word", type=["pdf", "docx"], key="duty_upload"
    )

active_model = get_settings().anthropic_model

run_col, model_col = st.columns([1, 5], vertical_alignment="center")
with run_col:
    run_clicked = st.button("Run Analysis", type="primary")
with model_col:
    st.markdown(f"**AI model:** `{active_model}`")

if "result" not in st.session_state:
    st.session_state.result = None
if "cover_letter" not in st.session_state:
    st.session_state.cover_letter = ""
if "custom_resume_docx" not in st.session_state:
    st.session_state.custom_resume_docx = None
if "custom_resume_filename" not in st.session_state:
    st.session_state.custom_resume_filename = ""
if "custom_resume_error" not in st.session_state:
    st.session_state.custom_resume_error = ""

if run_clicked:
    st.session_state.cover_letter = ""
    st.session_state.custom_resume_docx = None
    st.session_state.custom_resume_filename = ""
    st.session_state.custom_resume_error = ""
    try:
        resume_bytes = resume_upload.getvalue() if resume_upload else None
        resume_name = resume_upload.name if resume_upload else None
        if not resume_bytes and not resume_paste.strip():
            cached = load_cached_resume()
            if cached:
                resume_bytes, resume_name, _ = cached
        jd_bytes = jd_pdf.getvalue() if jd_pdf else None
        jd_name = jd_pdf.name if jd_pdf else None
        duty_bytes = duty_upload.getvalue() if duty_upload else None
        duty_name = duty_upload.name if duty_upload else None
        resume_text = parse_document_text(
            pasted=resume_paste,
            uploaded_bytes=resume_bytes,
            uploaded_filename=resume_name,
            label="Resume",
            allowed_extensions=(".pdf", ".docx"),
        )
        jd_text = parse_document_text(
            pasted=jd_paste,
            uploaded_bytes=jd_bytes,
            uploaded_filename=jd_name,
            label="Job description",
            allowed_extensions=(".pdf",),
        )
        duty_text = parse_optional_document_text(
            pasted=duty_paste,
            uploaded_bytes=duty_bytes,
            uploaded_filename=duty_name,
            label="Duty Statement",
            allowed_extensions=(".pdf", ".docx"),
        )
        profile = load_profile()
        knowledge = load_knowledge_text(kb_override)

        run_log.begin_run(model=active_model)

        initial = {
            "resume_text": resume_text,
            "jd_text": jd_text,
            "company_context": company_context,
            "duty_statement_text": duty_text,
            "knowledge_text": knowledge,
            "profile": profile,
            "halted": False,
            "trace": [],
        }
        with st.spinner("Running analysis..."):
            st.session_state.result = run_analysis(initial)
        run_log.log_analysis_result(st.session_state.result)
    except (ParseError, FileNotFoundError, ValueError) as exc:
        run_log.log_error("Analysis input error", exc)
        st.error(str(exc))
        st.session_state.result = None
    except Exception as exc:
        run_log.log_error("Analysis failed", exc)
        st.error(f"Analysis failed: {exc}")
        st.session_state.result = None

result = st.session_state.result
if result:
    st.divider()
    trace = result.get("trace") or []
    sections = result.get("report_sections") or {}
    rec = sections.get("final_recommendation") or {}
    recommendation = rec.get("recommendation", "") or ""
    reason = rec.get("reason", "") or result.get("halt_reason", "")

    if result.get("halted"):
        st.error(result.get("halt_reason", "Analysis halted."))
    elif recommendation == "Do not apply":
        st.error(f"**{recommendation}** — {reason}")
    elif recommendation:
        st.success(f"**{recommendation}** — {reason}")

    c1, c2, c3 = st.columns(3)
    scores = sections.get("fit_score_breakdown") or {}
    c1.metric("Fit Score", scores.get("fit_score", "—"))
    c2.metric("Skill Score", scores.get("skill_score", "—"))
    c3.metric("Risk", scores.get("risk_level", "—"))

    st.subheader("Location Fit")
    loc = sections.get("location_fit") or {}
    st.write(loc.get("summary", "") or "—")

    st.subheader("Relevance Fit")
    rel = sections.get("relevance_fit") or {}
    rel_level = rel.get("level", "")
    rel_summary = rel.get("summary", "")
    st.write(f"{rel_level}: {rel_summary}" if rel_level or rel_summary else "—")

    st.subheader("Keyword Gap Analysis")
    gaps = sections.get("keyword_gaps") or []
    if gaps:
        st.dataframe(gaps, use_container_width=True)
    else:
        st.write("No keyword gaps returned.")

    with st.expander(f"Analysis Trace ({len(trace)} steps)", expanded=False):
        for entry in trace:
            icon = "🔴" if entry["status"] == "halted" else "🟢" if entry["status"] == "passed" else "⚪"
            st.markdown(f"{icon} **{entry['step']}** — {entry['message']}")

    tailoring = sections.get("tailoring") or {}
    tailoring_count = sum(len(v) for v in tailoring.values() if isinstance(v, list))
    with st.expander(
        f"Resume Tailoring Recommendations ({tailoring_count} items)", expanded=False
    ):
        if tailoring:
            st.json(tailoring)
        else:
            st.write("No tailoring recommendations returned.")

    objections = sections.get("objections") or []
    with st.expander(
        f"Employer Objection Analysis ({len(objections)} items)", expanded=False
    ):
        if objections:
            for obj in objections:
                st.markdown(f"- **Concern:** {obj.get('concern', '')}")
                st.markdown(f"  **Mitigation:** {obj.get('mitigation', '')}")
        else:
            st.write("No objections returned.")

    st.subheader("Suggested Next Action")
    st.write(rec.get("next_action", "") or "—")

    st.divider()
    btn_resume, btn_cover = st.columns(2)
    st.markdown(
        """
        <style>
        div[data-testid="column"] + div[data-testid="column"] button[kind="secondary"] {
            background-color: #00aaff !important;
            color: #000000 !important;
            border-color: #00aaff !important;
        }
        div[data-testid="column"] + div[data-testid="column"] button[kind="secondary"] p {
            color: #000000 !important;
        }
        div[data-testid="column"] + div[data-testid="column"] button[kind="secondary"]:hover:not(:disabled) {
            background-color: #33bbff !important;
            color: #000000 !important;
            border-color: #33bbff !important;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )
    with btn_resume:
        if st.button("Customize resume", type="primary"):
            with st.spinner("Generating customized resume..."):
                resume_state = generate_customized_resume(result)
                if resume_state.get("custom_resume_error"):
                    st.session_state.custom_resume_error = resume_state["custom_resume_error"]
                    st.session_state.custom_resume_docx = None
                else:
                    st.session_state.custom_resume_docx = resume_state.get("custom_resume_docx")
                    st.session_state.custom_resume_filename = resume_state.get(
                        "custom_resume_filename", "Alex-Chen-Resume.docx"
                    )
                    st.session_state.custom_resume_error = ""

    with btn_cover:
        if st.button("Generate cover letter"):
            with st.spinner("Generating cover letter..."):
                cover_state = generate_cover_letter(result)
                if cover_state.get("cover_letter_error"):
                    st.error(cover_state["cover_letter_error"])
                else:
                    st.session_state.cover_letter = cover_state.get("cover_letter", "")

    if st.session_state.custom_resume_error:
        st.error(st.session_state.custom_resume_error)
    if st.session_state.custom_resume_docx:
        st.download_button(
            label="Download customized resume (.docx)",
            data=st.session_state.custom_resume_docx,
            file_name=st.session_state.custom_resume_filename,
            mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )

    if st.session_state.cover_letter:
        st.text_area("Cover letter", value=st.session_state.cover_letter, height=320)
