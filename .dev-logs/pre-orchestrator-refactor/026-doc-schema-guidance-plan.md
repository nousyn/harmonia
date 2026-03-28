# 026 - 文档产出约束前置（Doc Schema Guidance）

> 日期: 2026-03-18
> 状态: 计划

## 背景

当前所有角色在产出文档时，完全不知道文档的结构约束。Schema 校验仅存在于 `doc_write` 的运行时实现中，采用"先写再拒"的反应式模式——agent 盲写 → 校验失败打回 → 根据错误修改 → 重新提交。

问题：

1. **浪费 token** — 每次打回都是一轮无效交互，分步写入时更严重（4 步 × 可能多轮打回）
2. **无法约束"不该写什么"** — schema 只做正向结构校验，不会告诉 agent 内容边界（如"PRD 不应包含技术方案"）
3. **全部 13 个文档 + 12 个 step schema，全部是盲写**

## 方案概述

两条路径覆盖所有角色：

- **非 PM 角色**（通过 dispatch 启动）：`role_dispatch` 数据包自动注入目标文档的约束信息
- **PM 角色**（不经过 dispatch）：PM prompt 增加行为规则 + `doc_schema` 查询工具

## 实施步骤

### Step 1: Schema 文件扩展 — 新增 guidance 字段

为所有 26 个 schema 文件新增可选 `guidance` 字段（自由文本），描述该文档的内容边界和写作指引。

修改文件：

- `src/core/types.ts` — `DocSchema` 接口新增 `guidance?: string`
- `workflows/dev/schemas/*.json` — 所有 schema 文件新增 guidance 内容

guidance 示例：

```json
// prd.json
"guidance": "PRD 描述产品需求（做什么），不涉及技术实现（怎么做）。技术选型、架构设计属于 tech-design 文档。"

// tech-design.json
"guidance": "技术方案描述如何实现需求，包括架构决策和技术选型。不重复 PRD 中的需求描述。"

// prd.requirements.json (step)
"guidance": "将用户需求结构化为 JSON，提取功能列表和约束条件。只做需求提取，不做技术分析。"
```

### Step 2: formatSchemaGuidance 函数

新增核心函数，将 JSON schema 转换为人类可读的写作指引。

新增文件：

- `src/core/schema.ts` 中新增 `formatSchemaGuidance(docId, docDef, schema, scale, stepSchemas?)` 函数

功能：

- 按当前 scale 过滤，只列出当前规模下必需的章节/字段
- 输出格式要求（md / html / json）
- 输出最小长度要求
- 输出 guidance 文本（如有）
- 如果文档有 steps 且 scale >= medium，列出每个 step 的约束（step schema 的要求 + guidance）

输出示例（PRD, scale=medium）：

```
## 文档要求: 需求文档 (prd)

格式: Markdown
最小长度: 200 字符
内容指引: PRD 描述产品需求（做什么），不涉及技术实现（怎么做）。技术选型、架构设计属于 tech-design 文档。

### 必需章节
- 项目概述
- 功能需求
- 非功能需求
- 验收标准

### 分步写入（medium/large 规模）
1. requirements（需求结构化）— JSON 格式
   必需字段: features (array, ≥1 项), constraints (array), priorities (object), scope (string)
   指引: 将用户需求结构化为 JSON，提取功能列表和约束条件。只做需求提取，不做技术分析。
2. completeness-check（完整性校验）— JSON 格式
   必需字段: coverage (object), missing (array), conflicts (array), verdict (string)
3. draft（PRD 文档草稿）— Markdown 格式
   必需章节: 项目概述, 功能需求
4. final（PRD 最终版）— Markdown 格式
   必需章节: 项目概述, 功能需求, 非功能需求, 验收标准
```

### Step 3: role_dispatch 注入文档约束

修改 `src/tools/dispatch-role.ts`，在返回的数据包中新增 `## Document Requirements` 板块。

逻辑：

1. 已有 `expectedOutputs` 列表（当前阶段需要产出的非 external 文档 ID）
2. 遍历 expectedOutputs，加载每个文档的 schema（含 step schemas）
3. 调用 `formatSchemaGuidance` 生成可读约束
4. 插入到返回的 summary 中（在 Role Prompt 之前）

这样所有通过 dispatch 启动的角色（架构师、测试员、未来的新角色），在收到任务时就已经知道要写什么结构的文档。

### Step 4: doc_schema 查询工具

新增 MCP 工具 `doc_schema(project_name, doc_id, step?)`。

新增文件：

- `src/tools/doc-schema.ts`

功能：

- 加载指定文档的 schema，调用 `formatSchemaGuidance` 返回可读约束
- 如果指定了 step 参数，只返回该 step 的 schema 约束
- 不指定 step 时返回完整的文档约束（含所有 step）

注册：

- `src/index.ts` 中注册 `registerDocSchema`

### Step 5: PM prompt 增加行为规则

修改 `src/setup/templates.ts`，在 PM prompt 的 Workflow Guide 中加入：

```
### Document Writing Rules

产出文档前，先调用 `doc_schema(project_name, doc_id)` 查询该文档的结构要求和内容边界，确保一次性写出符合要求的文档。
```

位置：放在 Phase 1 说明之前，作为通用规则适用于所有阶段的文档产出。

### Step 6: 角色 prompt 增加行为规则

修改 `workflows/dev/roles/architect.md` 和 `workflows/dev/roles/tester.md`，在行为规则中加入：

```
N. **遵守文档要求**：按照 dispatch 数据包中的 Document Requirements 章节产出文档，确保包含所有必需章节
```

作为提示强化，配合 dispatch 自动注入。

### Step 7: 测试

- `formatSchemaGuidance` 单元测试：不同 scale、有/无 steps、有/无 guidance 的输出验证
- `doc_schema` 工具测试：正常查询、带 step 查询、不存在的 doc_id
- `role_dispatch` 集成验证：确认返回的数据包中包含 Document Requirements 板块

### Step 8: 构建验证 + 提交推送

- `npx tsc --noEmit` 零错误
- `npx vitest run` 全部通过
- 提交到 develop 分支

## 影响范围

| 文件                                 | 变更类型                              |
| ------------------------------------ | ------------------------------------- |
| `src/core/types.ts`                  | 修改 — DocSchema 新增 guidance 字段   |
| `src/core/schema.ts`                 | 修改 — 新增 formatSchemaGuidance 函数 |
| `src/tools/dispatch-role.ts`         | 修改 — 注入 Document Requirements     |
| `src/tools/doc-schema.ts`            | 新增 — doc_schema 查询工具            |
| `src/index.ts`                       | 修改 — 注册新工具                     |
| `src/setup/templates.ts`             | 修改 — PM prompt 新增规则             |
| `workflows/dev/roles/architect.md`   | 修改 — 行为规则强化                   |
| `workflows/dev/roles/tester.md`      | 修改 — 行为规则强化                   |
| `workflows/dev/schemas/*.json` (×26) | 修改 — 新增 guidance 字段             |
| `tests/schema-guidance.test.ts`      | 新增 — formatSchemaGuidance 测试      |
| `tests/doc-schema.test.ts`           | 新增 — doc_schema 工具测试            |

## 设计原则

1. **单一数据源** — schema JSON 文件是唯一的约束定义，所有注入点从同一数据源读取
2. **按需精准** — dispatch 只注入当前任务需要的文档约束，doc_schema 按需查询
3. **事前告知 + 事后校验** — 两层保障，事前减少盲写，事后兜底防漏
4. **零维护增量** — 未来新增文档类型只需新增 schema 文件，注入逻辑自动覆盖
