# 015 — P3 Sequential Mode 设计方案

**日期**: 2026-03-16
**类型**: 设计方案
**状态**: 设计完成，待实现

## 目标

对关键产出（PRD、技术方案、任务拆解）拆分为多个可检查的步骤，每步独立执行、独立校验。将"单次产出完整文档"的黑盒模式改为"分步产出、逐步校验"的白盒模式。

## 适用范围

| 文档           | Steps | 适用 scale    |
| -------------- | ----- | ------------- |
| PRD            | 4步   | medium, large |
| tech-design    | 4步   | medium, large |
| task-breakdown | 4步   | medium, large |

**不适用**：small scale、ADR、retrospective 等独立文档。

## 设计决策

| 决策项       | 选择                       | 理由                                             |
| ------------ | -------------------------- | ------------------------------------------------ |
| 工具接口     | write_doc + 可选 step 参数 | agent 不需学新工具，向后兼容                     |
| 中间产物格式 | 混合（per-step 自定义）    | 结构化步骤用 JSON，文档步骤用 md                 |
| 顺序强制     | 硬性强制                   | step N 未完成不可写 step N+1                     |
| 最终合并     | 自动合并                   | 最后一步完成时自动写入正式文档路径 + 触发 review |

## 数据模型

### 1. workflow.json — DocDefinition 增加 steps

```json
{
  "prd": {
    "name": "需求文档",
    "scale": { "small": "lite", "medium": "full", "large": "full" },
    "review": true,
    "steps": [
      {
        "id": "requirements",
        "name": "需求结构化",
        "format": "json",
        "description": "将用户需求整理为结构化 JSON：功能列表、优先级、约束"
      },
      {
        "id": "completeness-check",
        "name": "完整性校验",
        "format": "json",
        "description": "检查需求覆盖率、遗漏项、冲突项，输出校验报告"
      },
      {
        "id": "draft",
        "name": "PRD 文档草稿",
        "format": "md",
        "description": "基于结构化需求生成完整 PRD 文档"
      },
      {
        "id": "final",
        "name": "PRD 最终版",
        "format": "md",
        "description": "根据校验结果修订，产出最终 PRD"
      }
    ]
  }
}
```

### 2. types.ts — 新增类型

```typescript
/** Step definition within a doc (for sequential mode) */
export interface DocStepDefinition {
  /** Step ID, e.g. "requirements", "draft", "final" */
  id: string;
  /** Human-readable name */
  name: string;
  /** Output format: "json" or "md" */
  format: 'json' | 'md';
  /** Description shown to agent */
  description: string;
}

/** Step completion record in steps.json */
export interface DocStepRecord {
  /** Step ID */
  stepId: string;
  /** When this step was completed */
  completedAt: string;
  /** File path of the step artifact */
  artifactPath: string;
}

/** Per-doc step tracking */
export interface DocStepState {
  /** Doc ID */
  docId: string;
  /** Completed steps */
  completedSteps: DocStepRecord[];
  /** Whether the final doc has been written */
  finalized: boolean;
  /** Finalized at timestamp */
  finalizedAt?: string;
}
```

### 3. Step 状态存储

存储在 `<data_dir>/<project_name>/steps.json`：

```json
{
  "docs": {
    "prd": {
      "docId": "prd",
      "completedSteps": [
        { "stepId": "requirements", "completedAt": "...", "artifactPath": "docs/prd.requirements.json" },
        { "stepId": "completeness-check", "completedAt": "...", "artifactPath": "docs/prd.completeness-check.json" }
      ],
      "finalized": false
    }
  }
}
```

### 4. Step 中间产物文件命名

`docs/<doc_id>.<step_id>.<ext>`

- `docs/prd.requirements.json` — step 1 产物
- `docs/prd.completeness-check.json` — step 2 产物
- `docs/prd.draft.md` — step 3 产物
- `docs/prd.md` — 最终合并产物（覆盖正式文档）

### 5. Step Schema 文件

Schema 目录增加 per-step schema：

```
workflows/dev/schemas/
├── prd.json                      ← 现有：最终文档 schema
├── prd.requirements.json         ← 新增：step schema
├── prd.completeness-check.json   ← 新增
├── prd.draft.json                ← 新增
├── prd.final.json                ← 新增（= prd.json 的复用）
├── tech-design.json
├── tech-design.analysis.json
├── ...
```

命名规则：`<doc_id>.<step_id>.json`

## 工具行为变更

### write_doc 参数变化

```typescript
{
  project_name: z.string(),
  doc_id: z.string(),
  content: z.string(),
  step: z.string().optional()  // ← 新增
}
```

### 核心逻辑

```
if (docDef.steps && scale >= medium) {
  // Sequential 模式

  if (!step) {
    → 错误："此文档需要分步写入，请指定 step 参数。可用的 step: ..."
  }

  if (step 不在 docDef.steps 中) {
    → 错误："未知的 step"
  }

  if (前置 step 未完成) {
    → 错误："请先完成 step X"（硬性强制）
  }

  if (step 已完成) {
    → 允许覆盖（支持回退修正），但清除该 step 之后的所有已完成 step 记录
  }

  // 校验 step schema
  schema = loadDocSchema(workflowsDir, workflowName, `${docId}.${stepId}`)
  if (schema && !valid) → 拒绝

  // 写入中间产物
  writeStepArtifact(projectName, docId, stepId, content, stepDef.format)
  recordStepCompletion(projectName, docId, stepId, artifactPath)

  if (是最后一个 step) {
    // 自动合并：写入正式文档路径
    writeDoc(projectName, docId, content, docDef)
    // 正常 schema 校验（使用 final doc schema）
    // 正常 review 流程
    markFinalized(projectName, docId)
  }
} else {
  // 无 steps 或 small scale：行为不变
  // 直接写入正式文档
}
```

### 覆盖写入与回退

当重新写入一个已完成的 step 时：

1. 该 step 之后的所有已完成 step 记录被清除
2. 对应的中间产物文件 **不删除**（仅清除 steps.json 中的记录）
3. 如果 finalized=true，重置为 false

这实现了 011 proposal 中"打回只回退到出问题的步骤"的设计目标。

## 与现有系统的交互

### Schema 集成

- `loadDocSchema()` 已支持按 `docId` 加载，只需对 step 场景改为加载 `${docId}.${stepId}`
- 最终 step 的 schema 复用 final doc 的 schema（`prd.final.json` 内容 = `prd.json`）

### Review 集成

- Review 只在最终合并时触发，中间 step 不触发 review
- 行为与当前完全一致

### Guards 集成

- P1 的 `update_phase` completion guard 检查文档产出时，检查的是正式文档路径（`docs/prd.md`）
- Sequential mode 通过自动合并保证：最终 step 完成 → 正式文档存在 → guard 检查通过
- 无需修改 guards 代码

### Override

- 未来可通过 override 配置关闭 Sequential mode（`sequential: false`）
- 本次不实现 override 开关，所有有 steps 定义且 scale >= medium 的文档强制 Sequential

## 文件变更清单

| 文件                          | 变更                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `src/core/types.ts`           | +DocStepDefinition, +DocStepRecord, +DocStepState, DocDefinition 加 steps?       |
| `src/core/docs.ts`            | +writeStepArtifact, +readStepArtifact                                            |
| `src/core/steps.ts`           | **新文件**：step 状态管理（readSteps, recordStep, clearStepsAfter, isFinalized） |
| `src/core/schema.ts`          | loadDocSchema 支持 step schema 路径                                              |
| `src/tools/doc-tools.ts`      | write_doc 增加 step 参数 + sequential 逻辑                                       |
| `workflows/dev/workflow.json` | prd, tech-design, task-breakdown 增加 steps 字段                                 |
| `workflows/dev/schemas/`      | 新增 ~12 个 per-step schema JSON                                                 |
| `tests/steps.test.ts`         | **新文件**：step 状态管理测试                                                    |
| `tests/sequential.test.ts`    | **新文件**：write_doc sequential 模式集成测试                                    |

## Steps 定义（三个文档）

### PRD (4 steps)

1. **requirements** (JSON) — 需求结构化：功能列表、优先级、约束条件
2. **completeness-check** (JSON) — 完整性校验：遗漏项、冲突项、覆盖率
3. **draft** (md) — PRD 文档草稿
4. **final** (md) — PRD 最终版

### tech-design (4 steps)

1. **analysis** (JSON) — 架构分析：现有代码结构、技术约束、可行方案
2. **api-contract** (JSON) — API 契约定义：端点、请求/响应格式
3. **draft** (md) — 技术方案草稿
4. **final** (md) — 技术方案最终版

### task-breakdown (4 steps)

1. **coarse** (JSON) — 粗粒度拆分：主要任务块、预估工作量
2. **dependencies** (JSON) — 依赖分析：任务间依赖关系、执行顺序
3. **detailed** (md) — 细化为可执行任务
4. **final** (md) — 任务拆解最终版
