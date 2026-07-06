# Job Application Intelligence Copilot (Phase 2)

Pre-apply decision support: analyze a job description against your resume, run location and relevance gates, surface keyword gaps with evidence, and optionally generate a cover letter.

Phase 1 (Tampermonkey apply automation) is unchanged. This copilot answers **whether and how** to apply before you use the apply scripts.

## Problem

Applying to every role wastes time. This copilot gates on location and relevance, compares JD keywords to resume evidence, and recommends truthful tailoring — with **no fallback behavior** (missing inputs halt the workflow with a clear message).

## Tech Stack

- **UI:** Streamlit
- **Workflow:** LangGraph
- **LLM:** Claude (Anthropic API)
- **Evidence retrieval:** Chroma (in-memory, session-scoped)
- **Parsing:** pypdf for PDF uploads

## Architecture

```text
Resume + JD + profile.json + KB
  -> parse
  -> detect job type
  -> document completeness gate (gov Duty Statement)
  -> location gate
  -> relevance gate
  -> index evidence (Chroma)
  -> keyword gaps + fit + objections + tailoring
  -> report
  -> optional cover letter + customized resume DOCX (button only)
```

## Setup

```powershell
cd path/to/job-application-copilot
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
pip install -r copilot/requirements.txt
```

1. Set `ANTHROPIC_API_KEY` in repo root `.env`
2. Copy [`DOCS/copilot/profile.example.json`](../DOCS/copilot/profile.example.json) to `data/profile.json` (requires `target_locations` and `target_role_themes`)
3. Copy [`DOCS/copilot/Knowledge_Base.example.txt`](../DOCS/copilot/Knowledge_Base.example.txt) to `Knowledge_Base_Source.txt` at repo root (or paste your own KB; the real file is gitignored)

The last uploaded resume is saved under `copilot/.cache/` and restored automatically the next time you open the app. Upload a new file to replace it, or click **Remove** to clear it.

## Run

**Easiest:** double-click [`Job Copilot.vbs`](../Job%20Copilot.vbs) in the repo root. It creates the venv, installs dependencies, and opens the app in your browser.

Or from PowerShell:

```powershell
cd path/to/job-application-copilot
streamlit run copilot/app.py
```

Or run `copilot/launch_copilot.bat` directly.

## Tests

```powershell
python -m pytest copilot/tests -q
```

Manual smoke cases: [`DOCS/copilot/expected_outcomes.md`](../DOCS/copilot/expected_outcomes.md) and [`DOCS/copilot/samples/`](../DOCS/copilot/samples/).

## No-Fallback Design

| Situation | Behavior |
|-----------|----------|
| Missing resume or JD | Halt |
| Unparseable PDF | Halt |
| Location unknown in JD | Halt; user must confirm remote or provide location |
| Gov job without Duty Statement | Continue analysis without duty text |
| Missing profile fields | Error on load with path to example |
| LLM parse failure | Halt with error message |
| Do not apply | Full report still shown; resume and cover letter always available |

## Limitations (MVP)

- No job board integration, auto-apply, or persistent storage
- Cover letter rules are simplified vs a full production prompt library
- LangSmith tracing optional only
- Streamlit Cloud demo mode not yet implemented

## Future

- Streamlit Cloud deploy with demo mode (sample profile + sample JD)
- Job Board handoff (open worth-it jobs in browser)
