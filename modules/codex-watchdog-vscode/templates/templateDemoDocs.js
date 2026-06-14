"use strict";

const demoDocTemplates = {
  demoReadme: () => `# Watchdog Demo Project

This folder is a minimal project prepared by daily mode and handed to Codex Watchdog mode for testing.

The plugin creates the agent/ handoff structure here. The scheduled watchdog reads logs/train.log, reasons about the demo experiment, and writes reports under agent/reports/.
`,

  demoTrainLog: () => `[2026-05-13 20:00:00] exp_demo_001 step=100 loss=0.921 psnr=18.2 status=running
[2026-05-13 20:30:00] exp_demo_001 step=200 loss=0.713 psnr=20.1 status=running
[2026-05-13 21:00:00] exp_demo_001 step=300 loss=0.522 psnr=22.4 status=running
`,

  demoDailyHandoff: () => `# Daily Handoff

Last prepared: 2026-05-13 evening

## Tonight's Objective

- Monitor demo experiment \`exp_demo_001\`.
- Read \`logs/train.log\`.
- Decide whether the experiment is still running, completed, blocked, or uncertain.
- Write a report and morning brief.

## Approved Scope

- Read files under this project.
- Write only under \`agent/status/\`, \`agent/reports/\`, \`agent/logs/\`, and \`agent/pending/\`.
- Update \`agent/RUNTIME_STATE.md\`.
- Update \`agent/MORNING_BRIEF.md\`.

## Active Experiments To Watch

- \`exp_demo_001\`
- Expected log: \`logs/train.log\`

## Known Risks / Do Not Touch

- Do not launch training.
- Do not kill any process.
- Do not delete files.
- Do not modify code.
- Do not change git state.

## Morning Questions

- What was the latest observed step?
- Did the loss decrease?
- What is the next safe watch task?
`,

  demoPlan: () => `# Overnight Plan

## Objective

Watch demo experiment \`exp_demo_001\` and produce safe progress reports.

## Current Approved Work

1. Read \`logs/train.log\`.
2. Extract the latest step, loss, PSNR, and status.
3. Decide whether the experiment is still running.
4. Write \`agent/reports/latest.md\`.
5. Update \`agent/RUNTIME_STATE.md\`.
6. Update \`agent/MORNING_BRIEF.md\`.
7. Do not modify training code.
8. Do not launch or stop any process.
`,

  demoTodo: () => `# Watcher TODO

| Status | Task | Evidence / Path |
| --- | --- | --- |
| pending | Monitor \`exp_demo_001\` | \`logs/train.log\` |
`,

  demoState: () => `# Agent State

Last updated: 2026-05-13 evening

## Active Experiments

### exp_demo_001

- Status: running
- Log: \`logs/train.log\`
- Last human-known step: 300
- Last human-known loss: 0.522
- Last human-known PSNR: 22.4

## Next Safe Task

Read the latest log lines and write a watchdog report.
`,

  demoSafety: () => `# Safety Policy

## Execution Mode

Instantiated demo watcher mode: read-only reasoning.

## GPU Policy

- The watcher itself must run with CUDA_VISIBLE_DEVICES="".
- It must not allocate GPU memory.
- It must not run Python scripts that import torch with CUDA enabled.
- It must not launch training.
- It may inspect nvidia-smi output collected by agent/bin/collect_status.sh.

## Forbidden Commands

Never run or propose automatic execution of:

- rm, unlink, shred
- kill, pkill, killall
- git reset, git clean, git checkout, git switch, git pull, git push, git merge, git rebase
- sbatch, torchrun, accelerate launch, deepspeed, python train.py
- chmod/chown on project data or checkpoint directories

## Allowed Automatic Actions

For this demo only:

- read files under this project;
- read logs/train.log;
- summarize demo metrics;
- write reports under agent/reports/;
- write status files under agent/status/;
- write logs under agent/logs/;
- write review requests under agent/pending/;
- update agent/RUNTIME_STATE.md;
- update agent/MORNING_BRIEF.md.

## Demo Boundary

The watched experiment is exp_demo_001.

Do not modify source code, datasets, checkpoints, git state, processes, or environment variables.
`
};

module.exports = {
  demoDocTemplates
};
