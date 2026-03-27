# Output Formats

Complete schema definitions for all Harmonia artifact types.

## Contents

- [PRD (prd.json)](#prd)
- [Tech Design (tech-design.json)](#tech-design)
- [API Design (api-design.json)](#api-design)
- [Data Model (data-model.json)](#data-model)
- [Task Breakdown (task-breakdown.json)](#task-breakdown)
- [Test Plan (test-plan.json)](#test-plan)

---

## PRD (prd.json)

### Markdown Structure

```markdown
## 项目概述

<!-- 产品背景、目标用户、核心价值 -->

## 功能需求

<!-- 功能列表，每个功能包含：标题、描述、优先级 -->

## 非功能需求

<!-- 性能、安全、兼容性等 -->

## 验收标准

<!-- 可量化的验收条件 -->

## 约束与假设

<!-- 技术约束、资源约束、前提假设 -->
```

### Schema Definition

From `schemas/prd.json`:

- `sections`: Required section headings with aliases
- `minLength`: 200 characters minimum
- `guidance`: Writing guidance

### Writing Guidelines

1. **Scope boundary**: PRD 描述产品需求（**做什么**），不涉及技术实现（**怎么做**）
2. **Content focus**: 目标用户、核心价值、功能列表、验收标准
3. **Excluded content**: 技术选型、架构设计、代码实现方案属于 tech-design 文档
4. **Quality check**: 每个功能应包含标题、描述、优先级

---

## Tech Design (tech-design.json)

### Markdown Structure

```markdown
## 架构概述

<!-- 整体架构思路、分层设计 -->

## 技术选型

<!-- 技术栈、框架选择及其理由 -->

## 模块设计

<!-- 模块划分、职责定义 -->

## 架构决策

<!-- 关键技术决策及其理由 -->

## 风险评估

<!-- 技术风险、缓解方案 -->
```

### Schema Definition

From `schemas/tech-design.json`:

- `sections`: Required section headings with aliases
- `minLength`: 200 characters minimum
- `guidance`: Writing guidance

### Writing Guidelines

1. **Scope boundary**: 技术方案描述如何实现需求（**怎么做**）
2. **Content focus**: 架构概述、技术选型、模块设计、架构决策、风险评估
3. **Architecture priority**: 接口设计和数据模型已拆为独立产出，此处聚焦架构层面
4. **Decision rationale**: 每个架构决策需说明理由和权衡

---

## API Design (api-design.json)

### Markdown Structure

```markdown
## 模块划分与职责

<!-- 模块划分、每个模块的职责范围 -->

## 公共方法签名

<!-- 内部模块 API：方法名、参数、返回值、异常 -->

## 模块间依赖与调用关系

<!-- 模块间调用图、依赖关系 -->

## 数据流转路径

<!-- 关键数据在模块间的流转方式 -->
```

### Schema Definition

From `schemas/api-design.json`:

- `sections`: Required section headings with aliases
- `minLength`: 100 characters minimum
- `guidance`: Writing guidance

### Writing Guidelines

1. **Scope boundary**: 内部模块 API 设计，不含对外 HTTP 接口
2. **Content focus**: 模块划分与职责、公共方法签名、模块间依赖、数据流转
3. **External HTTP APIs**: 如有对外 HTTP 接口需求，另见 `api-contract.json`

---

## Data Model (data-model.json)

### JSON Format

```json
{
  "entities": [
    {
      "name": "EntityName",
      "fields": [
        {
          "name": "fieldName",
          "type": "string | number | boolean | array | object",
          "required": true,
          "description": "字段说明"
        }
      ],
      "relationships": [
        {
          "type": "one-to-one | one-to-many | many-to-many",
          "target": "RelatedEntity",
          "description": "关系说明"
        }
      ]
    }
  ]
}
```

### Writing Guidelines

1. **Entity focus**: 定义核心业务实体及其属性
2. **Field clarity**: 每个字段明确类型、是否必填、业务含义
3. **Relationship mapping**: 清晰描述实体间关系（一对一、一对多、多对多）
4. **Normalization**: 遵循数据库范式，避免冗余

---

## Task Breakdown (task-breakdown.json)

### Markdown Structure

```markdown
## 任务列表

<!-- 开发任务清单，每个任务可直接编码 -->
```

### Schema Definition

From `schemas/task-breakdown.json`:

- `sections`: Required section headings with aliases
- `minLength`: 100 characters minimum
- `guidance`: Writing guidance

### Writing Guidelines

1. **Execution ready**: 每个任务要具体到开发者能直接开始编码
2. **Granularity**: 任务粒度适中（2-4 小时完成）
3. **Dependency clear**: 任务间依赖关系明确
4. **Acceptance criteria**: 每个任务应有验收标准

---

## Test Plan (test-plan.json)

### Markdown Structure

```markdown
## 测试范围

<!-- 测试目标、覆盖范围 -->

## 测试策略

<!-- 测试方法（功能测试、接口测试） -->

## 测试用例

<!-- 具体测试用例列表 -->
```

### Schema Definition

From `schemas/test-plan.json`:

- `sections`: Required section headings with aliases
- `minLength`: 100 characters minimum
- `guidance`: Writing guidance

### Writing Guidelines

1. **Coverage**: 覆盖功能测试（参照 prototype 交互流程）和内部模块 API 测试（参照 api-design 方法签名）
2. **Strategy**: 明确测试策略和测试类型
3. **Test case format**: 用例包含输入、预期输出、实际结果
4. **Traceability**: 每个测试用例关联 PRD 功能需求

---

## Writing Workflow

When Harmonia dispatches a task requiring artifact writing:

1. **Query schema first**:

   ```bash
   curl http://127.0.0.1:4600/projects/{project}/artifacts/{id}/schema
   ```

   Response contains `guidance`, `sections` (for Markdown) or `jsonFields` (for JSON).

2. **Follow the format**:
   - Markdown artifacts: Use the `sections` structure above, with `required` headings.
   - JSON artifacts: Follow the JSON schema exactly.
   - Respect `minLength`: Ensure content meets minimum length requirements.

3. **Write to provided path**:
   - The dispatch prompt's `## Output Paths` section gives you the exact absolute path.
   - Use that path directly; don't construct it yourself.

4. **Automatic validation**:
   - Harmonia validates after you write.
   - If validation fails, you'll receive an error describing what's wrong.
   - Fix and rewrite the artifact.

## Common Errors

| Error Type               | Likely Cause                  | Fix                             |
| ------------------------ | ----------------------------- | ------------------------------- |
| Missing required section | Forgot a required heading     | Add the missing section         |
| Below minLength          | Content too short             | Expand with more detail         |
| Invalid JSON format      | Syntax error in JSON artifact | Fix JSON structure              |
| Wrong artifact type      | Writing in wrong format       | Check schema for correct format |

## Quality Checklist

Before considering an artifact complete:

- [ ] All required sections/headings present
- [ ] Content meets minLength requirement
- [ ] Guidance instructions followed
- [ ] File written to correct path
- [ ] Content is coherent and well-structured
