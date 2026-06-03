# Server-side Codex 学习同步（2026-06-03）

## 1) 本轮代码同步：最新远端提交

- 提交：`7655ec4`
- 标题：`Fix watchdog schema and stale result routing`
- 变更范围：`modules/codex-watchdog-vscode/`

### 变更文件

- `modules/codex-watchdog-vscode/extension.js`
- `modules/codex-watchdog-vscode/package.json`
- `modules/codex-watchdog-vscode/README.md`
- `modules/codex-watchdog-vscode/tests/generated-template.test.js`

### 变更要点

1. 修复 watchdog 生成 schema 的 `required` 字段缺失问题
   - 补齐 `supervisor_mode`、`review_scope`、`review_resolver` 到 required 列表
   - 避免生成的模板在 `supervisor` 字段缺失时出现 schema 兼容问题

2. 强化 route 决策的过期防抖
   - 在 `route_skill.py` 增加 `WATCHDOG_QUEUE_RESULT_FRESH_MINUTES`
   - `done` 路径中的旧结果文件过期后会跳过 `watchdog-gate-evaluator`
   - 目的：避免历史结果反复触发导致 repeated gate / 再调度风暴

3. 默认环境与迁移行为增强
   - 在 `README.md` 中新增环境变量说明及 CODEX_HOME 刷新建议
   - 明确提示更改 CODEX_HOME 后需重装 timer/service

4. 测试增强
   - 在 `tests/generated-template.test.js` 增加 required 字段一致性测试
   - 增加 done 文件过期情况下路由行为回归测试

5. 版本号提升
   - `package.json` 版本更新为 `0.1.47`

---

## 2) 可复用逻辑（建议落地到 server-side 运行策略）

1. watch/watchdog 里要避免“陈旧状态反复触发”
   - 核心规则：结果文件要有时效窗（freshness），超过窗口不应触发关键修复逻辑

2. schema 约束要完整
   - 任务元信息新增/变更时，必须保持 `required` 与 `properties` 一致
   - 避免后续路由器对默认字段缺失的脆弱依赖

3. 生成产物与运行时状态要对齐
   - 路由器使用的模板字段必须经过统一测试覆盖
   - 建议每次改动都加最小回归测试，优先覆盖边界路径（特别是重复触发场景）

---

## 3) 对 supervisor + watchdog 自主性的启发

- 该提交并非直接提高“决策智能”，但对稳定自主运行的价值很大：
  - 降低了 stale done 结果导致的重复 block/re-run
  - 提高了路由 schema 的可预测性，减少 supervisor 路径误判

- 建议 server-side 在后续迭代中继续保持这个方向：
  - 默认保守、可执行路径必须有“时间/范围”边界
  - 只对可验证、安全、非共享副作用动作自动恢复
  - 高危动作保持审批边界

---

## 4) 与你当前执行规则的匹配

你现在的主准则是：

- watchdog 尽量自主
- 只有真正危险的事情才等人

该规则在本次提交后更易落地，因为我们减少了无意义的 stale-trigger，并把生成/路由基础行为变得更“稳”。

---

## 5) server-side 落地 checklist

1. 拉取最新提交：`7655ec4`
2. 在各项目重新生成 watchdog 模板（或触发对应重装流程）
3. 检查 `WATCHDOG_QUEUE_RESULT_FRESH_MINUTES` 覆盖你们环境的结果生命周期
4. 用 1~2 轮历史 done 场景做回归，确认不会反复触发旧 blocker
5. 验证新增 required 字段在实际模板 JSON 上存在并为非空

