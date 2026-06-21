# Codex Bridge

This is a local-first prototype of the "external message to safe Codex task" layer.

It is intentionally not a chat app and does not automate the VSCode Codex UI. It accepts CLI or message-like input, checks user and project whitelists, creates a task record, runs a worker, saves logs, and exposes status/log/result/cancel commands.

This project was split out from `codex-watchdog-vscode` so the bridge core can evolve independently from the watchdog extension.

## Quick Feel

Run a safe simulation:

```bash
node scripts/codex-bridge.js run --project self --dry-run "请检查这个项目当前状态"
```

Or through npm:

```bash
npm run bridge:demo
npm run bridge -- status
```

Then use the returned task id:

```bash
node scripts/codex-bridge.js status task_...
node scripts/codex-bridge.js logs task_...
node scripts/codex-bridge.js result task_...
```

To feel cancellation, make the dry-run slower and cancel it from another terminal:

```bash
node scripts/codex-bridge.js run --project self --dry-run --dry-run-step-ms 1500 "请模拟一个较慢任务"
node scripts/codex-bridge.js cancel task_...
```

`cancel` now sends a real termination signal to the task process group. For a queued task it marks the task `cancelled`; for a running task it moves through `cancelling` and then `cancelled`.

Try the message-adapter shape without building Discord or a web chat:

```bash
node scripts/codex-bridge.js message --user chenma "/codex run project=self dry_run=true 请总结 README 的重点"
node scripts/codex-bridge.js message --user chenma "/codex status"
```

## Real Codex Run

Omit `--dry-run` when you want the bridge to call Codex:

```bash
node scripts/codex-bridge.js run --project self "请只读检查 README 和 package.json，总结这个项目是什么"
```

For readonly projects the runner uses:

```bash
codex --ask-for-approval never exec --json --sandbox read-only --cd <whitelisted-project> --skip-git-repo-check --output-last-message <task-result-file> "<prompt>"
```

For explicitly allowlisted writable projects, the runner can use:

```bash
codex --ask-for-approval never exec --json --sandbox workspace-write --cd <whitelisted-project> --skip-git-repo-check --output-last-message <task-result-file> "<prompt>"
```

To create a follow-up task with lightweight context from an earlier task, pass `--reference-task-id`:

```bash
node scripts/codex-bridge.js run --project self --reference-task-id task_20260525_120000_abcdef "请基于上一个任务继续分析"
```

The new task remains independent, but Codex receives the referenced task's safe result excerpt and basic metadata before the current prompt. Raw results and raw logs are not injected.

Child processes get `CUDA_VISIBLE_DEVICES=""`.

## Config

By default, if `codex-bridge.config.json` does not exist, the prototype allows only the current local user and one project named `self` pointing at this extension folder.

To customize, copy the example:

```bash
cp codex-bridge.config.example.json codex-bridge.config.json
```

Config fields:

- `users`: allowed external users.
- `projects`: project whitelist. External messages use project names, never raw paths. Each project can be `readonly` or explicitly `workspace-write`.
  A common pattern is to define `main_codex` at `$HOME/Documents/My_AI_Agent` with `workspace-write`, while keeping individual project aliases readonly until they need write access.
- `stateDir`: where task JSON, logs, stdout JSONL, stderr, and results are saved.
- `codexBin`: Codex executable.
- `maxConcurrent`: how many bridge tasks may run at once.
- `timeoutSeconds`: maximum runtime before the lifecycle watchdog terminates the task and marks it `timeout`.
- `cancelGraceMs`: how long cancel waits after `SIGTERM` before escalating to `SIGKILL`.
- `watchdogIntervalMs`: how often the per-task watchdog checks deadline/stale state.
- `taskLockTimeoutMs`: how long task metadata operations wait for a per-task lock before failing.
- `taskLockStaleMs`: how old a task lock must be before the bridge will reclaim it when the owner process is no longer alive.
- `redaction`: safe-output settings for result/log display.

## Task Lifecycle

Every task writes lifecycle metadata into `.codex-bridge/tasks/<task_id>/task.json`, including:

```text
pid
pgid
started_at
deadline_at
finished_at
timeout_seconds
cancel_requested_at
termination_reason
```

The worker process is started as a detached process group. Real Codex runs inherit that group, so cancelling a task terminates the worker and its Codex child together.

Supported lifecycle statuses:

```text
queued
running
finalizing
cancelling
cancelled
done
failed
timeout
stale
policy_violation
```

Useful commands:

```bash
node scripts/codex-bridge.js status
node scripts/codex-bridge.js status task_...
node scripts/codex-bridge.js cancel task_...
node scripts/codex-bridge.js reconcile
```

`reconcile` scans existing task metadata. If a task still says `running` or `cancelling` but its bridge worker is gone, it is marked `stale`.

Task metadata writes are guarded by a per-task lock. The bridge records lock ownership on disk and can reclaim a stale lock automatically when the recorded owner PID no longer exists and the lock age exceeds `taskLockStaleMs`.

## Workspace-Write Governance

`workspace-write` remains an explicitly allowlisted mode for workspaces such as `main_codex`, but every writable task now gets an audit trail.

For each `workspace-write` task, the bridge records a baseline before Codex starts and a final summary after the task ends. The task directory includes:

```text
write_audit.json
write_baseline.json
diff_stat.safe.txt
changed_files.safe.txt
```

The safe result is also appended with a `Write Summary` section that reports:

```text
changed file count
added / modified / deleted counts
changed file list
protected path violation status
```

If the workspace is a Git repository, the audit uses `git status --porcelain`, `git diff --stat`, and `git diff --name-status`. For non-Git workspaces it falls back to a best-effort file snapshot.

For Git-backed `workspace-write` tasks, the bridge now prepares an isolated temporary `git worktree` and runs Codex inside that checkout. This keeps the original checkout cleaner during the task and makes the task-local diff easier to inspect. The isolated worktree starts from `HEAD`, so uncommitted local changes in the original workspace are not automatically included in the writable task context.

Protected paths are checked for writable tasks. The default policy flags paths such as:

```text
.env
secrets.env
*.pem
*.key
.git/
.codex-bridge/tasks/
state/task_threads.json
node_modules/
.venv/
```

If a task that otherwise completed successfully touches a protected path, its final status becomes `policy_violation`. The safe result still shows the task output plus the write summary, but the status makes the policy issue visible in CLI, Web UI, and Discord.

Writable tasks also acquire a workspace write lock. Only one `workspace-write` task can run at a time for the same workspace, and nested workspace paths are treated as conflicting. `readonly` tasks can still run concurrently. Locks are released on `done`, `failed`, `cancelled`, `timeout`, `stale`, and `policy_violation`; `reconcile` also cleans stale write locks left behind by dead workers.

## Cleanup Dry Run

Long-running use creates task artifacts under `.codex-bridge/tasks/`. The first cleanup command is intentionally dry-run only:

```bash
node scripts/codex-bridge.js cleanup --dry-run --older-than-days 30 --keep-last 200
```

It reports which tasks would be archived based on age or count, but it does not move or delete anything. Future archive behavior can build on this output after the retention policy is reviewed.

## Safe Output

Raw artifacts stay on disk for local inspection:

```text
.codex-bridge/tasks/<task_id>/result.md
.codex-bridge/tasks/<task_id>/bridge.log
.codex-bridge/tasks/<task_id>/stdout.jsonl
.codex-bridge/tasks/<task_id>/stderr.log
```

Display-oriented artifacts are generated separately:

```text
.codex-bridge/tasks/<task_id>/result.safe.md
.codex-bridge/tasks/<task_id>/logs.safe.txt
```

By default, `result` and `logs` print the safe version:

```bash
node scripts/codex-bridge.js result task_...
node scripts/codex-bridge.js logs task_... --tail 80 --max-chars 20000
```

Local raw inspection is still available:

```bash
node scripts/codex-bridge.js result task_... --raw
node scripts/codex-bridge.js logs task_... --raw
```

Adapters can request structured metadata:

```bash
node scripts/codex-bridge.js result task_... --json-output
node scripts/codex-bridge.js logs task_... --json-output --tail 200 --max-chars 20000
```

The safe-output layer redacts project paths, the user home path, OpenAI keys, GitHub tokens, bearer tokens, private key blocks, and common `.env` secret assignments.

## Current Safety Boundary

- Project paths must come from the whitelist.
- Project mode must be explicitly allowlisted.
- `readonly` projects use read-only sandboxing.
- `workspace-write` projects can modify files inside the configured workspace root, but should still be narrow and intentional.
- `cancel` terminates the task process group with `SIGTERM`, then escalates to `SIGKILL` after `cancelGraceMs`.
- Timeout is enforced by a per-task watchdog and marks the task `timeout`.
- API adapters should return safe result/log output by default. Raw artifacts should be local/admin-only.
- No Discord, Slack, Cloudflare, or VSCode UI control is included yet. Those should be adapters in front of this core.
