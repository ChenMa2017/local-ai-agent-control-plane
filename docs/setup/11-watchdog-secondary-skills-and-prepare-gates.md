# 11. Watchdog Secondary Skills And Prepare Gates

This note covers two related additions:

```text
1. project-local secondary skill routing in generated watchdog projects
2. prepare-time experiment decision gates in Agent Host
```

They solve different halves of the same problem:

```text
secondary skills:
  make one watchdog wakeup more capable without losing a single route truth

decision gates:
  stop vague or expensive experiment requests before they become bad execution tasks
```

## A. Secondary Skills

Generated watchdog projects still route around one authoritative `primary_skill`, but they may now attach bounded support skills through:

```text
agent/SECONDARY_SKILLS.json
```

Companion files:

```text
agent/schemas/secondary_skills.schema.json
agent/skills/project-secondary-example/SKILL.example.md
```

Runtime flow:

```text
route_skill.py
  -> selects primary_skill
  -> optionally selects secondary_skills
  -> writes agent/status/SKILL_ROUTE.json

wakeup prompt
  -> reads primary skill first
  -> reads routed secondary skills after that

render_report.py
  -> validates primary_skill_used
  -> validates secondary_skills_consulted
```

Typical selectors:

```text
primary_skills
roles
supervisor_modes
task_capabilities
```

Use this when a project needs narrow local helpers such as:

```text
literature triage
queue profile checking
state reconciliation
project-specific experiment-note normalization
```

Do not use it to create a second hidden route authority. `ROUTE_CANONICAL.json` and `SKILL_ROUTE.json` remain the source of truth.

## B. Prepare-Time Experiment Decision Gate

`POST /codex/prepare` and `/agent_prepare` can now stop unclear experiment requests before they turn into execution tasks.

Persisted artifacts may include:

```text
INTENT_DRAFT
GRAY_AREAS
QUESTIONS
TASK_CONTRACT
TASKBOX_DRAFT
POLICY_PREFLIGHT
DECISION_GATE
```

The decision gate is for prompts that sound like:

```text
please run a training comparison
please try a GPU experiment
please verify whether method A is better than method B
please prove this model improvement claim
```

The gate forces clarification of missing items such as:

```text
control definition
success criterion
fairness constraint
metric goal
```

This keeps the system from doing the wrong thing quickly.

## C. Recommended Operator Flow

Use this order:

```text
1. /agent_prepare
2. answer clarification questions if any
3. confirm TASK_CONTRACT / DECISION_GATE look right
4. /agent_run only after the gate is resolved
```

For watchdog projects:

```text
1. bootstrap project
2. keep route truth in TASK_BOX.json + ROUTE_CANONICAL.json
3. add SECONDARY_SKILLS.json only if the project really needs bounded support skills
4. validate with ./agent/bin/watchdog validate
```

## D. Safety Intent

These two features push in the same direction:

```text
make the system more capable
without making routing or approval looser
```

Secondary skills increase local competence inside a bounded wakeup.
Decision gates increase intake quality before execution starts.
