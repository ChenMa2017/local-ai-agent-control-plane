# Mattermost / Web -> Bridge 任务入口设计

## 当前原型状态

已实现一个最小安全原型：

```text
bridge.py
config.example.json
watchdog_bridge.sh
tests/test_bridge.py
```

这个原型现在有两个入口：

```text
Mattermost slash command -> watchdog inbox
网页表单 -> codex-bridge task
```

Mattermost 入口会验证 token、用户白名单和项目白名单，然后把任务写入目标项目的 `agent/inbox/`。

网页入口会调用独立项目：

```text
$HOME/Documents/My_App_Dev/codex-bridge
```

并通过 `codex-bridge` 创建 task、返回 task_id，再允许网页查询 status / result / logs / cancel。

它不会：

- 执行 shell；
- 直接启动 Codex；
- 直接启动 watchdog；
- 删除文件；
- 绕过目标项目的 `SAFETY.md` 或 allowlist。

其中网页入口会启动一个受控的本地子进程：

```text
node $HOME/Documents/My_App_Dev/codex-bridge/scripts/codex-bridge.js ...
```

它不拼接 shell 字符串，真实 Codex 执行仍由 `codex-bridge` 自己的项目白名单、用户白名单和 read-only runner 管理。

最快启动方式：

```bash
cd $HOME/Documents/My_App_Dev/mattermpst_chat
MATTERMOST_TOKEN=你的slash-command-token CODEX_WEB_TOKEN=你的网页访问token ./watchdog_bridge.sh init
./watchdog_bridge.sh start
./watchdog_bridge.sh status
./watchdog_bridge.sh smoke
```

启动后浏览器打开：

```text
http://127.0.0.1:8787/
```

网页上输入访问 token 后，会通过 `/whoami` 显示后端认证出的用户身份。提交任务后会拿到回执 task_id，并自动加载最终 result；也可以点 `Status`、`Result`、`Logs`、`Cancel` 查询或控制任务。

常用脚本命令：

```bash
./watchdog_bridge.sh start       # 后台启动
./watchdog_bridge.sh stop        # 停止
./watchdog_bridge.sh restart     # 重启
./watchdog_bridge.sh foreground  # 前台运行，适合调试
./watchdog_bridge.sh logs        # 查看日志
./watchdog_bridge.sh smoke       # 本地模拟一次 /watchdog task
```

运行前复制配置：

```bash
cp config.example.json config.json
```

把 `mattermost_tokens` 改成 Mattermost slash command 的 token。把 `auth.tokens` 配成 Codex 网页/API 的 Bearer Token 映射：

```json
{
  "auth": {
    "tokens": {
      "replace-with-codex-web-token": {
        "user": "chenma",
        "role": "admin"
      },
      "replace-with-discord-adapter-token": {
        "user": "chenma",
        "role": "user"
      }
    }
  }
}
```

Web UI 本地管理可以使用 `admin` token；Discord Adapter 建议使用 `user` token，这样它不能请求 `raw=true` 的原始结果或日志。

Codex Web/API 的用户身份只来自这个 token 映射，不接受前端请求体里的 `user` / `user_name` / `user_id`。

本地启动：

```bash
python3 bridge.py --config config.json
```

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

Mattermost slash command 的 Request URL 可配置为：

```text
http://你的服务器:8787/mattermost/watchdog
```

Codex Bridge 网页入口：

```text
http://127.0.0.1:8787/
```

Codex Bridge API：

```text
GET  /whoami
GET  /codex/workspaces
GET  /codex/capabilities
GET  /codex/tasks
GET  /codex/intake
POST /codex/run
POST /codex/stream-token
GET  /codex/events
POST /codex/status
POST /codex/result
POST /codex/logs
POST /codex/cancel
```

`POST /codex/prepare` is now the structured intake path, not just a generic clarification collector. It can:

```text
- classify the request into a TASK_CONTRACT
- persist INTENT_DRAFT / GRAY_AREAS / QUESTIONS / TASKBOX_DRAFT / POLICY_PREFLIGHT
- persist DECISION_GATE.json for experiment-like requests
- consult project-local evidence retrieval for current-conclusion / comparison / formal-result style requests when a workspace exposes project_index + watchdog_doc_search.py
- persist EVIDENCE_RETRIEVAL.json and READ_PLAN.md beside the intake artifacts
- snapshot project-level RESEARCH_PROGRAM.json into the intake and synthesize HYPOTHESIS_REGISTRY.json / EXPERIMENT_SPEC.json as first-class research objects
- expose GET/POST `/codex/intake` so clients can reload the current intake bundle and any post-run drafts by `intake_id`
- allow POST /codex/prepare to start a new intake from followup_task_id by reusing the latest FOLLOWUP_TASK_DRAFT prompt/reference context
- allow POST /codex/run to continue a prepared intake_id and inject the stored read-plan / claim-boundary context into the final run prompt
- persist EXECUTION_EVALUATION.json / EXECUTION_EVALUATION.md when a prepared task later exposes a safe result through POST /codex/result
- persist FOLLOWUP_TASK_DRAFT.json / FOLLOWUP_TASK_DRAFT.md so a later client can turn the latest result into a new /codex/prepare prompt without guessing from scratch
- persist LEDGER_NOTE_DRAFT.json / LEDGER_NOTE_DRAFT.md as an intake-local proposed fragment for `research/LEDGER_NOTES.md` without touching the real project ledger
- persist REVIEW_PROPOSAL_DRAFT.json / REVIEW_PROPOSAL_DRAFT.md when the result still needs a bounded claim review or human policy review
- persist EXPERIMENT_RESULT.json as a structured post-run experiment evaluation object, even before a real domain metric evaluator exists
- persist CURRENT_CONCLUSION_UPDATE.json / CURRENT_CONCLUSION_PROMOTION.json as watchdog-compatible draft objects for conclusion publication/review handoff
- persist EVALUATION_REPORT.json / CURRENT_CONCLUSIONS.json as intake-local research-object outputs, so result review and conclusion-promotion state become queryable objects instead of only prose drafts
- block direct execution until missing experiment decisions are clarified
```

Typical decision-gate triggers are requests that imply training, GPU use, fairness-sensitive comparisons, or a result claim that still lacks a clear control definition or success criterion.

除 `/health` 和网页 HTML 外，所有 `/codex/*` API 与 `/whoami` 都需要：

```http
Authorization: Bearer <token>
```

本地模拟网页 API：

```bash
curl -X POST http://127.0.0.1:8787/codex/run \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"main_codex","prompt":"请只回复 OK","dry_run":"false","source":"web","idempotency_key":"web-demo-001","metadata":{"client":"web-ui"}}'
```

如果已经通过 `/codex/prepare` 生成了 `intake_id`，则 `/codex/run` 也可以直接复用那份 intake，而不是重新粘贴同一个 prompt：

```bash
curl -X POST http://127.0.0.1:8787/codex/run \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"main_codex","intake_id":"intake_20260616_000001_ab12cd","source":"web","idempotency_key":"web-demo-prepare-001","metadata":{"client":"web-ui"}}'
```

这条路径会先检查 `TASK_CONTRACT / TASKBOX_DRAFT / POLICY_PREFLIGHT` 是否仍然可运行；如果 intake 还在 clarification 或 decision gate 状态，Agent Host 会返回 `409 prepare_not_runnable`，而不会静默绕过 prepare gate。

如果只是想把当前 intake 状态重新取回给 Web / UI / adapter，而不是马上执行，也可以直接读取：

```bash
curl http://127.0.0.1:8787/codex/intake?intake_id=intake_20260616_000001_ab12cd \
  -H 'Authorization: Bearer <token>'
```

或者：

```bash
curl -X POST http://127.0.0.1:8787/codex/intake \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"intake_id":"intake_20260616_000001_ab12cd"}'
```

返回会包含 `intent / questions / contract / taskbox / preflight / evidence_retrieval`，以及在可用时附带 `execution_evaluation / followup_task_draft / ledger_note_draft / review_proposal_draft / experiment_result / current_conclusion_update / current_conclusion_promotion`。

如果 workspace 自身有 `research/RESEARCH_PROGRAM.json`，这条 intake 路径还会把它快照成 intake-local `RESEARCH_PROGRAM.json`，并额外返回：

```text
- hypothesis_registry
- experiment_spec
```

当一个带 `intake_id` 的任务后续通过 `POST /codex/result` 暴露 safe result 时，Agent Host 还会把这次执行整理成结构化 `EXECUTION_EVALUATION`：

```text
- execution_decision
- recommended_next_action
- safe_result_excerpt
- evidence_retrieval_decision
- write_audit summary
```

这让 intake 目录不只记录“准备阶段”，也开始记录“执行后该如何 review / follow up”。

在这之后，Agent Host 还会继续合成一份 `FOLLOWUP_TASK_DRAFT`，其中包含：

```text
- recommended_next_action
- reason / remediation
- evidence_retrieval_decision
- title / summary
- reference_task_id
- prompt
- claim_boundary
- read_plan
- provenance
```

这份 draft 仍然只是下一轮 `/prepare` 的输入草案，不会自动绕过 prepare gate 或直接创建新任务。

同一次 `POST /codex/result` 还会额外整理两类 intake 内部草稿：

```text
- LEDGER_NOTE_DRAFT
  把 safe result、warning、claim boundary、read plan 组织成一份“建议写入 research/LEDGER_NOTES.md 的草稿”
  这只是 intake 本地草稿，不会直接修改项目里的正式 ledger / notes
  现在还会带 `provenance`，说明它来自哪份 `EXECUTION_EVALUATION`

- REVIEW_PROPOSAL_DRAFT
  当结果仍然需要 bounded-claim review，或任务因为 policy boundary 停止时，
生成一份 reviewer-ready proposal，说明 review scope、reason、stop condition、safe result excerpt
  现在也会带 `provenance`，说明它是 agent-host 基于 post-run evaluation 自动合成出来的

- OPERATOR_SUMMARY
  这是一个面向操作员的轻量状态对象，
  用统一字段解释“现在是不是被卡住了、为什么、证据决策是什么、下一步最安全动作是什么”
  prepare 阶段会先写一版，post-run 阶段会再更新成结果期 summary
```

同一次结果整理还会补齐六份一等研究对象：

```text
- HYPOTHESIS_UPDATE
  当 intake 阶段已经形成 hypothesis candidate 时，
  Agent Host 会把结果整理成一份 project-level hypothesis record 草稿，
  包含 hypothesis_id / claim / mechanism / prediction / falsification_criteria / supporting_evidence，
  同时也会把 post-run 研究状态写进 `status / evaluation_result / evaluation_validity`，
  让 `testing / inconclusive / invalid` 这类真实阶段能直接出现在 hypothesis record 里

- HYPOTHESIS_PROMOTION
  把 hypothesis_update 包成一个 promotion bundle，
  明确它现在是 not_required / not_ready / review_required / candidate_ready / human_review_required 中的哪一种，
  并通过 `project_sync` 说明这次结果是否已经：
  - 直接 upsert 到 `research/HYPOTHESIS_REGISTRY.jsonl`
  - 写成 `research/proposals/hypotheses/*.json` review bundle
  - 或者仍然停留在 not_required / not_ready 状态

- EXPERIMENT_INDEX_UPDATE
  当 prepare 阶段已经判定“这次工作对应一个 experiment object”时，
  Agent Host 会把结果整理成一份尽量贴近 watchdog `experiment_index_update` 契约的草稿，
  包含 experiment_id / experiment_type / evidence_scope / primary_metrics / run_id

- EXPERIMENT_RESULT
  当 prepare 阶段已经判定“这次工作对应一个 experiment object”时，
  Agent Host 还会生成一份独立的 experiment result contract，
  包含 assessment_basis / validity / result / metrics / baseline_comparison / reproducibility
  默认会先走 `structural_only` evaluator；
  如果任务目录里额外提供 `RUNNER_METRICS.json`，Agent Host 会把结构化指标并入评估，
  在 success criteria 足够明确时把 assessment basis 提升到 `runner_metrics`，并产出 `supported / refuted / inconclusive`

- EXPERIMENT_PROMOTION
  把 experiment_index_update 包成一个 promotion bundle，
  明确它现在是 not_required / not_ready / review_required / candidate_ready / human_review_required 中的哪一种，
  并通过 `project_sync` 说明这次结果是否已经：
  - 直接 upsert 到 `project_index/experiment_index.jsonl`
  - 写成 `research/proposals/experiments/*.json` review bundle
  - 或者仍然停留在 not_required / not_ready 状态

- EVALUATION_REPORT
  把 execution_decision / claim_boundary / read_plan / review requirement 组织成统一的评估对象，
  同时记录 hypothesis / experiment / conclusion promotion state，
  以及一组 `structural_only` 的 machine checks、validity、assessment 字段，
  明确这次评估只是“结构化有效性检查”，不是自动科学裁决

- CURRENT_CONCLUSION_UPDATE
  生成一个尽量贴近 watchdog `current_conclusion_update` 契约的结论草稿，
  包含 topic_id / conclusion_status / claim / evidence_scope / risk_flags

- CURRENT_CONCLUSION_PROMOTION
  把 current_conclusion_update 和 evidence-search receipt 包成一个 promotion bundle，
  明确它现在是 bounded_only / review_required / candidate_ready / human_review_required 中的哪一种
  并通过 `project_sync` 说明这次结果是否已经：
  - 直接 upsert 到 `project_index/current_conclusions.json`
  - 写成 `research/proposals/current_conclusions/*.json` review bundle
  - 或者仍然停留在 bounded_only / not_ready 状态

- CURRENT_CONCLUSIONS
  不直接改项目里的正式 current_conclusions.json，
  但会明确记录当前 safe result 处于 not_ready / bounded_only / review_required / candidate_ready / human_review_required 中的哪一种 promotion state
```

这样 intake 目录现在不仅记录“怎么准备”和“执行后建议做什么”，还会记录“如果要交给人接手，应该把什么材料一起交出去”，以及“这次结果在研究对象层面到底推进到了哪一步”。

当 `HYPOTHESIS_PROMOTION.promotion_state == candidate_ready` 且当前 workspace 已配置项目根目录时，Agent Host 现在会把规范化后的 hypothesis record 受控 upsert 到项目级 `research/HYPOTHESIS_REGISTRY.jsonl`。

在真正 upsert 之前，Agent Host 还会先校验 hypothesis status transition 是否安全；如果当前项目里的旧状态与这次候选更新不兼容，它不会强行覆盖，而是自动把这次 promotion 降级成 `transition_review_required`，并改写成 `research/proposals/hypotheses/*.json` review bundle。

当 hypothesis promotion state 是 `review_required` 或 `human_review_required` 时，Agent Host 不会自动落到正式 hypothesis registry；它只会把一份 reviewer bundle 写到 `research/proposals/hypotheses/`，把 project-level promotion 继续留给人或 watchdog review 流程。

当 `EXPERIMENT_PROMOTION.promotion_state == candidate_ready` 且当前 workspace 已配置项目索引时，Agent Host 现在会把规范化后的 experiment item 受控 upsert 到项目级 `project_index/experiment_index.jsonl`。

在真正 upsert 之前，Agent Host 也会先校验 experiment status transition；如果项目里已有 record 的状态已经进入 `archived / invalidated / deprecated` 之类不适合回退的阶段，它不会直接覆盖，而是自动把这次 promotion 降级成 `transition_review_required`，并改写成 `research/proposals/experiments/*.json` review bundle。

当 experiment promotion state 是 `review_required` 或 `human_review_required` 时，Agent Host 不会自动发布 experiment record；它只会把一份 reviewer bundle 写到 `research/proposals/experiments/`，把 project-level 发布动作继续留给人或 watchdog review 流程。

当 `CURRENT_CONCLUSION_PROMOTION.promotion_state == candidate_ready` 且当前 workspace 已配置项目索引时，Agent Host 现在会把规范化后的 conclusion item 受控 upsert 到项目级 `project_index/current_conclusions.json`。

当 promotion state 是 `review_required` 或 `human_review_required` 时，Agent Host 不会自动发布；它只会把一份 reviewer bundle 写到 `research/proposals/current_conclusions/`，把 project-level 发布动作继续留给人或 watchdog review 流程。

如果客户端改用 `POST /codex/result-page` 分页读取长结果，第 1 页也会复用同一批 post-run metadata：`EXECUTION_EVALUATION`、`FOLLOWUP_TASK_DRAFT`、`LEDGER_NOTE_DRAFT`、`REVIEW_PROPOSAL_DRAFT`、`HYPOTHESIS_UPDATE`、`HYPOTHESIS_PROMOTION`、`EXPERIMENT_RESULT`、`EXPERIMENT_INDEX_UPDATE`、`EXPERIMENT_PROMOTION`、`CURRENT_CONCLUSION_UPDATE`、`CURRENT_CONCLUSION_PROMOTION`、`EVALUATION_REPORT`、`CURRENT_CONCLUSIONS` 会和第一页 safe result slice 一起返回，不会因为结果过长而丢掉下一步建议。

如果客户端拿到了上一轮任务的 `task_id`，现在也可以直接这样发起下一轮 prepare：

```bash
curl -X POST http://127.0.0.1:8787/codex/prepare \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"followup_task_id":"task_20260616_120000_follow01","source":"web"}'
```

这条路径会读取该任务关联 intake 下最新的 `FOLLOWUP_TASK_DRAFT.json`，并把其中的 `prompt / reference_task_id / suggested_mode / read_plan context` 重新带回新的 prepare 流程。

这些 post-run draft 现在还带统一的 provenance payload，字段风格尽量向 watchdog 既有 successor provenance 对齐，例如：

```text
- artifact_role
- source
- repair_origin
- generated_by
- derived_from_report
- generated_at_utc
```

`OPERATOR_SUMMARY.json` 则会把这些分散对象再压成一个 operator-facing 视图，典型字段包括：

```text
- overall_status
- blocked
- blockers
- evidence_decision
- promotion_states
- unmet_requirements
- next_safe_action
```

它的目标不是替代原始 artifact，而是让操作者不用手工比对 `PRELIGHT / EVIDENCE_RETRIEVAL / REVIEW_PROPOSAL / CURRENT_CONCLUSION_PROMOTION` 才能知道现在到底卡在哪一层。

如果上一轮任务已经产出了 `EXECUTION_EVALUATION / LEDGER_NOTE_DRAFT / REVIEW_PROPOSAL_DRAFT / HYPOTHESIS_UPDATE / HYPOTHESIS_PROMOTION / EXPERIMENT_RESULT / EXPERIMENT_INDEX_UPDATE / EXPERIMENT_PROMOTION / CURRENT_CONCLUSION_UPDATE / CURRENT_CONCLUSION_PROMOTION / EVALUATION_REPORT / CURRENT_CONCLUSIONS`，这条 follow-up prepare 响应也会把这些 post-run context 一并带回客户端，方便 UI 直接展示“这次 follow-up 是基于怎样的结果评估继续的”，以及“hypothesis / experiment / conclusion promotion state 现在处在哪一层”。

确认当前 token 身份：

```bash
curl http://127.0.0.1:8787/whoami \
  -H 'Authorization: Bearer <token>'
```

查看当前可用 workspace：

```bash
curl http://127.0.0.1:8787/codex/workspaces \
  -H 'Authorization: Bearer <token>'
```

`/codex/workspaces` 只返回 workspace alias 和允许的执行模式，不返回真实 path：

```json
{
  "ok": true,
  "workspaces": [
    {
      "id": "main_codex",
      "label": "main codex",
      "default_mode": "workspace-write",
      "allowed_modes": ["workspace-write"],
      "description": "Primary AI-Agent workspace for cross-project coordination with workspace-write sandbox."
    },
    {
      "id": "grokking",
      "label": "grokking",
      "default_mode": "readonly",
      "allowed_modes": ["readonly"],
      "description": "Grokking watchdog project under main_codex."
    }
  ]
}
```

Workspace mode 说明：

```text
readonly         只读分析，不修改文件。
workspace-write 允许 Codex 在该 workspace root 内修改文件，适合明确授权的本地工作区。
```

当前主入口是 `main_codex`，路径是 `$HOME/Documents/My_AI_Agent`，模式为 `workspace-write`。`grokking` 是主入口下的项目级只读 workspace。旧入口 `self` 和 `codex` 已从 Agent Host workspace 列表中移除。

查看 Agent Host 能力：

```bash
curl http://127.0.0.1:8787/codex/capabilities \
  -H 'Authorization: Bearer <token>'
```

返回示例：

```json
{
  "ok": true,
  "version": "mvp-v0.7",
  "commands": ["run", "tasks", "status", "result", "logs", "cancel"],
  "features": {
    "auth": true,
    "safe_output": true,
    "sse": true,
    "cancel": true,
    "timeout": true,
    "resume": false,
    "write_mode": true,
    "raw_admin_access": true
  },
  "modes": ["readonly", "workspace-write"]
}
```

查看最近 Codex 任务：

```bash
curl 'http://127.0.0.1:8787/codex/tasks?limit=50' \
  -H 'Authorization: Bearer <token>'
```

`/codex/tasks` 会从独立 `codex-bridge` 的任务目录读取元数据：

```text
$HOME/Documents/My_App_Dev/codex-bridge/.codex-bridge/tasks/<task_id>/task.json
```

支持的查询参数：

```text
limit    最多返回多少条，默认 50，最大 200
status   按 queued / running / done / failed / cancelled / timeout 等状态过滤
project  按项目别名过滤，例如 main_codex / grokking / agent_host / discord_adapter / watchdog_vscode
```

返回字段只包含任务控制台需要的安全摘要：

```json
{
  "ok": true,
  "tasks": [
    {
      "task_id": "task_20260523_123301_e36d8e",
      "owner": "chenma",
      "project": "grokking",
      "source": "web",
      "status": "done",
      "created_at": "2026-05-23T12:33:01.103Z",
      "updated_at": "2026-05-23T12:33:36.554Z",
      "duration_sec": 35,
      "exit_code": 0,
      "mode": "readonly",
      "write_audit": false,
      "changed_files_count": null,
      "protected_path_violation": false,
      "prompt_preview": "请只读检查 README 和 package.json...",
      "has_result": true,
      "has_logs": true
    }
  ]
}
```

对于 `workspace-write` 任务，任务列表会额外显示是否有 write audit、changed file 数量，以及是否触碰 protected path policy。真实 diff 仍留在 `codex-bridge` 的任务 artifact 中，API 不返回真实项目路径，也不会返回完整 `adapter_metadata`。普通用户只能看到自己的任务，`admin` 可以看到当前配置项目范围内的全部任务。`/codex/status`、`/codex/result`、`/codex/logs`、`/codex/cancel` 也会检查当前 token 是否有权访问对应 task。

任务列表加载前会调用 `codex-bridge reconcile`，让 `running/cancelling` 但 worker 已经不存在的任务更新为 `stale`，也让超过 `deadline_at` 的任务进入 `timeout`。

## v0.9 Long-Running Service Setup

The current stable path is still local-only:

```text
Discord Gateway Bot
  -> Agent Host API on 127.0.0.1:8787
  -> codex-bridge
  -> codex exec task with the workspace's configured mode
```

For long-running use, install user-level systemd services:

```bash
cd $HOME/Documents/My_App_Dev/mattermpst_chat
scripts/install_user_services.sh
```

Then edit the local secrets file:

```bash
nano ~/.config/agent-host/secrets.env
chmod 600 ~/.config/agent-host/secrets.env
```

Use this shape:

```bash
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=...
AGENT_HOST_TOKEN=...
```

Do not write `export DISCORD_BOT_TOKEN=...` in this file. `systemd` `EnvironmentFile` requires plain `KEY=value` lines.

The service unit files do not contain real token values. They load:

```text
EnvironmentFile=%h/.config/agent-host/secrets.env
```

Run checks before starting:

```bash
scripts/check_all.sh
```

Start and inspect services:

```bash
scripts/start_services.sh
scripts/status_services.sh
scripts/tail_logs.sh
```

Stop services:

```bash
scripts/stop_services.sh
```

Direct systemd commands:

```bash
systemctl --user status agent-host-web.service
systemctl --user status discord-agent-adapter.service
journalctl --user -u agent-host-web.service -f
journalctl --user -u discord-agent-adapter.service -f
```

The Agent Host service should remain bound to `127.0.0.1`; do not change it to `0.0.0.0` for this phase. Discord access works through the bot's outbound Gateway connection, so no public inbound HTTP endpoint is required.

## Service Safety Notes

- Keep `config.json`, `.env`, and `~/.config/agent-host/secrets.env` out of Git.
- `secrets.env` should be mode `600`.
- Discord adapter should use a non-admin Agent Host token when possible.
- Raw result/log access requires an admin token; Discord should use safe result/log output only.
- Use `codex-bridge cleanup --dry-run` before deciding any archive policy.

取消任务时，Web API 只负责认证和权限检查；真正的进程终止由独立 `codex-bridge` 完成。已结束状态：

```text
done / failed / cancelled / timeout / stale
```

再次 cancel 会返回明确错误，不会改写已结束任务。

Result / Logs 默认返回 safe 输出，而不是本地 raw artifact：

```text
result.md       原始 Codex 最终结果，本地保存
result.safe.md  脱敏后的展示版本
logs.safe.txt   脱敏后的日志摘要
```

默认 API：

```bash
curl -X POST http://127.0.0.1:8787/codex/result \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"task_id":"task_..."}'
```

日志支持 tail 和 max_chars：

```bash
curl -X POST http://127.0.0.1:8787/codex/logs \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"task_id":"task_...","tail":"200","max_chars":"20000"}'
```

返回中会带：

```json
{
  "redacted": true,
  "truncated": false,
  "raw": false
}
```

只有 `admin` token 可以明确请求 raw：

```json
{"task_id":"task_...","raw":"true"}
```

普通用户请求 `raw=true` 会返回 `403`。网页 Response 区域会渲染 safe Markdown，并保留 `Raw Safe Text` 视图。

实时任务流使用 SSE，不使用 WebSocket。因为浏览器 `EventSource` 不方便设置
`Authorization` header，所以先用 Bearer Token 换取一个短期 stream token：

```bash
curl -X POST http://127.0.0.1:8787/codex/stream-token \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"task_id":"task_..."}'
```

返回：

```json
{
  "ok": true,
  "task_id": "task_...",
  "stream_token": "short-lived-token",
  "expires_in": 300,
  "events_url": "/codex/events?task_id=task_...&stream_token=short-lived-token"
}
```

然后连接 SSE：

```bash
curl -N 'http://127.0.0.1:8787/codex/events?task_id=task_...&stream_token=short-lived-token'
```

事件类型：

```text
snapshot   连接建立时的任务快照
status     状态变化，例如 running / done / cancelled / timeout
log        新增 safe log 文本
result     safe result 已生成
done       任务进入最终状态后发送，随后关闭连接
heartbeat  保持连接活跃
error      认证、权限或读取错误
```

SSE 只推送 safe logs，默认不会推送 raw logs、真实项目路径、Bearer token、API key 或 private key。短期
stream token 只绑定一个 task，默认 5 分钟过期；没有权限访问该 task 的用户不能获取 stream token。服务日志会把
`stream_token=` 和 URL 中的 `token=` 脱敏。

## Adapter Contract

`mattermpst_chat` 现在承担的是本地 Agent Host API / Web Adapter 原型。未来 Web UI、Discord Bot、Mattermost
Adapter、Matrix 或 Email 入口，都应该调用同一套 Agent Host API：

```text
Message Adapter
  -> Agent Host API
  -> codex-bridge core
  -> codex exec
```

adapter 不应该：

- 直接执行 `codex exec`；
- 直接拼接 shell 命令；
- 直接读取或改写 `.codex-bridge/tasks/*/task.json`；
- 直接读取 raw `result.md` / raw logs；
- 绕过 Agent Host 的 token、用户权限、workspace 白名单、safe output、cancel/timeout 检查。

外部入口应先把消息转换成统一 Command Object，再交给 `/codex/run`：

```json
{
  "source": "web",
  "source_user_id": "chenma",
  "source_channel_id": "browser",
  "source_message_id": "submit-1",
  "workspace": "grokking",
  "mode": "readonly",
  "prompt": "请只读总结当前项目状态",
  "reference_task_id": "task_20260525_120000_abcdef",
  "idempotency_key": "web-20260524-xxxx",
  "metadata": {
    "client": "web-ui"
  }
}
```

其中用户身份仍然来自 Bearer Token，不接受请求体里的 `user` / `user_name` / `user_id` / `internal_user`。
`source_*` 是外部入口的审计信息，不是授权依据。

`reference_task_id` 是可选的链式上下文字段。外部入口可以把上一个任务的 `task_id` 放在这里，Agent Host 会先检查当前用户是否有权访问该任务，然后再交给 `codex-bridge`。执行时只会注入上一个任务的 safe result 摘要，不会注入 raw result 或 raw logs。

`idempotency_key` 用来避免重复提交：同一个 authenticated user + source + idempotency_key 如果已经创建过
task，`codex-bridge` 会直接返回原来的 `task_id`，不会重复创建任务。

API 错误统一返回：

```json
{
  "ok": false,
  "error": {
    "code": "permission_denied",
    "message": "User is not allowed to access this workspace.",
    "details": {}
  },
  "text": "User is not allowed to access this workspace."
}
```

当前错误码包括：

```text
unauthorized
permission_denied
workspace_not_found
task_not_found
task_already_finished
invalid_request
internal_error
```

本地模拟投递任务：

```bash
curl -X POST http://127.0.0.1:8787/mattermost/watchdog \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'token=replace-with-mattermost-slash-command-token' \
  --data-urlencode 'user_name=chenma' \
  --data-urlencode 'user_id=u1' \
  --data-urlencode 'channel_id=c1' \
  --data-urlencode 'channel_name=codex-control' \
  --data-urlencode 'command=/watchdog' \
  --data-urlencode 'text=task grokking 请分析最新 A0 曲线并说明下一步'
```

支持的 MVP 命令：

```text
/watchdog task <project> <任务内容>
/watchdog status <project>
/watchdog brief <project>
/watchdog inbox <project>
/watchdog run-once <project> <原因>
/watchdog help
```

注意：`run-once` 在当前原型里也只是写入 `agent/inbox/`，由 watchdog 下一轮自己判断，不会由 bridge 直接执行。

## 目标

这个项目的核心目标不是让 Mattermost 直接控制 shell，也不是让聊天室里一句话直接改代码或启动训练。

更安全、更适合长期使用的设计是：

```text
Mattermost 消息
  -> codex-bridge
  -> 写入项目 agent/inbox/
  -> watchdog 定时醒来读取任务
  -> watchdog 根据 PLAN / TODO / STATE / SAFETY 判断
  -> 执行、拒绝、或要求人工确认
  -> 结果回发 Mattermost
```

也就是说，Mattermost 是“任务入口”和“控制台”，watchdog 仍然是安全判断和执行主体。

## 为什么不直接执行

不要做成：

```text
Mattermost 一句话
  -> 直接执行 shell
  -> 直接让 Codex 改代码
```

原因很简单：Codex 可以读文件、改文件、运行命令。如果聊天室消息能直接变成命令，就会把身份认证、路径隔离、任务审批、命令白名单都绕开。

正确做法是让聊天室消息先变成“受控任务单”。

## MVP 功能

第一版建议实现 5 个命令：

```text
/watchdog status grokking
/watchdog task grokking <任务内容>
/watchdog brief grokking
/watchdog run-once grokking
/watchdog inbox grokking
```

其中最重要的是：

```text
/watchdog task grokking ...
```

它只负责把任务投递给 watchdog，不直接执行危险动作。

## 任务文件格式

Mattermost bridge 收到任务后，写入目标项目：

```text
agent/inbox/2026-05-17TxxxxxxZ_mattermost_task.json
```

示例：

```json
{
  "source": "mattermost",
  "user": "chenma",
  "project": "grokking",
  "request": "继续研究 p=97 实验结果，并给我一个零基础解释",
  "mode": "task_request",
  "created_at": "2026-05-17T13:00:00Z",
  "mattermost": {
    "team_id": "xxx",
    "channel_id": "xxx",
    "user_id": "xxx",
    "command": "/watchdog"
  }
}
```

watchdog 下一轮醒来后读取这个文件，决定怎么处理。

## Watchdog 处理逻辑

watchdog 应按以下顺序判断：

1. 任务是否来自白名单 Mattermost 用户。
2. project 名称是否映射到白名单目录。
3. 任务是否在当前项目安全边界内。
4. 是否需要写文件、跑训练、联网、装包、删除文件或改系统状态。
5. 如果是安全只读任务，直接执行。
6. 如果是已授权 allowlist 动作，例如 Grokking 的 exact p=97 训练命令，按 preflight 执行。
7. 如果超出边界，生成 `pending_review`，不要执行。

## 审批流

后续可以加入：

```text
/watchdog approve task-123
/watchdog reject task-123
```

示例：

```text
任务 task-123 需要确认：
它会运行 p=97 GPU 训练，预计最多 120 分钟。
回复 /watchdog approve task-123 执行。
```

审批结果可以写入：

```text
agent/inbox/task-123.approved.json
agent/inbox/task-123.rejected.json
```

## 安全边界

第一版必须坚持：

- 只允许白名单用户。
- 只允许白名单项目目录。
- Mattermost 不能传任意 shell。
- 默认只读。
- 写操作必须在项目 allowlist 内。
- 不允许 `sudo`。
- 不允许删除文件。
- 不允许访问密钥、浏览器缓存、`~/.ssh` 等敏感目录。
- 不允许 kill / restart 训练进程。
- 不允许绕过 Codex sandbox。
- 所有任务必须记录输入、决策和输出。

## 推荐分阶段路线

### 第一阶段：任务投递

实现：

```text
Mattermost /watchdog task
  -> codex-bridge
  -> agent/inbox/*.json
```

watchdog 只读取任务并报告“收到/拒绝/需要确认”。

### 第二阶段：只读任务

允许：

```text
/watchdog status grokking
/watchdog brief grokking
/watchdog inbox grokking
```

这些任务只读项目文件和报告，不改代码，不启动训练。

### 第三阶段：安全 allowlist 动作

允许 watchdog 根据项目策略执行已经批准的 exact command。

例如 Grokking 项目中：

```text
exact allowlisted p=97 training command
```

但仍然要满足：

- 没有活跃训练进程；
- 没有 partial output；
- policy valid/enabled；
- command 完全匹配 allowlist；
- lock 可以获取；
- GPU 和时长在批准范围内。

### 第四阶段：Mattermost 审批

危险或边界不清晰的任务不执行，只发回 Mattermost 请求审批。

### 第五阶段：多项目控制台

最终 Mattermost 可以成为多个 watchdog 项目的统一控制台：

```text
#codex-control
#codex-report
#codex-alert
#training-status
#research-log
```

## 对当前 Grokking 项目的改造点

需要在 Grokking watchdog 中加入：

```text
agent/inbox/
agent/tasks/
```

并修改：

- `agent/bin/collect_status.sh`：把最新 inbox 任务放进 snapshot。
- `agent/prompts/wakeup.md`：告诉 watchdog 每轮必须处理 inbox 任务。
- `agent/bin/run_watchdog.sh`：根据输出把任务标记为 done / rejected / pending_review。
- `codex-bridge`：接收 Mattermost slash command，写入 inbox。

## 结论

这个功能完全可以实现。

推荐原则是：

```text
Mattermost 负责投递任务；
watchdog 负责安全判断；
Codex 负责执行被允许的工作；
Mattermost 再接收结果。
```

这样 Mattermost 就不是一个危险的远程 shell，而是一个受控的“项目任务入口”。
