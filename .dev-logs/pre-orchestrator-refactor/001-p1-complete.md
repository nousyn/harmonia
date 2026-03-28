# 001 — P1 实现完成

**日期**: 2026-03-13
**类型**: 完成记录

## 背景

P0（全局目录架构改造）已在 commit 7bb89a6 完成。P1 的目标是实现角色增强机制、文档审核流程、任务派发，以及将之前多次讨论的设计决策落地为代码。

## 完成内容

### Core 层

- **types.ts**: 新增 `RoleCapability`（id + description + doc）、`DocReviewState`、`OverrideConfig`、`CapabilityOverride` 类型；`RoleFrontmatter` 增加 `capabilities` 字段；`PhaseStatus` 增加 `review` 状态；`DocDefinition` 增加 `format`（md/html）和 `review` 字段
- **overrides.ts**: 三层配置合并系统（workflow 默认 < 全局 overrides.json < 项目 overrides.json），review 解析（布尔 / 按文档粒度），capability override 解析
- **reviews.ts**: 文档审核状态管理（submit / approve / reject / getPending）
- **workflow.ts**: 引入 `yaml` 包替代手写 YAML 解析，支持 capabilities 数组
- **docs.ts**: 支持 `.html` 文档格式

### MCP 工具（新增 6 个）

| 工具                      | 功能                                                        |
| ------------------------- | ----------------------------------------------------------- |
| `approve_doc`             | 审批/拒绝待审核文档                                         |
| `list_pending_reviews`    | 列出所有待审核文档                                          |
| `set_capability_override` | 配置角色能力覆盖                                            |
| `set_review_override`     | 配置文档审核覆盖                                            |
| `get_overrides`           | 查看当前覆盖配置                                            |
| `dispatch_role`           | 准备角色派发数据（prompt + config + 输入文档 + task_brief） |

### 角色定义

- PM / Architect / Developer / Tester 四个角色 `.md` 均添加了 capabilities frontmatter
- PM 角色增加文档审核流程指引
- workflow.json 增加 prototype（HTML 格式）、fsd、review 标记等文档定义

### 测试

- 5 个测试文件，51 个测试全部通过
- 新增 `overrides.test.ts`（18 个）、`reviews.test.ts`（10 个）
- 扩充 `workflow.test.ts`（capabilities 解析 + review/format）和 `docs.test.ts`（HTML 格式）

### 质量

- tsc 零错误
- 全部 51 个测试通过

## 关键设计决策（落地）

1. dispatch_role 只准备数据，不拉起 agent
2. PM = 宿主 agent，Harmonia 核心零 agent 适配逻辑
3. 三层 override 配置体系统一管理 review 和 capability
4. 文档格式要求写在角色 prompt 里，write_doc 只做存储
