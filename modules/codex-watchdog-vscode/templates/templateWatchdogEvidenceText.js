"use strict";

const watchdogEvidenceTextTemplates = {
  projectIndexReadme: () => `# Project Evidence Index

This directory is the metadata-first evidence boundary for watchdog projects.

Use it to decide what the agent should read before it opens large source files or logs.

Files:

- \`schema/\`: machine-readable contracts and shared enums for the Phase 1 local evidence index
- \`document_index.jsonl\`: document identity, lifecycle, and evidence-scope metadata
- \`experiment_index.jsonl\`: experiment identity, protocol, and result-location metadata
- \`current_conclusions.json\`: current project conclusions that are safe to cite when still supported
- \`golden_queries.json\`: regression queries that protect retrieval behavior over time

Commands:

\`\`\`bash
python3 agent/bin/validate_watchdog_index.py --project-root .
python3 agent/bin/watchdog_doc_search.py --query "current conclusion" --json
\`\`\`

Update discipline:

1. When you add a new durable conclusion, update \`document_index.jsonl\` and \`current_conclusions.json\` in the same change.
2. When you add a new formal experiment result, update \`experiment_index.jsonl\` and any referenced documents in the same change.
3. When a conclusion or report becomes stale, superseded, deprecated, or invalidated, mark that status explicitly instead of leaving old files ambiguous.
4. Prefer metadata-first retrieval. Call \`watchdog_doc_search.py\` before reading many source files when the question asks for a current conclusion, a current best candidate, a comparison claim, or a formal experiment result.
`,

  projectIndexSchemaReadme: () => `# Project Evidence Index Schemas

These schemas define the Phase 1 machine-readable evidence contracts for watchdog projects.

Design goals:

1. Keep the index local and auditable.
2. Let the agent decide whether it is safe to answer before it scans large files.
3. Separate document identity, experiment identity, and current conclusions.
4. Make stale, superseded, deprecated, and invalidated states explicit.

Files:

- \`enums.json\`: shared enum values
- \`document_index.schema.json\`: per-line schema for \`document_index.jsonl\`
- \`experiment_index.schema.json\`: per-line schema for \`experiment_index.jsonl\`
- \`current_conclusions.schema.json\`: top-level schema for \`current_conclusions.json\`

Implementation note:

Phase 1 intentionally uses only local files plus Python standard-library tools. The validator enforces the contract directly and does not require a separate schema runtime dependency.
`,

  projectIndexDocumentIndex: () => "",

  projectIndexExperimentIndex: () => "",

  projectIndexCurrentConclusions: () => `${JSON.stringify({
    schema_version: "current_conclusions.v0.1",
    updated_at: null,
    items: []
  }, null, 2)}\n`,

  projectIndexGoldenQueries: () => `${JSON.stringify({
    schema_version: "golden_queries.v0.1",
    queries: []
  }, null, 2)}\n`
};

module.exports = {
  watchdogEvidenceTextTemplates
};
