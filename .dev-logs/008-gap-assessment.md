# 008 — 功能差距评估 + 后续优先级

**日期**: 2026-03-13
**类型**: 评估记录

## 背景

P4（Session 管理 + Dispatch 追踪）已完成。在规划下一步之前，对 outline 中规划的所有功能与当前实现做一次全面对比，重新评估优先级。

## 当前状态

- P0–P4 全部完成，15 个 MCP 工具，7 个测试文件 86 个测试
- outline 中的优先级标注未同步更新（outline P4=透传，实际 P4=Session 管理）

## 一、需要修复的问题（影响项目正常运转）

### 1.1 `optional` 文档裁剪未生效 — BUG

**严重程度**: 高

workflow.json 定义了 4 档 scale 值：`full`、`lite`、`skip`、`optional`。代码中只处理了 `skip`，`optional` 被当作必需文档。

受影响位置（3 处）：

- `get-project-status.ts` 的 missing outputs 逻辑（行 87）：`optional` 文档缺失会被报为 missing，触发"还需要产出 xxx"的建议
- `update-phase.ts` 的出口守卫（行 38）：`optional` 文档缺失会**阻止阶段完成**，除非 `force=true`
- `dispatch-role.ts` 的 expectedOutputs（行 91）：`optional` 文档被列入 dispatch 预期产出

**实际影响**：中等规模项目有 6 个 `optional` 文档（prototype、data-model、api-design、risk-assessment、deploy、retrospective）。PM 会被代码持续催促产出这些文档，阶段完成也会被挡住。scale 裁剪形同虚设。

**修复方案**：这 3 处的 `=== 'skip'` 过滤条件加上 `|| === 'optional'`。

### 1.2 孤立文档定义 — 工作流盲区

**严重程度**: 中

workflow.json 定义了 15 个 doc，但 phases 的 inputs/outputs 只引用了 8 个。以下 7 个文档虽然定义了 scale 规则，但不在任何阶段的 outputs 中：

| Doc ID            | 应属阶段 | 影响                    |
| ----------------- | -------- | ----------------------- |
| `fsd`             | clarify  | PM 不写也不影响推进     |
| `prototype`       | clarify  | 同上                    |
| `project-plan`    | clarify  | 同上                    |
| `data-model`      | design   | 架构师不写也不影响推进  |
| `api-design`      | design   | 同上                    |
| `risk-assessment` | design   | 同上                    |
| `test-plan`       | test     | Tester 不写也不影响推进 |

另外 `deploy` 完全孤立——不在任何 phase 中，不在任何角色 capabilities 中。

**实际影响**：出口守卫只检查 phases.outputs 中列出的文档。这些孤立文档即使 scale=full，缺失也不会阻止阶段完成。工作流引擎对它们完全无感知。

**修复方案**：把这些文档加入对应阶段的 outputs。`deploy` 加入 `deliver` 阶段。配合 1.1 的 optional 修复，scale=optional 的文档加入 outputs 后不会阻止推进，scale=full 的会强制要求产出。

## 二、值得做的功能

### 2.1 阶段入口条件验证

**优先级**: 中

当前只有出口守卫（完成阶段时检查产出），没有入口校验。`update-phase.ts` 在将阶段设为 `in_progress` 时不检查前一阶段是否完成、inputs 文档是否存在。理论上可以跳过 clarify 直接做 design。

这是防护性功能，成本低（几十行代码），防止 PM agent 在长会话中犯错。

### 2.2 透传机制 — 用户直接与组员沟通

**优先级**: 中

outline 中的透传场景是真实需求：用户想直接与架构师讨论技术细节时，PM 转述必然失真。尤其是方案调整、实现细节这类需要精确沟通的内容。

但 outline 的实现方案（`@角色名` 文本解析 + messages/ 目录路由）不适用于当前架构——组员是独立进程/session，不是 Harmonia 内部的 handler。Harmonia 无法"转发消息"给一个外部 agent 进程。

需要重新设计方案。可能的方向：

- Harmonia 提供 `connect_to_role` 工具，返回该角色的 session 恢复命令，PM 引导用户自行接入
- 或者利用 P4 的 session 记录，PM 直接告诉用户如何恢复指定角色的 agent 会话

**需先设计再实现，不急于写代码。**

### 2.3 MCP 工具层集成测试

**优先级**: 低

当前 86 个测试全在 core 层。工具层（dispatch_role 创建 dispatch + 查找 session + 组装返回、report_dispatch 的 session 生命周期管理、get_project_status 的 dispatch 感知推导）没有集成测试。

不阻塞功能，但后续改造风险较高。

## 三、不需要做的功能

### 3.1 Event 通知 / 异步回调

V1 的同步模式（等进程退出 + report_dispatch）已够用。MCP Server 自身没有 push 能力，硬做只增加架构复杂度，且当前没有实际使用场景要求异步。

### 3.2 v2 扩展角色（Code Reviewer / DevOps / Tech Writer）

v1 的 4 个角色还没经过真实项目验证。先跑通再按需加。

### 3.3 结构化任务管理（task ID / 依赖图 / tasks/ 目录）

任务拆解是 `task-breakdown.md` 文档，PM 和架构师都是 AI agent，能读文档理解依赖关系。结构化建模在 v1 阶段是过度设计。

### 3.4 messages/ 通信存储

与透传机制绑定。如果透传走"引导用户直接接入 session"的方案，不需要消息存储。

### 3.5 `lite` 运行时差异化

`lite` 和 `full` 在运行时无区别。但 `lite` 的语义是"可以写精简版"，这完全可以通过角色 prompt 传达（dispatch_role 已经在数据包中包含 scale 信息）。代码层不需要强制检查文档详略程度。

## 四、建议执行顺序

| 序号 | 内容                                          | 类型       | 预估工作量     |
| ---- | --------------------------------------------- | ---------- | -------------- |
| 1    | 修复 optional 裁剪                            | Bug fix    | 小             |
| 2    | 补全 workflow.json 孤立文档到对应阶段 outputs | Bug fix    | 小             |
| 3    | 阶段入口条件验证                              | 防护性功能 | 小             |
| 4    | 透传机制设计                                  | 设计文档   | 中（先出方案） |
| 5    | 工具层集成测试                                | 测试       | 中             |
| 6    | 更新 outline 优先级标注                       | 维护       | 小             |

其中 1–3 可以在一个 commit 中完成，4 需要先讨论方案。
