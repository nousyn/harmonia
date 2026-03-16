# 018 — 发布前改进完成

**日期**: 2026-03-16
**类型**: 完成日志
**分支**: develop

## 概述

完成 017 计划的全部 5 项改进。README 从零编写，MCP tool 全部重命名，新增 CLI 入口。

## 变更清单

### 新增文件

| 文件                | 说明                                                                           |
| ------------------- | ------------------------------------------------------------------------------ |
| `src/cli/setup.ts`  | CLI `harmonia setup` 命令实现：参数解析 + 项目初始化 + prompt 注入 + hook 安装 |
| `tests/cli.test.ts` | 14 个测试用例（parseSetupArgs 9 个 + runSetup 3 个）                           |

### 修改文件

| 文件                              | 变更                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `README.md`                       | 完整重写：tagline、功能概览、14 个 tool 表格、workflow 流程说明、4 种 agent 配置示例               |
| `src/index.ts`                    | 新增 CLI 路由（`setup`、`--help`、`--version`）、移除 `registerSetupProject`                       |
| `package.json`                    | 新增 `bin.harmonia` 字段                                                                           |
| `src/tools/approve-doc.ts`        | `approve_doc` → `doc_approve`，`list_pending_reviews` → `review_list`                              |
| `src/tools/doc-tools.ts`          | `write_doc` → `doc_write`，`read_doc` → `doc_read`，`list_docs` → `doc_list`                       |
| `src/tools/get-project-status.ts` | `get_project_status` → `project_status`                                                            |
| `src/tools/get-role-prompt.ts`    | `get_role_prompt` → `role_prompt`                                                                  |
| `src/tools/dispatch-role.ts`      | `dispatch_role` → `role_dispatch`                                                                  |
| `src/tools/report-dispatch.ts`    | `report_dispatch` → `dispatch_report`                                                              |
| `src/tools/override-tools.ts`     | `set_override` → `guard_set`，`get_overrides` → `guard_get`，`set_review_rule` → `review_set_rule` |
| `src/tools/project-init.ts`       | `init_project` → `project_init`                                                                    |
| `src/tools/update-phase.ts`       | `update_phase` → `phase_update`                                                                    |
| `src/hooks/content.ts`            | `HARMONIA_TOOLS` 数组更新为新命名                                                                  |
| `tests/sequential.test.ts`        | tool name 断言更新为 `doc_write`                                                                   |

## 提交记录

| 提交      | 内容                                |
| --------- | ----------------------------------- |
| `267f127` | README 首版（items 1, 2, 4）        |
| `bdad7aa` | MCP tool 全量重命名（item 3）       |
| `86c9692` | CLI 入口 `harmonia setup`（item 5） |

## Tool 命名对照表

| 旧名称                 | 新名称            | 资源组   |
| ---------------------- | ----------------- | -------- |
| `init_project`         | `project_init`    | project  |
| `get_project_status`   | `project_status`  | project  |
| `get_role_prompt`      | `role_prompt`     | role     |
| `dispatch_role`        | `role_dispatch`   | role     |
| `write_doc`            | `doc_write`       | doc      |
| `read_doc`             | `doc_read`        | doc      |
| `list_docs`            | `doc_list`        | doc      |
| `approve_doc`          | `doc_approve`     | doc      |
| `update_phase`         | `phase_update`    | phase    |
| `set_override`         | `guard_set`       | guard    |
| `get_overrides`        | `guard_get`       | guard    |
| `set_review_rule`      | `review_set_rule` | review   |
| `list_pending_reviews` | `review_list`     | review   |
| `report_dispatch`      | `dispatch_report` | dispatch |

## 测试结果

- 全部 254 个测试通过（13 个文件）
- 构建零错误
