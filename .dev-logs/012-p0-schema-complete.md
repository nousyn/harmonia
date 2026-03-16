# 012 — P0 产出 Schema 化 完成

**日期**: 2026-03-16
**类型**: 完成日志

## 概述

实现了文档产出的 schema 校验基础设施。这是优化提案（011）中 P0 优先级的工作，是后续 Tool Guard（P1）和 Sequential 步骤化（P3）的基础。

## 变更清单

### 新增文件

| 文件                           | 说明                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `src/core/schema.ts`           | schema 加载器 + 校验器（`loadDocSchema`, `validateDoc`, `formatValidationErrors`） |
| `tests/schema.test.ts`         | 15 个测试用例                                                                      |
| `workflows/dev/schemas/*.json` | 14 个文档类型的 schema 定义                                                        |

### 修改文件

| 文件                     | 变更                                                     |
| ------------------------ | -------------------------------------------------------- |
| `src/core/types.ts`      | 新增 `DocSchema`, `DocSchemaSection` 类型                |
| `src/tools/doc-tools.ts` | `write_doc` handler 中集成 schema 校验，校验失败拒绝写入 |

## Schema 格式设计

每个文档类型有一个 JSON schema 文件（`workflows/dev/schemas/<docId>.json`），结构：

```json
{
  "sections": [
    {
      "heading": "## 章节标题",
      "required": { "small": false, "medium": true, "large": true },
      "aliases": ["## 英文别名", "## 中文同义词"]
    }
  ],
  "htmlTags": ["html", "body"], // 仅 HTML 类型文档
  "minLength": 200 // 最小内容长度
}
```

### 校验规则

- **标题级校验**：检查 markdown 文档是否包含 schema 中 `required=true` 的章节标题
- **别名匹配**：支持中英文别名，大小写不敏感
- **标题层级匹配**：`##` 和 `###` 是不同级别，不互通
- **HTML 标签检查**：对 HTML 格式文档检查必需标签是否存在
- **最小长度**：防止空壳文档占位
- **scale 联动**：每个 section 的 required 按 small/medium/large 独立配置

### 校验行为

校验失败时：**拒绝写入**，返回 `isError: true` 和具体缺失项列表。agent 需修正后重新提交。

## Schema 覆盖的文档类型（14 个）

| 文档类型        | sections 数     | 说明                                                 |
| --------------- | --------------- | ---------------------------------------------------- |
| prd             | 5               | 项目概述、功能需求、非功能需求、验收标准、约束与假设 |
| user-stories    | 1               | 用户故事                                             |
| fsd             | 4               | 功能概述、功能规格、交互流程、边界条件               |
| prototype       | 0 (htmlTags: 2) | HTML 标签检查：html, body                            |
| project-plan    | 3               | 项目计划、里程碑、时间安排                           |
| tech-design     | 5               | 架构概述、技术选型、模块设计、接口设计、数据模型     |
| data-model      | 3               | 数据模型、实体关系、字段定义                         |
| api-design      | 4               | 端点列表、请求/响应格式、错误码、认证与授权          |
| task-breakdown  | 1               | 任务列表                                             |
| risk-assessment | 2               | 风险项、缓解措施                                     |
| test-plan       | 3               | 测试范围、测试策略、测试用例                         |
| test-report     | 4               | 测试范围、测试结果、问题列表、覆盖率                 |
| deploy          | 3               | 部署环境、部署步骤、配置说明                         |
| retrospective   | 3               | 项目总结、经验教训、改进建议                         |

未创建 schema 的文档：`code`（external，不经过 write_doc）

## 测试结果

- 新增 15 个测试（schema.test.ts）
- 全部 92 个测试通过（原 77 + 新 15）
- 构建通过

## 下一步

- **P1: Tool Guard** — 阶段推进守卫、dispatch 状态机、doc_id 合法性校验
- 在 Tool Guard 中可以复用 schema 基础设施做更多校验（如阶段归属检查）
