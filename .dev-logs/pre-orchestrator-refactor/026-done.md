# 026-done: Doc Schema Guidance 完成

## 概述

实现文档产出约束前置（Doc Schema Guidance）系统，让所有角色在写文档之前就知道结构要求和内容边界，消除"盲写 → 打回 → 重试"的浪费模式。

## 完成内容

### Step 1: Schema 文件扩展

- `src/core/types.ts` — `DocSchema` 接口新增 `guidance?: string` 字段
- `workflows/dev/schemas/*.json` — 全部 26 个 schema 文件新增 `guidance` 字段，描述内容边界

### Step 2: formatSchemaGuidance 函数

- `src/core/schema.ts` — 新增 `formatSchemaGuidance(docId, docDef, schema, scale, stepSchemas?)` 函数
  - 按当前 scale 过滤必需章节/字段
  - 输出格式、最小长度、guidance 文本
  - 支持 steps 约束展示（medium/large 规模）
- 新增 `StepSchemaEntry` 接口，供外部模块传入 step schema 数据

### Step 3: role_dispatch 注入 Document Requirements

- `src/tools/dispatch-role.ts` — 新增 `buildDocRequirements()` 函数
  - 遍历 expectedOutputs，加载每个文档的 schema（含 step schemas）
  - 调用 `formatSchemaGuidance` 生成可读约束
  - 插入到 dispatch 数据包的 Role Prompt 之前
  - 仅在 scale 已设定时生效

### Step 4: doc_schema 查询工具

- `src/tools/doc-schema.ts` — 新文件，实现 `doc_schema(project_name, doc_id, step?)` MCP 工具
  - 完整文档查询：返回主 schema + 所有 step schemas 的可读指引
  - 单步查询：指定 step 时只返回该 step 的 schema
  - 错误处理：doc 不存在、step 不存在、scale 未设定
- `src/index.ts` — 注册 `registerDocSchema`

### Step 5: PM prompt 规则

- `src/setup/templates.ts` — 在 Workflow Guide 下新增 "Document Writing Rules" 章节
  - 指导 PM 在写文档前调用 `doc_schema` 查询约束

### Step 6: 角色 prompt 规则

- `workflows/dev/roles/architect.md` — 行为规则新增第 5 条：遵守文档要求
- `workflows/dev/roles/tester.md` — 行为规则新增第 5 条：遵守文档要求

### Step 7: 测试

- `tests/schema-guidance.test.ts` — 15 个测试覆盖 `formatSchemaGuidance`
  - 基本输出、scale 过滤、section/HTML/JSON 字段、step schemas、边界情况
- `tests/doc-schema.test.ts` — 11 个测试覆盖 `doc_schema` 工具
  - 完整查询、step 查询、错误处理、scale 未设定

## 两条注入路径

| 路径                     | 覆盖角色                                         | 机制                                        |
| ------------------------ | ------------------------------------------------ | ------------------------------------------- |
| `role_dispatch` 自动注入 | 架构师、测试员、开发者（所有被 dispatch 的角色） | 数据包中自动包含 Document Requirements 板块 |
| `doc_schema` 工具        | PM（不经过 dispatch）                            | PM 手动调用查询，prompt 中有行为规则提醒    |

## 验证结果

- `npx tsc --noEmit` — 零错误
- `npx vitest run` — 18 文件 / 314 测试全部通过（+26 新测试）
- Commit: `58789be`，已推送到 `develop`

## 影响范围

| 文件                                 | 变更类型 |
| ------------------------------------ | -------- |
| `src/core/types.ts`                  | 修改     |
| `src/core/schema.ts`                 | 修改     |
| `src/tools/dispatch-role.ts`         | 修改     |
| `src/tools/doc-schema.ts`            | 新增     |
| `src/index.ts`                       | 修改     |
| `src/setup/templates.ts`             | 修改     |
| `workflows/dev/roles/architect.md`   | 修改     |
| `workflows/dev/roles/tester.md`      | 修改     |
| `workflows/dev/schemas/*.json` (×26) | 修改     |
| `tests/schema-guidance.test.ts`      | 新增     |
| `tests/doc-schema.test.ts`           | 新增     |
