# Codex Watchdog Review Brief

Reviewed source version: `0.1.39`.

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

## Goal

This VSCode Remote extension is a control surface for a Linux-server-side scheduled Codex watcher.

It intentionally does not automate the Codex sidebar, paste text into the chat UI, or read the sidebar DOM. Instead, it creates project-local watcher files and controls a `systemd --user` timer that periodically runs `codex exec`.

## Main Flow

1. User opens any convenient Linux folder through VSCode Remote; it can be a broad server workspace.
2. User runs `Codex Watchdog: Open Control Panel`, enters/browses for the watched project root, and can check login status, edit repeat interval, start guard, stop guard, and open reports from that panel.
   - Before a project root is selected, the panel shows only the project selector and hides default status, login, schedule, actions, timer state, and latest-report content.
3. User may also run `Codex Watchdog: Select Project Root` or choose a project folder during bootstrap/demo creation. Path selection uses a plain path input and can create a missing folder after confirmation, rather than relying on the VSCode folder picker.
   - Selecting a path only selects or creates the folder. Template generation remains an explicit `Prepare Project` or `Create Demo Project Template` step, so choosing a folder does not unexpectedly write project files.
4. The extension creates:
   - `README.codex-watchdog.md`
   - `agent/CODEX_TAKEOVER.md`
   - `agent/TASK_REQUEST.md`
   - `agent/PLAN.md`
   - `agent/STATE.md`
   - `agent/STATE.json`
   - `agent/PROGRESS_STATE.json`
   - `agent/RUNTIME_STATE.md`
   - `agent/DAILY_HANDOFF.md`
   - `agent/MORNING_BRIEF.md`
   - `agent/SAFETY.md`
   - `agent/control/`
   - `agent/watchdog.env`
   - `agent/workspace_write_policy.example.json`
   - `agent/status/QUEUE_STATUS.md`
   - `agent/SKILL_ROUTER.md`
   - `agent/skills/watchdog-orchestrator/SKILL.md`
   - `agent/skills/watchdog-job-queue/SKILL.md`
   - `agent/skills/watchdog-gate-evaluator/SKILL.md`
   - `agent/skills/watchdog-report-curator/SKILL.md`
   - `agent/skills/watchdog-permission-guardian/SKILL.md`
   - `agent/skills/watchdog-handoff-writer/SKILL.md`
   - `agent/skills/watchdog-cleanup-auditor/SKILL.md`
   - `agent/TODO.md`
   - `agent/prompts/wakeup.md`
   - `agent/schemas/watch_decision.schema.json`
   - `agent/schemas/state.schema.json`
   - `agent/schemas/job.schema.json`
   - `agent/schemas/gate.schema.json`
   - `agent/bin/collect_status.sh`
   - `agent/bin/make_prompt.sh`
   - `agent/bin/run_watchdog.sh`
   - `agent/bin/watchdog`
   - `agent/bin/watchdog_timer.sh`
   - `agent/bin/watchdog_guard.sh`
   - `agent/bin/render_report.py`
   - `agent/bin/route_skill.py`
   - `agent/bin/validate_runtime.py`
   - `research/RESEARCH_LEDGER.md`
   - `research/LEDGER_NOTES.md`
   - `research/proposals/`
5. User clicks `Prepare Project` or runs `Codex Watchdog: Prepare Project Template`; this creates protocol files but does not start the timer.
6. Daily Codex mode instantiates the user's plain-language requirement by rewriting `TASK_REQUEST.md`, `PLAN.md`, `TODO.md`, `STATE.md`, `SAFETY.md`, and `DAILY_HANDOFF.md` into a concrete unattended task.
7. User checks the control panel login status for the selected watcher `CODEX_HOME`.
8. User runs `Codex Watchdog: Start Guard` or clicks `Start Guard` in the control panel.
9. `Start Guard` refreshes generated scripts, checks that the task files do not still look like generic placeholders, checks login, runs one immediate wakeup through `agent/bin/watchdog start`, and starts the timer only if that wakeup succeeds.
   - If the watcher `CODEX_HOME` is not logged in, startup blocks, opens a login terminal on request, and asks the user to rerun `Start Guard` after login.
9. The extension writes a per-project user service/timer under `~/.config/systemd/user/`.
10. Every interval, systemd executes `agent/bin/run_watchdog.sh`.
11. `run_watchdog.sh` runs:

```bash
codex --ask-for-approval never exec \
  --cd "$PROJECT_ROOT" \
  --skip-git-repo-check \
  --sandbox "$CODEX_SANDBOX_MODE" \
  --output-schema agent/schemas/watch_decision.schema.json \
  --output-last-message "$JSON_OUT" \
  --json \
  -
```

Note: with the bundled `codex-cli 0.130.0-alpha.5`, approval policy is a top-level Codex option. The generated script calls `codex --ask-for-approval never exec ...`, not `codex exec --ask-for-approval never ...`.

## Default Safety Posture

- Default sandbox: `read-only`
- Default approval policy: `never`
- Watcher environment: `CUDA_VISIBLE_DEVICES=""`
- Separate Codex home: `~/.codex-watcher`
- Overlap prevention: `flock` on `agent/.watchdog.lock`
- Output is structured JSON plus Markdown report
- Proposed state updates go to `agent/STATE.proposed.md`, not directly to `agent/STATE.md`
- Low-risk continuity memory is refreshed in `agent/RUNTIME_STATE.md` from the separate `runtime_state_markdown` schema field
- Morning handoff is refreshed in `agent/MORNING_BRIEF.md` from the separate `morning_brief_markdown` schema field
- Each snapshot includes `agent/DAILY_HANDOFF.md`, compact `agent/RUNTIME_STATE.md`, bounded previews of `agent/STATE.proposed.md`, `agent/MORNING_BRIEF.md`, and `agent/reports/latest.md`, plus recent log metadata when present
- Generated snapshots omit raw log tails by default; `WATCHDOG_INCLUDE_LOG_TAILS=1` is an explicit debugging override
- Generated `run_watchdog.sh` increments `agent/status/run_count` and marks every `codexWatchdog.compactEveryRuns` cycle as a report-curation/compaction cycle
- The wakeup prompt tells Codex to keep `RUNTIME_STATE.md`, `MORNING_BRIEF.md`, and phase reports short on curation cycles, reference old reports by path, and avoid copying historical text
- The generated skills layer requires each wakeup to choose exactly one `primary_skill`, report the route reason, report the stop condition, and report the permission-guardian outcome in schema output
- `watchdog-permission-guardian` is treated as a mandatory gate before any action that writes, queues, executes, archives, or changes mechanism configuration
- `agent/bin/route_skill.py` writes or refreshes `agent/status/SKILL_ROUTE.json` before validation and before Codex starts, selecting the deterministic primary skill from pause/control files, compaction status, queue state, completed results, review flags, and pending tasks
- `agent/bin/validate_runtime.py` runs after routing, writes `agent/status/RUNTIME_VALIDATION.json`, and blocks Codex startup when compact runtime JSON, route JSON, or queue job JSON is malformed
- `render_report.py` rejects Codex output whose `primary_skill` does not match `agent/status/SKILL_ROUTE.json`
- `agent/control/PAUSE` is a deterministic runtime control: if present, `run_watchdog.sh` writes a paused report, updates `agent/reports/latest.md`, and exits without calling Codex
- `agent/PROGRESS_STATE.json` records report type, progress/no-progress cycles, pause recommendation, primary skill, review status, blocker, and next safe action after each successful render
- `agent/status/QUEUE_STATUS.md` is refreshed by the collector as a compact dashboard of queue counts and queue file metadata; it intentionally omits raw log tails
- `research/RESEARCH_LEDGER.md` is updated only when Codex returns a complete ledger document beginning with `# Research Ledger`; otherwise uncertain fragments go to `research/LEDGER_NOTES.md`
- `research/proposals/` receives concise approval proposals when Codex marks blocked work that needs human review
- Generated systemd service includes `NoNewPrivileges=yes`, `PrivateTmp=yes`, and `ProtectSystem=full`
- Missing `runs/`, `logs/`, or `outputs/` directories are reported as no log roots instead of failing the collector
- If `collect_status.sh` fails before Codex starts, `run_watchdog.sh` writes a collect failure report and updates `agent/reports/latest.md`
- If `make_prompt.sh` fails before Codex starts, `run_watchdog.sh` writes a prompt build failure report with prompt stderr and a partial prompt preview, then updates `agent/reports/latest.md`
- Workspace-write coding probes are opt-in only: `agent/workspace_write_policy.json` must be valid machine-readable policy with `enabled: true`, nonempty relative writable paths, and nonempty allowed commands; otherwise the extension and generated scripts force `workspace-write` back to `read-only`
- If `render_report.py` fails after a successful Codex run, `run_watchdog.sh` writes a render failure report and updates `agent/reports/latest.md`
- `scripts/install-local.sh` reads `name`, `version`, and `publisher` from `package.json` and installs into `${publisher}.${name}-${version}`
- `Run Once`, timer, report, handoff, status, refresh, and accept-state commands use the configured/remembered project root instead of forcing the current VSCode workspace folder to be the watched project
- Per-project settings are read from `<selected project>/.vscode/settings.json` so project-local `sandboxMode`, timeout, interval, Codex home, Codex binary, and service prefix still apply when VSCode is opened on a broader server folder
- Project-local settings accept common VSCode JSONC syntax, including comments and trailing commas
- Security-sensitive fallback settings are read from user/global VSCode settings or package defaults, not from the currently opened broad workspace's merged settings
- Project-local `codexWatchdog.codexBin` is constrained to `codex` or known Codex executable locations; arbitrary project-selected executable paths are refused
- Configured Codex binary paths must point to executable files named `codex`; VSCode extension binaries are limited to OpenAI extension paths like `openai.chatgpt-*/bin/linux-*/codex`
- Project-local `codexWatchdog.codexHome` must be an absolute or `~/` path inside the current user's home and away from protected locations such as `~/.ssh`, `~/.config/systemd`, and VSCode extension folders; realpath checks prevent symlink escape into those protected paths
- User/global `codexWatchdog.codexHome` may point outside `$HOME`, but still cannot target protected system or extension paths
- `codexWatchdog.servicePrefix` and generated service/timer names are validated before writing systemd unit files
- Project root paths are required to be existing directories and are rejected if they contain control characters or `%`, which would be fragile inside generated systemd unit files
- `codexWatchdog.intervalMinutes`, `codexWatchdog.timeoutMinutes`, and `codexWatchdog.compactEveryRuns` are normalized before use, with invalid project-local values falling back to safe defaults
- `Select Project Root` selects or creates a folder only; initialization is explicit through `Prepare Project` or `Create Demo Project Template`
- `Open Control Panel` provides a webview control surface for project root, Codex login status, repeat interval, compaction cadence, timer status, run once, start, stop, refresh generated files, and latest report preview
- The control panel supports both direct path entry/create and `Browse Existing` folder selection; browse starts at the typed path or nearest existing parent
- `Use / Create Project` creates a missing folder directly from the path field, selects it, and leaves template generation to the explicit `Prepare Project` step
- When the user types a project path different from the currently selected root, the control panel hides the selected project's login/timer/latest-report sections until the user clicks `Use / Create Project` or chooses a folder with `Browse Existing`, reducing stale-project confusion
- `Refresh Generated Files` is visible in the main action row, not only in advanced actions
- `Prepare Project` is the setup workflow: it creates project-local protocol files and opens task-instantiation documents without starting the timer
- The control panel highlights `Prepare Project` while the template/task is not ready, then highlights `Start Guard` after the task is instantiated
- `Start Guard` is the runtime workflow: it refreshes generated protocol files, blocks if task files still look like placeholders, checks login, runs one immediate wakeup, and starts the repeating timer only after the wakeup succeeds
- `Stop Guard` is the primary stop workflow and delegates to the project-local watchdog CLI when available
- A VSCode status bar item activates on startup, shows the selected project's watchdog timer state (`On`, `Off`, `Enabled`, or `No Project`), and opens the control panel when clicked
- The control panel styles action buttons as compact controls with borders, filled states, focus rings, and separated destructive action styling instead of plain text-like labels
- Bootstrap creates `README.codex-watchdog.md` in the selected root when missing, so Codex and humans have a stable project-local guide to the watchdog protocol without overwriting the project's own `README.md`
- Refresh updates `README.codex-watchdog.md` and `agent/CODEX_TAKEOVER.md` as generated watchdog protocol docs, so older selected projects learn the current login/startup flow without changing user-owned plan/state/safety files
- Bootstrap creates `agent/bin/watchdog_timer.sh`, a project-local systemd helper with `install`, `start`, `stop`, `status`, and `units` actions, so a Codex instance can start or inspect the watcher from the project root without reading extension source
- Bootstrap creates `agent/CODEX_TAKEOVER.md` and `agent/bin/watchdog_guard.sh`, so daily Codex mode can respond to plain-language requests like "启动看护员" by checking layout/login, running one immediate wakeup, starting the repeating timer, and reporting status
- Bootstrap creates `agent/bin/watchdog`, a project-local CLI with `--help` and aliases for start/status/stop/run-once/login/latest/timer actions, so Codex can discover usage without plugin source or VSCode UI access
- The project-local CLI also exposes `pause`, `resume`, `queue`, `route`, and `validate`, so daily Codex can pause/resume unattended wakeups, inspect compact queue state, recompute the skill route, and validate runtime state by plain-language request
- Bootstrap and refresh create `agent/watchdog.env` from the same validated settings used by the VSCode control panel; project-local helper scripts source it first and then let explicit environment variables override it
- `Run Once`, `Run Once and Start Timer`, and `Start Guard` refresh generated scripts, check `codex login status` with the selected watcher `CODEX_HOME` before starting, and stop instead of continuing when login is missing
- Extension-side login detection matches the project-local guard script by accepting `logged in` or `authenticated`
- Extension-side Codex binary resolution now mirrors the project-local guard fallback: if `command -v codex` fails, it searches `~/.vscode-server/extensions/openai.chatgpt-*/bin/linux-*/codex` and `~/.vscode/extensions/openai.chatgpt-*/bin/linux-*/codex`
- Login diagnostics distinguish a missing Codex executable from a not-logged-in watcher `CODEX_HOME`
- `render_report.py` sanitizes model-provided `timestamp_utc` before using it as a pending-review filename
- Stop commands inspect the resulting timer state and warn instead of always claiming the guard/timer stopped
- The control panel webview includes a Content Security Policy and per-render script nonce
- Local installer and packer validate package metadata before composing extension destination/archive names
- Generated systemd services write `WorkingDirectory=` as a raw systemd path value, not a shell-quoted string, because quoted paths are rejected by some user systemd versions as non-absolute
- Generated `run_watchdog.sh` prepends `~/.local/bin` to `PATH` so a user-local `bwrap` can satisfy Codex sandbox command execution on systems without a system `bubblewrap` package
- `ensureCodexHome()` writes `[features].hooks = true` and migrates the deprecated `[features].codex_hooks = true` key when it sees an existing watcher config
- Generated `run_watchdog.sh` sanitizes `WATCHDOG_TIMEOUT_MINUTES` even when called directly outside VSCode
- The control panel reads only the first 64 KiB of `agent/reports/latest.md` for preview

## Extension Commands

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

## Configuration

- `codexWatchdog.intervalMinutes`
- `codexWatchdog.projectRoot`
- `codexWatchdog.timeoutMinutes`
- `codexWatchdog.codexBin`
- `codexWatchdog.codexHome`
- `codexWatchdog.sandboxMode`
- `codexWatchdog.servicePrefix`

## Review Focus

Please review:

1. Whether `extension.js` writes only expected project files and systemd user unit files.
2. Whether generated shell scripts avoid destructive operations.
3. Whether `run_watchdog.sh` actually invokes `codex exec` on a timer rather than saving prompts.
4. Whether the default `read-only` sandbox and `CUDA_VISIBLE_DEVICES=""` are appropriate.
5. Whether the deterministic `workspace-write` gate in `agent/workspace_write_policy.json` is strict enough before allowing isolated demo coding probes.
6. Whether the generated prompt is explicit enough that each timer event should be treated as a real work cycle.
7. Whether `RUNTIME_STATE.md` is an acceptable low-risk continuity file while `STATE.md` remains human-approved.
8. Whether `Refresh Generated Watcher Files` overwrites only generated files and leaves user-owned daily-mode files untouched.
9. Whether render failure handling gives enough information without leaking excessive log content.
10. Whether the source package preserves the expected file names and contents listed above.
11. Whether the daily/watchdog ownership boundary is clear enough: daily mode owns plan/state/safety/handoff, while watchdog mode owns runtime/morning/report/pending outputs.
12. Whether collector failure handling is robust enough that pre-Codex failures are visible in `agent/reports/latest.md`.
13. Whether folder-picker bootstrap uses the selected target root consistently and never falls back to the current workspace while writing files.
14. Whether `Create Demo Project Template` writes only a minimal demo project and does not overwrite existing daily-mode files.
15. Whether prompt-build failure handling gives enough information for morning diagnosis, including `make_prompt.sh` stderr.
16. Whether the workspace-write coding probe exception is narrow enough for isolated demos and still rejects ordinary code changes by default.
17. Whether remembered/configured project-root behavior is clear and avoids accidentally running a timer against the wrong folder while the user has a broader server workspace open.
18. Whether reading `<selected project>/.vscode/settings.json` for project-local watcher settings is the right precedence model.
19. Whether the small JSONC parser is sufficient for typical VSCode settings without adding an external dependency.
20. Whether selecting/creating a project root without immediately initializing it matches the intended user flow.
21. Whether the control panel login check correctly uses the selected project's `codexWatchdog.codexHome` and `codexWatchdog.codexBin`.
22. Whether warning-but-allow-continue is the right behavior when login status is not ready.

## Known Limitations

- This is not a marketplace-grade extension yet.
- The VSIX is produced by a small local Node packer because this environment did not have `vsce`, `npm`, or `zip`.
- The extension does not implement a policy-gated safe executor yet. It now has a deterministic gate for enabling `workspace-write`, but does not execute a machine-verified allowlist of actions. For now, the safe default remains read-only inspection, reasoning, reports, and proposed state updates.
- It intentionally does not use stricter device isolation by default, because hiding physical devices can break `nvidia-smi` collection. GPU hard isolation should be added at the Linux user, container, or systemd device-policy layer if required.
- To keep a user timer running after SSH/VSCode disconnect, the Linux account may need:

```bash
loginctl enable-linger "$USER"
```
