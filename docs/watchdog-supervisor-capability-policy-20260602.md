# Watchdog Supervisor Capability Policy Update - 2026-06-02

This note summarizes the 2026-06-02 watchdog autonomy update for another Codex instance. It is written for a server-side Codex that already runs runner watchdogs, supervisor watchdogs, and a GPU queue runner.

## Executive Summary

The operating principle is now:

```text
1. Watchdogs should keep working whenever the next action is not truly dangerous.
2. Only truly dangerous work should wait for a human.
```

The important design change is that supervisor delegation is no longer a single broad approval. It is now controlled by a capability policy:

```text
supervisor_approved=true
  is accepted only if the task maps to an enabled supervisor capability.
```

This lets a server explicitly grant the supervisor enough power to unblock runner watchdogs, without turning the supervisor into a general remote executor.

## What Changed In Code

Updated module:

```text
modules/codex-watchdog-vscode
```

Version:

```text
0.1.45
```

Relevant commits:

```text
bfdf29e Add supervisor capability policy for watchdog autonomy
9d9a4b1 Distinguish queue enqueue from direct GPU approval
```

Main generated file affected:

```text
agent/bin/route_skill.py
```

The route template now contains:

```text
DEFAULT_SUPERVISOR_CAPABILITIES
load_supervisor_capability_policy()
classify_supervisor_capability()
supervisor_policy_rejection()
task_is_supervisor_approved()
supervisor_delegable_blocker()
```

## Default Capability Policy

Public template defaults are intentionally useful but conservative.

Enabled by default:

```text
report_only
state_reconcile
stale_marker_cleanup
local_workspace_copy
bounded_cpu_eval
```

Disabled by default:

```text
bounded_gpu_probe
bounded_training_canary
queue_enqueue
promotion_prepare
promotion_apply
external_send
```

This means runner watchdogs can continue many safe actions without human review:

```text
- report-only inventory / proposal / taskbox drafting
- stale marker cleanup
- state surface reconciliation
- local workspace copy work
- bounded CPU smoke/eval
```

But they still stop for high-risk actions unless the server explicitly enables a capability.

## Server-Specific Capability Config

A server can enable additional supervisor power by placing this file in the target runner project:

```text
agent/supervisor_capabilities.json
```

Example:

```json
{
  "schema_version": 1,
  "capabilities": {
    "queue_enqueue": {
      "enabled": true,
      "allowed_queues": ["gpu_queue"],
      "requires_taskbox": true,
      "allowed_output_paths": [
        "agent/queue/queued/",
        "agent/status/",
        "agent/reports/"
      ],
      "forbidden": [
        "direct_gpu_execution",
        "dataset_mutation",
        "checkpoint_mutation",
        "promotion",
        "external_send"
      ]
    }
  }
}
```

The values under each capability may carry extra server-side metadata. The first implemented route layer checks only the `enabled` flag and the classified capability, but the metadata is intentionally documented now so server-side runners can enforce it more strictly.

## Direct GPU Execution vs Controlled Queue Enqueue

This distinction is the most important part of the update.

These are not equivalent:

```text
direct GPU execution
controlled queue enqueue
```

Direct GPU execution means:

```text
runner directly launches a GPU command
runner bypasses the queue runner
runner bypasses queue allowlist / timeout / logging / resource controls
```

This remains dangerous and should wait for human approval unless a future site-specific policy says otherwise.

Controlled queue enqueue means:

```text
runner writes or prepares a bounded taskbox/request under a monitored queue path
GPU queue runner later decides whether/how to execute it
queue runner enforces allowlist, timeout, logging, and resource policy
```

This is modeled as:

```text
queue_enqueue
```

So a server with a safe queue runner can let supervisor approve:

```text
enqueue bounded GPU training/eval taskbox into controlled queue
```

without allowing:

```text
run GPU directly
bypass queue
mutate dataset/checkpoint
promote result
send externally
```

## How The Route Behaves Now

### 1. A normal supervisor-approved bounded CPU task

If a pending task has:

```json
{
  "status": "pending",
  "allowed_runner": "cpu",
  "supervisor_approved": true,
  "supervisor_approval": {
    "approved_by": "supervisor",
    "scope": "bounded CPU smoke"
  }
}
```

The route can proceed with:

```text
primary_skill = watchdog-orchestrator
permission_guardian_required = false
```

because `bounded_cpu_eval` is enabled by default.

### 2. A local workspace copy task

If a task is explicitly local-copy work:

```json
{
  "workspace_mode": "project_local_copy",
  "supervisor_approved": true,
  "supervisor_approval": {
    "approved_by": "supervisor",
    "approval_class": "local_workspace_copy",
    "scope": "copy source into workspace/<task_id>/ and modify only the local workspace copy"
  }
}
```

The route can proceed by default.

This is the preferred way to avoid review loops when a runner needs to experiment with code:

```text
copy shared input -> workspace/<task_id>/
modify local copy only
write artifacts under runs/<task_id>/ or agent/status/
promotion back to shared paths remains human-approved
```

### 3. A bounded GPU probe

By default, this does not proceed:

```json
{
  "allowed_runner": "gpu",
  "supervisor_approved": true,
  "supervisor_approval": {
    "approved_by": "supervisor",
    "approval_class": "bounded_gpu_probe",
    "scope": "bounded GPU probe with fixed timeout and no promotion"
  }
}
```

To allow it, the target runner project must explicitly enable:

```json
{
  "capabilities": {
    "bounded_gpu_probe": {
      "enabled": true
    }
  }
}
```

### 4. A controlled GPU queue enqueue

By default, this does not proceed:

```json
{
  "allowed_runner": "gpu",
  "supervisor_approved": true,
  "supervisor_approval": {
    "approved_by": "supervisor",
    "approval_class": "queue_enqueue",
    "scope": "enqueue bounded GPU training taskbox into controlled agent/queue/queued; queue runner executes later"
  }
}
```

If the target runner project explicitly enables:

```json
{
  "capabilities": {
    "queue_enqueue": true
  }
}
```

then the route can proceed.

### 5. A direct GPU bypass attempt

Even with `queue_enqueue` enabled, this stays blocked:

```text
bypass queue and execute GPU directly
```

The policy rejects direct queue bypass language.

## Supervisor Delegable Blocker Detection

Supervisor mode can inspect configured runner targets:

```text
WATCHDOG_SUPERVISOR_TARGETS=/path/to/runner_a:/path/to/runner_b
```

or:

```text
agent/supervisor_targets.json
```

If a target runner has:

```json
{
  "requires_human_review": true,
  "next_safe_action": {
    "kind": "propose_review",
    "description": "...",
    "reason": "..."
  }
}
```

the supervisor route now classifies the next action into a capability:

```text
report_only
local_workspace_copy
bounded_cpu_eval
bounded_gpu_probe
bounded_training_canary
queue_enqueue
```

If that capability is enabled by the target runner's `agent/supervisor_capabilities.json`, supervisor can route to:

```text
primary_skill = watchdog-orchestrator
task_id = supervisor-delegated-runner-blocker-approval
permission_guardian_required = false
```

This is how supervisor helps runner watchdogs escape review loops.

## What Is Still Forbidden

The supervisor capability policy is not a general approval grant.

The route still rejects or blocks:

```text
secrets / tokens / private keys
.env modification
package install
network fetch
dataset mutation
checkpoint mutation
deletion of shared/original files
systemd restart / service mutation
chmod/chown/sudo
direct shared-source edits unless local_workspace_copy
promotion_apply unless explicitly enabled
external_send unless explicitly enabled
direct GPU execution unless modeled by a future explicit policy
queue bypass
```

## Why This Helps Watchdog Autonomy

Before:

```text
runner hits review marker
supervisor writes another handoff
runner wakes again and sees the same review marker
no progress
```

After:

```text
runner hits review marker
supervisor classifies blocker
if not truly dangerous:
  supervisor writes bounded approval or reconciliation
  runner continues
if truly dangerous:
  human review remains required
```

The goal is not to remove review. The goal is to move review to the real risk boundary.

## Server Integration Checklist

After pulling this update on a server:

1. Refresh generated watchdog files for target projects.

```text
Codex Watchdog: Refresh Generated Watcher Files
```

or use the server's normal generated-file refresh process.

2. Add target-specific capabilities where needed:

```text
agent/supervisor_capabilities.json
```

3. For queue-based GPU work, prefer:

```text
queue_enqueue
```

over:

```text
bounded_gpu_probe
```

if the runner does not directly execute GPU commands.

4. Verify route behavior:

```text
python3 agent/bin/route_skill.py
```

Expected safe route when enabled:

```json
{
  "primary_skill": "watchdog-orchestrator",
  "permission_guardian_required": false,
  "task_id": "supervisor-delegated-runner-blocker-approval"
}
```

5. Keep direct GPU command execution blocked unless a separate explicit policy is designed.

6. Keep promotion as a separate human-reviewed task.

## Tests Added

The generated-template tests now cover:

```text
bounded CPU supervisor approval proceeds by default
local workspace copy approval proceeds by default
bounded GPU approval is denied by default
bounded GPU approval proceeds only with server-specific config
external_send is denied by default
queue_enqueue is denied by default
queue_enqueue proceeds only with server-specific config
direct GPU / queue bypass remains denied
supervisor target blocker can classify queue_enqueue
```

The full repo check passed:

```text
npm run check
```

## Remaining Future Work

This update is still route-layer governance, not a complete execution/audit framework.

Recommended next steps:

```text
1. approval ledger:
   agent/status/SUPERVISOR_APPROVALS.jsonl

2. workspace manifest:
   workspace/<task_id>/workspace_manifest.json

3. queue request schema validation:
   validate queue taskbox before enqueue

4. output path preflight:
   reject outputs outside queue/status/report/workspace paths

5. promotion packet:
   local workspace -> shared path remains separate human-reviewed task

6. dashboard fields:
   show active supervisor capability, latest approval, queue enqueue status

7. expiration / single-use approvals:
   supervisor approval should be one task, one scope, one bounded cycle
```

## Short Summary For Server Codex

Use this rule:

```text
If the runner would directly perform dangerous work, stop for human review.
If the runner would only submit a bounded request to a controlled queue, use queue_enqueue.
If the runner can work in a local copy, use local_workspace_copy.
If the runner only writes reports/status/proposals, proceed.
```

The supervisor should not be powerless. It should be capability-bounded.

The server should decide which capabilities are safe for its queue runner and hardware policy, then encode them in:

```text
agent/supervisor_capabilities.json
```

