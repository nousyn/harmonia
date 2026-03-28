# 011 — Harmonia 优化方案

**日期**: 2026-03-16
**类型**: 优化方案

## 背景

基于 OpenClaw 作为 PM 实际运行 Harmonia 进行项目开发过程中发现的问题：

1. PM 职能越界——直接修 bug，应 dispatch 给 developer
2. 产出乱存放——文件写到 OpenClaw 全局目录下的 temp 目录
3. 未产出高保真 HTML 原型——prompt 引导不足
4. 项目跟进能力基本不存在——无主动提醒、无超时检测
5. 系统架构是"乐观信任"模式——所有约束只靠 prompt，无代码级强制

## 根因分析

Harmonia 当前是一个"乐观信任"系统：信任 PM（宿主 agent）会按 prompt 指示正确调用工具、遵守流程、检查产出。所有约束靠 prompt 引导而非代码强制。这导致：

- 流程正确性完全依赖 LLM 的指令遵循能力
- 没有系统级的 guardrail 防止流程违规
- 被动查询而非主动推送

## 优化方向概览

| 方向              | 优先级 | 目标                                      |
| ----------------- | ------ | ----------------------------------------- |
| 产出 Schema 化    | P0     | 所有校验的基础设施                        |
| Tool Guard        | P1     | MCP 工具层硬约束，管"体系内做得对不对"    |
| Agent Hook        | P2     | 宿主 agent 层行为约束，管"体系外做了什么" |
| Sequential 串行   | P3     | 关键产出步骤化，白盒化                    |
| Parallel 并行协调 | P4     | 并行开发/测试场景支持                     |

---

## P0：产出 Schema 化

### 目标

为每种文档类型定义结构 schema，保证产出质量有检查标准。这是后续所有校验（Tool Guard、Sequential 步骤校验）的基础。

### Schema 存放位置

```
workflows/dev/
├── workflow.json
├── roles/
│   ├── pm.md
│   ├── architect.md
│   ├── developer.md
│   └── tester.md
└── schemas/              ← 新增
    ├── prd.json
    ├── user-stories.json
    ├── tech-design.json
    ├── task-breakdown.json
    ├── api-design.json
    ├── test-report.json
    └── ...
```

schema 跟着 workflow 走，不同 workflow 可以有不同的文档 schema。

### 各文档 schema 定义（初步）

| 文档      | 必须包含的模块                               |
| --------- | -------------------------------------------- |
| PRD       | 项目概述、功能需求列表、非功能需求、验收标准 |
| 用户故事  | 角色、场景、验收条件（每条故事）             |
| 技术方案  | 架构概述、技术选型、模块设计、接口设计       |
| 任务拆解  | 任务列表（ID、描述、依赖关系、预估工作量）   |
| API 设计  | 端点列表、请求/响应格式                      |
| 测试报告  | 测试范围、用例结果、覆盖率、问题列表         |
| HTML 原型 | 合法 HTML、包含页面导航、包含交互说明        |

### Schema 与 scale 联动

small 项目的 schema 可以比 large 简化（必填字段更少）。例如 small 的 PRD 不需要非功能需求章节。

### 校验时机

`write_doc` 时自动校验，不符合则拒绝写入并返回具体的缺失项。

---

## P1：Tool Guard——MCP 工具层硬约束

### 目标

在 Harmonia 的 tool handler 内部加入前置/后置校验。管住"PM 在 Harmonia 体系内做得对不对"。

### 1.1 阶段推进守卫（update_phase）

`status=completed` 且 `force!=true` 时，增加以下检查：

- **前置阶段检查**：所有前序阶段必须为 completed
- **文档审核状态检查**：当前阶段的必需文档如果配置了 review，必须为 approved（不只是"文件存在"）
- **active dispatch 检查**：当前阶段不能有 running/dispatched 状态的 dispatch

### 1.2 dispatch 角色-阶段校验（dispatch_role）

- 被 dispatch 的角色必须属于当前阶段的 `roles` 定义
- 或允许 dispatch 下一阶段的角色（为衔接做准备），但需当前阶段接近完成

### 1.3 dispatch 状态机约束（report_dispatch）

加入状态转换规则，终态不可逆：

```
dispatched → running / cancelled
running → completed / failed / cancelled
completed / failed / cancelled → 终态，不可逆
```

### 1.4 dispatch 完成验证（report_dispatch completed）

`status=completed` 时，检查 `expectedOutputs` 对应的文档是否已存在。不存在则返回警告（external 产出除外）。

### 1.5 文档写入守卫（write_doc）

- **内容非空校验**
- **schema 校验**（依赖 P0 的 schema 定义）
- **doc_id 合法性**：必须是 workflow 中定义的文档类型
- **阶段归属校验**（可配置为 warning 而非 error）

---

## P2：Agent Hook——宿主 agent 层行为约束

### 目标

管住"PM 在 Harmonia 体系外做了什么"。这些是 Harmonia 作为 MCP 无法触达的，必须通过 agent-kit 的 hook 能力在宿主 agent 侧执行。

### 能力边界划分原则

- **Agent Hook 负责**：管 PM "在 Harmonia 体系外做了什么"——越界操作拦截、主动提醒推送
- **Tool Guard 负责**：管 PM "在 Harmonia 体系内做得对不对"——流程校验、数据校验

### 2.1 职能边界拦截

| Hook                | 触发条件                                        | 行为                                         |
| ------------------- | ----------------------------------------------- | -------------------------------------------- |
| 拦截代码修改        | PM 尝试写入项目源码目录下的代码文件             | 阻断，提示"代码修改应 dispatch 给 developer" |
| 拦截非标路径写文件  | PM 尝试在 Harmonia 数据目录和项目目录之外写文件 | 阻断，提示"文档产出应通过 write_doc"         |
| 拦截 shell 命令执行 | PM 尝试执行 npm run/test/build 等开发命令       | 阻断，提示"测试运行应 dispatch 给 tester"    |

### 2.2 主动跟进提醒

| Hook              | 触发条件                                 | 行为                                                         |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------ |
| dispatch 超时提醒 | dispatch 处于 running 超过阈值（可配置） | 注入提醒"dispatch-XXX 已运行 N 分钟，建议检查进度"           |
| 阶段空闲提醒      | 当前阶段 in_progress 但长时间无工具调用  | 注入提醒"当前阶段已空闲 N 分钟，建议检查 get_project_status" |
| 待审核提醒        | 有文档处于 pending review 超过阈值       | 注入提醒"X 份文档待审核，请尽快处理"                         |

### 2.3 流程引导

| Hook         | 触发条件                       | 行为                                           |
| ------------ | ------------------------------ | ---------------------------------------------- |
| 会话启动引导 | PM agent 会话开始              | 注入"请先调用 get_project_status 了解当前状态" |
| 阶段完成引导 | 检测到阶段刚被标记为 completed | 注入"已进入 X 阶段，下一步建议..."             |

---

## P3：Sequential 串行——关键产出步骤化

### 目标

对关键产出拆分为多个可检查的步骤，每步独立执行、独立校验。将单节点多步骤的黑盒模式改为单节点单步骤，每个步骤都是独立的执行。

### 适用场景

不是所有流程都 Sequential 化，只对高价值产出做：

| 产出     | 步骤拆分                                                 | 理由               |
| -------- | -------------------------------------------------------- | ------------------ |
| PRD      | 需求结构化(JSON) → 校验完整性 → 生成 PRD 文档 → 校验 PRD | 后续所有工作的基础 |
| 技术方案 | 架构分析 → API 契约定义 → 完整技术方案 → 校验            | 直接决定开发方向   |
| 任务拆解 | 粗粒度拆分 → 依赖分析 → 细化为可执行任务 → 校验          | 开发并行的前提     |

### 不适用场景

- ADR、retrospective 等独立文档——单步产出即可
- small scale 项目——步骤化的额外开销不值得

### 实现方式

- workflow 定义层面为文档增加 `steps` 字段
- 每个 step 有独立的 schema 校验
- 步骤间中间产物存储在 `docs/` 下（如 `prd.requirements.json`）
- 用户可通过 override 配置是否启用 Sequential

### 审核打回策略

打回时只回退到出问题的步骤，不需要从头重来。减少重新执行的耗时和文档流存量。

---

## P4：Parallel 并行协调

### 目标

当前 Harmonia 已支持并行 dispatch（PM 可以同时 dispatch 多个角色）。缺的是并行协调——契约前置、汇合验证、结果汇总。

### 场景一：前后端并行开发

```
架构师产出 API 契约（design 阶段）
       ↓
┌──────────────┬──────────────┐
│ 前端开发      │ 后端开发      │  （并行，各自基于 API 契约）
│ mock 数据开发  │ 接口实现      │
└──────┬───────┴──────┬───────┘
       ↓              ↓
       联调阶段（汇合点）
```

要点：

- 架构师产出需增加"API 契约文档"（schema 化，端点、请求/响应格式）
- develop 阶段支持"汇合点（sync point）"——前后端 dispatch 都完成后进入联调
- 联调作为 develop 阶段内的子阶段

### 场景二：多测试并行

```
┌──────────────┬──────────────┬──────────────┐
│ 功能测试      │ API 测试      │ E2E 测试      │
└──────┬───────┴──────┬───────┴──────┬───────┘
       ↓              ↓              ↓
       测试结果汇总（PM 或测试负责人）
```

要点：

- 多个 tester dispatch 并行执行，各自产出子测试报告
- PM 或测试负责人汇总所有子报告为最终测试报告

### 需要的基础设施

- dispatch 分组（group_id），标识同一批并行任务
- 汇合条件：同组所有 dispatch 都 completed 后触发汇合
- 汇总工具或角色

---

## 其他改进项

### 必备角色强化

架构师和测试均为必备角色，任何 scale 下不可跳过：

| 变更                       | 当前值         | 目标值                      |
| -------------------------- | -------------- | --------------------------- |
| test-report scale(small)   | skip           | lite                        |
| retrospective scale(small) | skip           | 维持 skip（交付阶段可精简） |
| design 阶段                | 无强制约束     | 标记为不可跳过              |
| test 阶段                  | small 下可空跑 | 至少产出 lite 测试报告      |

架构师产出增加 API 契约文档（为前后端并行开发做基础）。

### HTML 原型产出强化

- prototype 的 schema 定义：必须是合法 HTML、包含页面导航、包含交互说明
- medium/large 项目中 prototype 从 optional 改为必需
- clarify 阶段的 Sequential 步骤中明确原型产出环节

### PM 提示词精简

随着 Hook 和 Tool Guard 引入，prompt 中大量"规则"可以精简：

- 删除可被 Hook/Guard 硬约束的条目（如"Don't write code"——由 Hook 拦截）
- 删除 Dispatch Workflow 详细步骤说明——Tool Guard 会在错误调用时给出具体指引
- 保留：角色定位、职责概述、工作流各阶段的高层指引

---

## 实施路线

```
P0: 产出 Schema 化          ← 所有校验的基础
P1: Tool Guard              ← 流程控制、状态机、文档校验（可与 P0 同步推进）
P2: Agent Hook              ← 职能越界拦截、主动跟进（依赖 agent-kit hook 能力）
P3: Sequential 关键产出      ← 高价值产出步骤化
P4: Parallel 协调           ← 并行开发/测试场景
```

P0 和 P1 可以同步推进（schema 定义和 Tool Guard 框架搭建并行）。P2 依赖 agent-kit 的 hook 能力。P3 和 P4 是流程层面的较大改动，建议在前面稳定后再引入。
