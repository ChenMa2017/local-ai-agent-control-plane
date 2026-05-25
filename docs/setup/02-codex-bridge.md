# 02. codex-bridge Setup

Path:

```text
modules/codex-bridge
```

Purpose:

```text
Turn external requests into safe, logged, cancellable Codex CLI tasks.
```

Install/check:

```bash
cd $HOME/Documents/My_App_Dev/local-ai-agent-control-plane/modules/codex-bridge
npm install
npm test
```

Optional local config:

```bash
cp codex-bridge.config.example.json codex-bridge.config.json
```

For normal use through Agent Host, `codex-bridge.config.json` is not required. Agent Host passes project and user configuration when invoking the bridge.

Important features:

```text
run / status / logs / result / cancel
timeout
reconcile
safe result/log redaction
reference_task_id
workspace-write audit
workspace write lock
protected path policy
cleanup --dry-run
```

Manual smoke test:

```bash
node scripts/codex-bridge.js run --project self --dry-run "请模拟检查当前项目"
node scripts/codex-bridge.js status
```

Workspace-write tasks create:

```text
write_audit.json
diff_stat.safe.txt
changed_files.safe.txt
Write Summary in result.safe.md
```

Protected path violations produce:

```text
status: policy_violation
```
