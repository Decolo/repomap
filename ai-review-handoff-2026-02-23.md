# AI Code Review 讨论导出（2026-02-23）

## 1. 讨论共识
- AI 代码审查应被设计成“风险控制系统”，不是只靠 PR 人工阅读。
- 人工审查应该按风险分层介入（human by exception），高风险强制人工，低风险自动化优先。
- 在 2026 年，代码生成更便宜，但“正确上下文检索”仍是质量瓶颈。
- 你过去的 Tree-sitter + repomap + diff 关联排序经验，仍是核心竞争力。

## 2. 建议的总体架构（3 层）
1. `Indexer`：把仓库增量索引为图。
2. `Retriever`：以 PR diff 为种子做图检索与排序。
3. `Review Orchestrator`：多阶段审查并输出可执行结论。

### 2.1 Indexer（离线/增量）
- 节点：`file`、`symbol`、`test`、`api_endpoint`、`db_table`、`migration`、`owner`。
- 边：`calls`、`imports`、`inherits`、`test_covers`、`touches_table`、`defines_endpoint`、`owned_by`。
- 属性：`criticality`、`churn`、`risk_tag(auth/payment/data_delete)`、`incident_related`。

### 2.2 Retriever（PR 实时）
- 从 diff 提取 seed（改动文件/符号/API/schema）。
- 用 Personalized PageRank（或随机游走重启）做图排序。
- 叠加风险分：跨边界、测试缺口、关键模块等。
- 固定上下文包：`Primary`、`Causal`、`Contract`、`Guardrail`。

建议初版评分：
`FinalScore = 0.45*PPR + 0.25*Risk + 0.15*BoundaryImpact + 0.10*TestGap + 0.05*Freshness`

### 2.3 Orchestrator（审查编排）
1. Deterministic gates：lint/type/test/security/policy 先跑。
2. LLM correctness pass：逻辑与边界条件。
3. LLM security pass：权限、注入、敏感数据路径。
4. LLM reliability pass：并发、幂等、回滚与观测点。
5. Decision engine：按严重度、置信度、风险等级决定评论/拦截/人工升级。

finding 输出结构建议：
- `severity`
- `claim`
- `evidence (file:line + graph path)`
- `repro_or_test`
- `suggested_fix`
- `confidence`

## 3. 如何衡量 repomap 的价值

### 3.1 A/B 对照原则
- 保持模型、prompt、规则、token 预算一致。
- 唯一变量：是否启用 repomap 检索。
- 分层随机：按语言、仓库、风险等级分层。

### 3.2 关键指标（质量 + 效率）
- `Precision`：真阳性占比。
- `High-risk Recall`：高风险问题召回。
- `Noise Rate`：误报/重复建议占比。
- `Actionable Rate`：被采纳并形成修改的比例。
- `Escaped Defect Rate`：合并后缺陷外逸率。
- `Latency`：审查时延变化。

### 3.3 客观证据（尽量少依赖主观打分）
- `Hit@K`、`MRR`、`nDCG@K`。
- `Coverage@Budget`（固定 token 预算下的关键覆盖率）。
- `Cost per True Finding`（单位真阳性的 token/时间成本）。

### 3.4 建议判定门槛（连续两周）
- `nDCG@20` 提升 >= 15%
- `High-risk Recall` 提升 >= 12%
- `Cost per True Finding` 下降 >= 10%
- `Median Latency` 增幅 <= 5%

## 4. 业界工具与路径（讨论结论）
- 显式 repo map：Aider、Continue（文档明确）。
- 主流 coding agent 常不公开底层检索细节；不少强调 agentic search（Read/Grep/Glob/Bash）。
- Vercel AI SDK 是框架层，支持自建 RAG/context middleware，不是默认 repo map code reviewer。

## 5. 你当前能力的定位
- 你在“上下文治理层（context spine）”有明显优势。
- 最优策略通常是“通用模型推理 + 自定义图谱检索供给”，而不是二选一。
- 未来即使更换模型，repomap 和检索策略仍可复用。

## 6. 建议的 1-2 周 PoC 范围
1. 只覆盖 1-2 门主语言。
2. 先做 2 类高风险域（如 auth + data integrity）。
3. suggestion-only（先不阻塞 merge）。
4. 每周复盘误报/漏报，优先调检索权重和阈值。

## 7. 下一步执行清单（可直接开工）
1. 定义图 schema（node/edge/attr）并落地增量更新。
2. 接入 PR diff seed 抽取与 PPR 排序。
3. 定义 finding schema 与 comment 模板（含证据链）。
4. 建立 A/B 开关与指标埋点。
5. 跑首周 shadow mode，输出第一版评估报告。
