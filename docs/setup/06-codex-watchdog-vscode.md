# 06. Codex Watchdog VSCode Setup

Path:

```text
modules/codex-watchdog-vscode
```

Purpose:

```text
VSCode/project watchdog prototype.
```

Current runtime direction:

```text
runner should act like a bounded autonomous executor,
not only a report writer.
```

The current watchdog runtime now leans on two structured contracts:

```text
agent/TASK_BOX.json
agent/ROUTE_CANONICAL.json
```

`TASK_BOX.json` can now carry research-contract fields such as:

```text
project_question
decision_relevance
claim_scope
forbidden_conclusions
fair_comparability
value_of_information
gate_policy
```

`ROUTE_CANONICAL.json` can now carry exact-successor fields such as:

```text
successor_contract_required
exact_next_task_id
exact_profile_path
exact_queue_draft_path
exact_next_object_path
```

Install/check:

```bash
cd "$CONTROL_PLANE_ROOT/modules/codex-watchdog-vscode"
npm install
node --check extension.js
```

Package locally if needed:

```bash
npm run package
```

This module is implementation tooling. It does not need to be exposed as an Agent Host workspace for ordinary Discord/Web tests.

Project watchdogs should live under project workspaces, for example:

```text
$PROJECT_ROOT/watchdog_demo_Grokking/agent/
```

Recommended project report protocol:

```text
agent/STATE.md
agent/PLAN.md
agent/TODO.md
agent/REPORT.md
agent/SAFETY.md
```

The main Codex workspace should read these reports rather than blindly scanning large logs.

Generated watchdog scripts also write:

```text
agent/status/generated_manifest.json
```

The generated runtime also uses these compact route/state artifacts:

```text
agent/TASK_BOX.json
agent/ROUTE_CANONICAL.json
agent/EVIDENCE_LEDGER.jsonl
project_index/document_index.jsonl
project_index/experiment_index.jsonl
project_index/current_conclusions.json
agent/status/NEXT_TASK_DRAFT.json
agent/status/SKILL_ROUTE.json
```

Projects may optionally add project-local support-skill routing:

```text
agent/SECONDARY_SKILLS.json
agent/schemas/secondary_skills.schema.json
agent/skills/project-secondary-example/SKILL.example.md
```

This does not replace the routed `primary_skill`. It lets the project attach bounded `secondary_skills` for cases such as a runner plus literature-triage helper, or a queue enqueue route plus queue-profile checker. The generated runtime validates the chain from route selection to final report:

```text
route_skill.py writes secondary_skills
wakeup prompt requires secondary_skills_consulted
render_report.py rejects mismatches
```

Run this inside a watchdog project after bootstrap or refresh:

```bash
./agent/bin/watchdog validate
./agent/bin/watchdog evidence-validate
./agent/bin/watchdog evidence-search --query "current conclusion" --json
```

`watchdog validate` now validates runtime JSON, the local evidence index under `project_index/`, and generated file hashes. Use `evidence-search` when the agent needs a metadata-first read plan before it opens large project files.

Preferred bootstrap flow in the VSCode control panel:

```text
Use / Create Project
-> Prepare Project
-> Bootstrap Conversation
-> Generate Drafts
-> Preview Changed Files
-> Instantiate Project
-> review PLAN/TODO/STATE/SAFETY/DAILY_HANDOFF
-> decide whether to Start Guard
```

The `Bootstrap Conversation` keeps the initialization dialog inside the panel and saves the transcript in the project:

```text
agent/status/bootstrap_conversation.json
agent/status/bootstrap_conversation.md
```

The panel also supports:

```text
Generate Drafts        continue the setup discussion inside the panel
Preview Changed Files   synthesize/open the latest candidate file-change preview
Instantiate Project    apply the current conversation draft to the five core handoff files
Reset Conversation      archive current setup transcript/artifacts and clear the panel
```

That makes the setup intent visible to later Codex sessions and to teammates who inherit the project.

The generated route/runtime layer can now do more than write broad reports:

- if a bounded task is missing research-contract structure, it can repair the task box locally instead of only complaining in prose;
- if a route decision requires an exact next task/profile/queue object, it can mark that through the canonical route contract;
- if the route says an exact successor is required but no explicit next object exists yet, the generated runtime can repair that gap locally and, in the narrow fallback case, synthesize a bounded successor draft.

This is the main shift from:

```text
observer / report writer
```

toward:

```text
bounded autonomous research executor
```
