"use strict";

const supportStateJsonTemplates = {
  evidenceLedgerJsonl: () => "",

  workspaceWritePolicyExample: () => JSON.stringify({
    enabled: false,
    writable_paths: [
      "agent/tmp/",
      "outputs/probes/"
    ],
    allowed_commands: [
      "python3 tools/example_probe.py"
    ]
  }, null, 2) + "\n",

  secondarySkillsExample: () => JSON.stringify({
    schema_version: 1,
    skills: [
      {
        skill_id: "project-research-support",
        enabled: true,
        path: "agent/skills/project-secondary-example/SKILL.example.md",
        selectors: {
          primary_skills: ["watchdog-orchestrator", "watchdog-gate-evaluator"],
          roles: ["runner"],
          supervisor_modes: [],
          task_capabilities: ["report_only", "bounded_cpu_eval"]
        },
        notes: "Example project-local support skill: refine evidence hygiene, comparability checks, or reviewer packaging without changing runtime authority."
      }
    ]
  }, null, 2) + "\n"
};

module.exports = {
  supportStateJsonTemplates
};
