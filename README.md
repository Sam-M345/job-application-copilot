# Job Application Intelligence Copilot

Pre-apply decision support for job seekers: analyze a job description against your resume, run location and relevance gates, surface keyword gaps with evidence, and generate tailored application materials.

Built with **Streamlit**, **LangGraph**, **Anthropic Claude**, and **Chroma** (session-scoped evidence retrieval).

## What it does

1. Upload a resume + paste a job description
2. Run a gated LangGraph pipeline (location → relevance → evidence indexing → fit analysis)
3. Review scores, keyword gaps, objections, and tailoring recommendations
4. Optionally generate a **cover letter** and **customized resume DOCX** (1100+ words, clickable header links)

```text
Resume + JD + profile.json + knowledge base
  → parse → job type → location gate → relevance gate
  → index evidence (Chroma) → keyword gaps + fit + objections + tailoring
  → report → optional cover letter + customized resume DOCX
```

## Quick start

**Easiest:** double-click [`Job Copilot.vbs`](Job%20Copilot.vbs) in the repo root.

Or from PowerShell:

```powershell
cd path/to/job-application-intelligence-copilot
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r copilot/requirements.txt
copy DOCS\copilot\profile.example.json data\profile.json
copy DOCS\copilot\Knowledge_Base.example.txt Knowledge_Base_Source.txt
```

Create `.env` in the repo root:

```env
ANTHROPIC_API_KEY=your_key_here
ANTHROPIC_MODEL=claude-sonnet-4-6
```

Then run:

```powershell
streamlit run copilot/app.py
```

Full setup, architecture, and test notes: [`copilot/README.md`](copilot/README.md)

## Tech stack

| Layer | Tools |
|-------|--------|
| UI | Streamlit |
| Workflow | LangGraph |
| LLM | Anthropic Claude (`claude-sonnet-4-6`) |
| Validation | Pydantic v2 |
| Evidence | Chroma (in-memory, per session) |
| Export | python-docx (formatted resume) |

## Tests

```powershell
python -m pytest copilot/tests -q
```

Sample JDs and expected behaviors: [`DOCS/copilot/samples/`](DOCS/copilot/samples/) and [`DOCS/copilot/expected_outcomes.md`](DOCS/copilot/expected_outcomes.md)

## Repo layout (public)

| Path | Purpose |
|------|---------|
| [`copilot/`](copilot/) | Streamlit app, LangGraph pipeline, tests |
| [`DOCS/copilot/`](DOCS/copilot/) | Sample JDs, example profile/KB, formatting rules |
| [`Job Copilot.vbs`](Job%20Copilot.vbs) | Windows launcher |

**Not in this repo (local only):** real `data/profile.json`, `Knowledge_Base_Source.txt`, resumes, job boards, logs, archived scripts, tampermonkey userscripts, Phase 1 docs, and browser extensions. See [`.gitignore`](.gitignore).

## Documentation

| Doc | |
|-----|---|
| Copilot setup & design | [copilot/README.md](copilot/README.md) |
| Sample inputs | [DOCS/copilot/](DOCS/copilot/) |

## Phase 1 (local only)

Earlier Playwright apply automation (`src/`, `scripts/`) and internal docs stay on your machine and are excluded from the public tree via `.gitignore`. The portfolio focus is the Copilot in `copilot/`.
