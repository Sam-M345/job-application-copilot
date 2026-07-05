# Sample evaluation fixtures for manual smoke testing.
# Run via: streamlit run copilot/app.py

## Case 1 — Remote applied AI (expect: pass location, Strong apply or Apply with tailoring)

**JD:** See `remote_applied_ai_jd.txt`
**Resume:** See `sample_resume.txt`

## Case 2 — On-site Austin TX (expect: halt at location gate)

**JD:** See `austin_onsite_jd.txt`

## Case 3 — Irrelevant backend-only (expect: halt at relevance gate)

**JD:** See `backend_only_jd.txt`

## Case 4 — CA gov with Duty Statement (expect: pass doc gate, full analysis)

**JD:** See `ca_gov_jd.txt`
**Duty:** See `sample_duty_statement.txt`

## Case 5 — CA gov without Duty Statement (expect: pass doc gate, analysis without duty text)

**JD:** See `ca_gov_jd.txt`
**Duty:** leave empty

## Case 6 — Keyword in KB not resume (expect: gap with KB evidence)

**JD:** See `remote_applied_ai_jd.txt`
**Resume:** minimal resume without LangGraph
**KB override:** mention LangGraph project in sidebar
