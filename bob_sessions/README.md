# bob_sessions/

Hackathon submission: PNG screenshots of **task session consumption summaries** from Bob IDE (Tasks → open task header). Not full chat exports.

**Naming:** `{teamname}_task{nn}_{short_description}.png`  
Team id from Bob settings: `bob-001` → prefix `bob001`.

| File | Bob task | What the header shows |
|------|----------|------------------------|
| `bob001_task01_implementation_plan.png` | Long plan/implement session (“I am starting to work…”) | Expanded header: Context %, Task Id, Workspace, Bobcoins |
| `bob001_task02_st3_git_workspace.png` | ST3 — Git workspace + diff parser | Tokens + cost in task header |
| `bob001_task03_st5_st6_analyzer_api.png` | ST5+ST6 — Analyzer + GitHub adapter | Completed 10/10; tokens + cost |
| `bob001_task04_st7_demo_data.png` | ST7 — Demo data generation (#10295) | Tokens + cost in task header |
| `bob001_task05_parallel_subagents.png` | Same plan session — parallel subagents | Per-subagent tools / tokens / $ / duration |
| `bob001_task06_budget_exceeded.png` | Mid ST5 — budget wall | 158.4k tokens, ~40 Bobcoins, “Budget Exceeded” |
| `bob001_task07_st1_st6_complete.png` | Late plan session after ST1–ST6b | High burn ($87.47), todo 22/25 |
| `bob001_task08_create_plan_skill.png` | Start of plan session | create-plan skill + early consumption header |

Source dumps (unfiltered) live in `data/for-bob/` and are **not** part of the submission set.
