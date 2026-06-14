"use strict";

const demoStateTemplates = {
  demoStateJson: () => JSON.stringify({
    schema_version: 1,
    updated_utc: "2026-05-13T21:00:00Z",
    mode: "observer",
    requires_review: false,
    active_task_id: null,
    active_branch: null,
    tasks: [
      {
        task_id: "demo-monitor-exp-demo-001",
        status: "pending",
        allowed_runner: "report_only",
        description: "Read logs/train.log and summarize exp_demo_001 progress.",
        inputs: ["logs/train.log"],
        outputs: [
          "agent/reports/latest.md",
          "agent/RUNTIME_STATE.md",
          "agent/MORNING_BRIEF.md"
        ],
        evidence_paths: ["logs/train.log"],
        max_runtime_minutes: 5,
        success_gates: [
          "latest metric step/loss/psnr/status are summarized",
          "no code, process, GPU, dataset, checkpoint, or git state is modified"
        ],
        stop_conditions: [
          "one report-only demo monitoring pass is complete",
          "evidence is insufficient and a blocker is written"
        ],
        next_allowed_tasks: [],
        requires_review_after: false
      }
    ],
    latest_completed_job: null,
    latest_gate_result: null,
    allowed_next_action: "report_only",
    blocked_actions: [
      "launch_training",
      "kill_process",
      "delete_files",
      "modify_code",
      "change_git_state"
    ],
    important_paths: [
      "logs/train.log",
      "agent/PLAN.md",
      "agent/TODO.md",
      "agent/STATE.md",
      "agent/SAFETY.md"
    ]
  }, null, 2) + "\n"
};

module.exports = {
  demoStateTemplates
};
