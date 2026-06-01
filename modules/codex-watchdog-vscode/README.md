# Codex Watchdog VSCode Extension

This extension does not automate the Codex sidebar UI. It controls a Linux-side watcher that wakes `codex exec` on a timer, reads explicit project state, and writes structured reports.

Current local version: `0.1.41`.

Before a project root is selected, the control panel intentionally shows only the project selector. Folder status, login, schedule, actions, and reports appear only after the user explicitly selects or creates a project.

Expected source layout:

```text
package.json
extension.js
README.md
REVIEW_BRIEF.md
scripts/install-local.sh
scripts/package-local.js
scripts/package-local.sh
```

## Commands

- `Codex Watchdog: Bootstrap Project`
- `Codex Watchdog: Open Control Panel`
- `Codex Watchdog: Select Project Root`
- `Codex Watchdog: Create Demo Project Template`
- `Codex Watchdog: Prepare Project Template`
- `Codex Watchdog: Refresh Generated Watcher Files`
- `Codex Watchdog: Prepare Evening Handoff`
- `Codex Watchdog: Open Morning Brief`
- `Codex Watchdog: Start Guard`
- `Codex Watchdog: Pause Guard`
- `Codex Watchdog: Resume Guard`
- `Codex Watchdog: Stop Guard`
- `Codex Watchdog: Run Once Now`
- `Codex Watchdog: Run Once and Start Timer`
- `Codex Watchdog: Stop Timer`
- `Codex Watchdog: Show Timer Status`
- `Codex Watchdog: Open Latest Report`
- `Codex Watchdog: Accept Proposed State Update`

## Install Locally On The Remote Server

Run this from the extension folder:

```bash
bash scripts/install-local.sh
```

Then reload the VSCode Remote window and run commands from the Command Palette.

The extension also adds a VSCode status bar item. It shows `Watchdog: On`, `Watchdog: Off`, `Watchdog: Enabled`, or `Watchdog: No Project` for the selected project root; click it to open the control panel.
If `agent/control/PAUSE` exists, the status bar shows `Watchdog: Paused`; timer wakeups become deterministic paused reports and do not call Codex.

## First Use In A Project

You do not have to open the watched project as the VSCode workspace. You may keep a broad server folder open, then tell the extension which project folder it should control.

The easiest entry point is `Codex Watchdog: Open Control Panel`. The panel lets you:

- enter a project root path and create it if it does not exist, or browse for an existing folder;
- see whether the selected watcher `CODEX_HOME` is logged in;
- open a login terminal;
- edit the repeat interval and scheduled compaction cadence;
- refresh generated files, start the guard, pause/resume the guard, stop the guard, open the latest report, and open the morning brief.

The control panel uses distinct button styling for actions, so clickable controls should not read like plain text.

1. Run `Codex Watchdog: Open Control Panel`.
2. Enter the Linux project folder, then click `Use / Create Project`.
3. Click `Prepare Project`.
4. Tell daily Codex your real requirement and ask it to instantiate the watchdog task.
5. Click `Start Guard`.

If the folder path does not exist, `Use / Create Project` creates it directly from the path field and selects it. It does not also prepare the template; that remains the separate `Prepare Project` step. `Browse Existing` opens a real folder picker for already existing directories, using the typed path or its nearest existing parent as the starting point. If you type a new path into the project field, the panel hides the old project's login, timer, and latest report until you click `Use / Create Project` or choose a folder with `Browse Existing`.

`Prepare Project` creates the watchdog protocol and handoff files, including `agent/TASK_REQUEST.md`. This is the pause point where the user gives a plain-language requirement and daily Codex turns it into concrete watchdog files:

- `agent/PLAN.md`
- `agent/TODO.md`
- `agent/STATE.md`
- `agent/SAFETY.md`
- `agent/DAILY_HANDOFF.md`

`Start Guard` then performs the runtime startup path:

- checks that the task files no longer look like generic placeholders;
- refreshes generated project-local scripts, including `agent/bin/watchdog`;
- checks the selected watcher `CODEX_HOME` login and stops if login is not ready;
- runs one immediate wakeup;
- starts the repeating systemd user timer only if the immediate wakeup succeeds.

If the task still looks like a template, `Start Guard` stops and opens the instantiation files instead of silently starting a generic watcher.

The control panel highlights the recommended next action: `Prepare Project` is the primary button while the template/task is not ready; `Start Guard` becomes primary after the task is instantiated.

OpenAI login is the only manual authorization step. It is not per project. By default all watchdog projects share the watcher identity in `~/.codex-watcher`, so you only need to log in once for that `CODEX_HOME`. This is intentionally separate from your daily interactive Codex session, so unattended timer runs do not inherit whatever state your VSCode/chat session happens to have.

If login is not ready, the extension opens a terminal for:

```bash
./agent/bin/watchdog login
./agent/bin/watchdog status
```

After the browser/device login finishes, click `Start Guard` again. Normal startup does not offer a "continue anyway" path, because a timer without a working Codex login would fail later and be harder to diagnose.

If the panel says the Codex executable is missing, the problem is not login. The extension first tries `command -v codex`, then searches the OpenAI VSCode extension binary path such as `~/.vscode-server/extensions/openai.chatgpt-*/bin/linux-*/codex`.

After the first `Prepare Project`, task instantiation and later operations can be done by plain language through Codex. For example:

```text
请读取 agent/TASK_REQUEST.md 和 agent/CODEX_TAKEOVER.md。
根据我的需求，把这个文件夹实例化成 watchdog 任务。
填好 PLAN/TODO/STATE/SAFETY/DAILY_HANDOFF，但先不要启动 timer。
```

After that, Codex can start the guard when you ask. Codex should read `README.codex-watchdog.md` and `agent/CODEX_TAKEOVER.md`, or run:

```bash
./agent/bin/watchdog --help
```

Advanced commands remain available under `Advanced actions` in the control panel.

After a project root is selected, `Prepare Project`, `Start Guard`, `Stop Guard`, `Run Once`, `Run Once and Start Timer`, `Stop Timer`, `Show Timer Status`, `Open Morning Brief`, `Open Latest Report`, `Refresh Generated Watcher Files`, and `Accept Proposed State Update` all operate on that selected project root, not necessarily the currently opened VSCode workspace folder.

If you prefer a fixed path in settings, set:

```json
{
  "codexWatchdog.projectRoot": "/home/you/your_project"
}
```

The extension also reads `codexWatchdog.*` settings from `<selected project>/.vscode/settings.json`, so a selected project can carry its own `sandboxMode`, timer interval, timeout, Codex binary, Codex home, and service prefix even when VSCode is opened on a broader server folder. The project settings parser accepts common VSCode JSONC features, including `//` comments, `/* ... */` comments, and trailing commas.

Project-local settings are treated as untrusted input. A project-local `codexWatchdog.codexBin` may be `codex` or an allowed Codex path such as the VSCode OpenAI extension binary, `~/.local/bin/codex`, `/usr/bin/codex`, or `/usr/local/bin/codex`; arbitrary project-selected executables are refused, and configured binaries must be executable files named `codex`. Project-local `codexWatchdog.codexHome` must stay inside the current user's home and away from protected locations such as `~/.ssh`, `~/.config/systemd`, and VSCode extension folders. User/global `codexHome` settings may point outside `$HOME`, but still cannot target protected system or extension directories. These checks resolve real paths, so symlinks cannot point `codexHome` into a protected directory. `codexWatchdog.servicePrefix` is restricted to systemd-safe unit-name characters.

For security-sensitive fallback settings, the extension reads only user/global VSCode settings or package defaults. It intentionally ignores the currently opened broad workspace's merged settings for these fallback values, so an unrelated workspace cannot silently change the selected project's Codex binary or Codex home.

Saving the schedule from the control panel writes `codexWatchdog.intervalMinutes` and `codexWatchdog.compactEveryRuns` into `<selected project>/.vscode/settings.json`.

## Runner And Supervisor Roles

The watcher can run in two cooperation roles:

```json
{
  "codexWatchdog.role": "runner",
  "codexWatchdog.phaseOffsetMinutes": 10
}
```

`runner` is the default. It executes one bounded project-local work cycle and updates canonical handoff files.

`supervisor` is for audit and blocker triage. It reads runner handoff files, classifies stale/blocking states, prepares reviewer-pending work, and reduces repeated context. A supervisor must not become another project runner: it should not launch training, change model code, delete files, interrupt active runner work, or bypass external-service approval.

The supervisor now has deterministic runtime modes instead of a single long-standby behavior:

- `light`: runs after a newly completed runner report or a changed reviewer/blocker marker. It is only for small handoff repairs such as `pending_send`, stale marker cleanup, permission/allowlist notes, and blocker bookkeeping.
- `audit`: runs after `codexWatchdog.supervisorAuditEveryRunnerRuns` completed runner reports, default `4`, or when runner started/completed drift indicates repeated failed runner wakeups. It performs the heavier read-only health pass for leakage, anti-snowballing, stale state, environment drift, queue hygiene, and repeated blockers.
- `standby`: writes a short heartbeat when there is no new runner cycle and the audit cadence is not due.

The generated runner increments `agent/status/runner_run_count` when it wakes and writes `agent/status/runner_completed_count` only after rendering its report. The generated supervisor keys `light` and `audit` primarily from completed runner cycles. It writes a `selected` decision to `agent/status/supervisor_state.json` and `agent/status/SUPERVISOR_MODE.json` before Codex reasoning, then marks that decision `completed` or `failed` after `render_report.py` finishes. Failed supervisor runs do not advance `last_seen_runner_completed_count`, `last_light_runner_completed_count`, `last_audit_runner_completed_count`, or the actioned marker fingerprint.

Mode transitions are appended to `agent/status/SUPERVISOR_MODE.events.jsonl`. `agent/RUN_STATE.json` and the status snapshot include `runner_started_count`, `runner_completed_count`, and `runner_failure_drift`. Reviewer/blocker markers are fingerprinted, so the same unresolved marker does not retrigger `light` forever; it retriggers only when the marker changes, when a new runner completion lands, or when the heavy audit cadence is due. `agent/bin/route_skill.py` then routes `light` to the handoff writer skill, `audit` to the cleanup auditor skill, and `standby` to a short heartbeat. Configure the behavior with:

```json
{
  "codexWatchdog.role": "supervisor",
  "codexWatchdog.supervisorLightFollowup": true,
  "codexWatchdog.supervisorAuditEveryRunnerRuns": 4
}
```

Use `codexWatchdog.phaseOffsetMinutes` to stagger systemd timer starts across multiple runner/supervisor watchdogs. The generated timer uses this value for its first active delay, while `codexWatchdog.intervalMinutes` controls the repeat cadence.

Bootstrap/refresh now also creates the runner-supervisor cooperation files:

```text
agent/WATCHDOG_PROTOCOL.md
agent/CURRENT_STATE.md
agent/RUN_STATE.json
agent/NEXT_ACTION.md
agent/BLOCKERS.md
agent/REVIEW_PENDING.md
agent/ANTI_SNOWBALL.md
agent/EXPERIMENT_LEDGER.md
```

These files are the preferred coordination surface for supervisor watchdogs. They are intentionally compact so a supervisor can repair blockers and stale state without rereading long reports or raw logs.

Reports appear under `agent/reports/`, with `agent/reports/latest.md` pointing at the newest report. Each later wakeup reads the daily handoff, compact runtime state, bounded previews of proposed state / morning brief / latest report, and recent log metadata so the watcher has continuity without letting prompt context snowball.

Bootstrap also creates `README.codex-watchdog.md` in the selected project root if it is missing. This file explains the watchdog protocol, initial setup checklist, wakeup flow, safety boundary, daily-mode handoff, and project-local startup commands. It intentionally does not overwrite a project-owned `README.md`.

Bootstrap also creates `agent/TASK_REQUEST.md`, `agent/watchdog.env`, `agent/CODEX_TAKEOVER.md`, `agent/bin/watchdog`, `agent/bin/watchdog_guard.sh`, and `agent/bin/watchdog_timer.sh`, so Codex can instantiate and take over the watcher from plain-language user instructions without reading this extension source:

```bash
./agent/bin/watchdog --help
./agent/bin/watchdog run-once        # one immediate wakeup with login/layout checks
./agent/bin/watchdog start           # check login, run once, then start timer
./agent/bin/watchdog status
./agent/bin/watchdog queue           # compact queue dashboard, no raw log tails by default
./agent/bin/watchdog route           # recompute deterministic primary skill route
./agent/bin/watchdog validate        # validate compact runtime JSON and queue files
./agent/bin/watchdog pause           # create agent/control/PAUSE; future wakeups do not call Codex
./agent/bin/watchdog resume          # remove agent/control/PAUSE
./agent/bin/watchdog stop
```

`agent/watchdog.env` is generated from the same validated settings used by the VSCode control panel. The project-local CLI scripts source it first, then let explicit environment variables override it. This keeps `Start Guard` from VSCode and `./agent/bin/watchdog start` from Codex pointed at the same `CODEX_HOME`, Codex binary, interval, timeout, compaction cadence, sandbox mode, and systemd service prefix.

Bootstrap and refresh also create a project-local skills layer:

```text
agent/SKILL_ROUTER.md
agent/skills/watchdog-orchestrator/SKILL.md
agent/skills/watchdog-job-queue/SKILL.md
agent/skills/watchdog-gate-evaluator/SKILL.md
agent/skills/watchdog-report-curator/SKILL.md
agent/skills/watchdog-permission-guardian/SKILL.md
agent/skills/watchdog-handoff-writer/SKILL.md
agent/skills/watchdog-cleanup-auditor/SKILL.md
```

Every wakeup must select exactly one `primary_skill` from that set and include the route reason, stop condition, and permission-guardian result in the structured JSON output. This makes watchdog behavior more like a finite runtime than a free-form recurring chat.

Bootstrap and refresh also create the first v0.2 runtime substrate:

```text
agent/control/PAUSE                  deterministic pause flag
agent/STATE.json                     machine-readable compact state scaffold
agent/PROGRESS_STATE.json            last progress/no-progress/recommend-pause record
agent/status/SKILL_ROUTE.json        deterministic primary-skill route
agent/status/RUNTIME_VALIDATION.json runtime validation result
agent/status/QUEUE_STATUS.md         compact queue dashboard, no raw log tails
agent/status/generated_manifest.json generated file template hashes for drift checks
agent/schemas/state.schema.json
agent/schemas/job.schema.json
agent/schemas/gate.schema.json
research/RESEARCH_LEDGER.md
research/LEDGER_NOTES.md
research/proposals/
```

Before Codex starts, `agent/bin/route_skill.py` first writes or refreshes `agent/status/SKILL_ROUTE.json`; then `agent/bin/validate_runtime.py` validates compact runtime files, queue files, gate files, and the freshly routed skill file. The project-local `./agent/bin/watchdog validate` command also checks `agent/status/generated_manifest.json`, which records SHA-256 hashes for generated scripts, schemas, prompts, and skills. If a generated file drifts from the recorded template, validation fails and asks you to refresh generated watcher files. The manifest is public-repo safe: it records relative paths and template hashes, not local machine paths; public docs should use `$PROJECT_ROOT`, `$CONTROL_PLANE_ROOT`, and `$COLLAB_ROOT` placeholders instead of real private paths. The prompt tells Codex to follow that deterministic route, and `render_report.py` rejects output whose `primary_skill` does not match the routed skill. The generated JSON schema also requires each wakeup to classify `report_type`, indicate whether progress changed, track `no_progress_cycles`, and set `recommend_pause` when repeated no-progress or repeated blockers need a human decision. `render_report.py` refreshes `agent/PROGRESS_STATE.json`, can update a complete `research/RESEARCH_LEDGER.md`, and writes review proposals under `research/proposals/`.

If you already bootstrapped a project with an older extension version, run `Codex Watchdog: Refresh Generated Watcher Files`. It overwrites generated protocol files (`README.codex-watchdog.md`, `agent/watchdog.env`, `agent/CODEX_TAKEOVER.md`, `agent/SKILL_ROUTER.md`, `agent/skills/`, `agent/bin/`, `agent/prompts/wakeup.md`, and generated schemas under `agent/schemas/`) and refreshes `agent/status/generated_manifest.json`; it leaves `TASK_REQUEST.md`, `PLAN.md`, `STATE.md`, `TODO.md`, `SAFETY.md`, `DAILY_HANDOFF.md`, and `AGENTS.md` untouched. It creates missing runtime scaffolding such as `agent/STATE.json`, `agent/PROGRESS_STATE.json`, `agent/status/QUEUE_STATUS.md`, and `research/` files without overwriting user-owned daily-mode Markdown.

The same refresh action is now visible in the main control-panel action row as `Refresh Generated Files`; it is no longer only inside the advanced section.

`agent/STATE.proposed.md`, `agent/RUNTIME_STATE.md`, and `agent/MORNING_BRIEF.md` are intentionally separate. `STATE.proposed.md` is the full candidate state for human review. `RUNTIME_STATE.md` is a compact handoff note for the next scheduled wakeup. `MORNING_BRIEF.md` is for daily mode to read when you return. Review-required pending JSON filenames are sanitized before writing, even if the model outputs a strange timestamp.

The generated runner also keeps `agent/status/run_count`. Every `codexWatchdog.compactEveryRuns` runs, the snapshot marks the wakeup as a scheduled curation cycle. During that cycle, the prompt tells Codex to use report-curator behavior: keep `RUNTIME_STATE.md`, `MORNING_BRIEF.md`, and the phase report short; remove repeated history; and reference old reports by path instead of copying them. Set `compactEveryRuns` to `0` to disable scheduled curation.

## Daily / Watchdog Handoff

Daily mode owns these files:

```text
agent/PLAN.md
agent/TODO.md
agent/STATE.md
agent/SAFETY.md
agent/DAILY_HANDOFF.md
```

Watchdog mode owns these outputs:

```text
agent/RUNTIME_STATE.md
agent/MORNING_BRIEF.md
agent/status/
agent/reports/
agent/logs/
agent/pending/
```

Before leaving work, make sure the task has already been instantiated. Then run `Codex Watchdog: Prepare Evening Handoff`, fill in `agent/DAILY_HANDOFF.md`, and run `Codex Watchdog: Start Guard`.

When you return, run `Codex Watchdog: Open Morning Brief`. It opens `agent/MORNING_BRIEF.md`, `agent/reports/latest.md`, and `agent/RUNTIME_STATE.md` when available.

For a first test, you can simply run `Codex Watchdog: Create Demo Project Template` or choose the demo action for an empty folder. The command creates a demo `README.md`, `logs/train.log`, filled watchdog `PLAN/TODO/STATE/SAFETY/DAILY_HANDOFF` files, and a machine-readable `agent/STATE.json` pending report-only task for `exp_demo_001`. It also remembers that folder as the selected project root, so you can run `Codex Watchdog: Run Once Now` without changing the VSCode workspace.

## Safety Shape

The generated watcher runs:

```bash
codex --ask-for-approval never exec --sandbox read-only --output-schema agent/schemas/watch_decision.schema.json
```

It also exports `CUDA_VISIBLE_DEVICES=""`, uses `flock` to avoid overlapping runs, writes proposed state changes to `agent/STATE.proposed.md`, increments `agent/status/run_count`, and refreshes `agent/RUNTIME_STATE.md` and `agent/MORNING_BRIEF.md` instead of directly mutating daily-mode files.

By default, watchdog mode remains read-only. A workspace-write coding probe now has a deterministic gate: `agent/workspace_write_policy.json` must exist, must be valid JSON, and must contain `enabled: true`, nonempty relative `writable_paths`, and nonempty `allowed_commands`. If that machine-readable policy is missing or invalid, the extension and generated scripts force `workspace-write` back to `read-only` before running Codex.

Bootstrap creates `agent/workspace_write_policy.example.json` as documentation only. To opt into an isolated demo probe, copy it to `agent/workspace_write_policy.json`, edit it deliberately, and also document the probe in `agent/SAFETY.md` so the model prompt and deterministic runner agree. This is still not a full safe executor; it only prevents accidental unattended `workspace-write` when no explicit policy exists.

If Codex exits successfully but the JSON cannot be rendered, the generated watcher writes a `Codex Watchdog Render Failure` report and updates `agent/reports/latest.md` to point at it.

If status collection fails before Codex starts, the generated watcher writes a `Codex Watchdog Collect Status Failure` report and updates `agent/reports/latest.md` to point at it. Missing `runs/`, `logs/`, or `outputs/` directories are handled as an empty log set, not as a fatal error.

If prompt construction fails after status collection, the generated watcher writes a `Codex Watchdog Prompt Build Failure` report and updates `agent/reports/latest.md`. Prompt stderr is saved in the report, and the partial prompt is saved as `agent/reports/<timestamp>.prompt.md` for diagnosis.

The extension refreshes generated scripts before `Start Guard`, `Run Once`, and `Run Once and Start Timer`, so old bootstrapped projects do not accidentally run stale watcher scripts.

Generated snapshots omit raw log tails by default and list recent logs by path, size, and modification time. Set `WATCHDOG_INCLUDE_LOG_TAILS=1` only for short debugging sessions where log tails are needed inside `agent/status/current.md`.

The control panel webview uses a Content Security Policy with a per-render script nonce.

The control panel previews only the first 64 KiB of `agent/reports/latest.md`, so an unusually large report cannot make the panel read the entire file into memory.

The generated systemd service includes light hardening:

```ini
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
```

Generated `WorkingDirectory=` paths are written in systemd path syntax, not shell-quoted form, so user timers can start on systemd versions that reject quoted paths there.

The generated watcher prepends `~/.local/bin` to `PATH` before invoking Codex. This lets a user-local `bwrap` binary satisfy Codex sandbox requirements on systems where `sudo apt install bubblewrap` is not available.

The VSCode extension is a control surface. The durable schedule lives in `systemd --user`, so it can keep running after your VSCode UI disconnects if your user services are allowed to linger.

```bash
loginctl enable-linger "$USER"
```
