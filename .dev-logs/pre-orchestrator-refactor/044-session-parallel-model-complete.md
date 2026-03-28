# 044 — session/parallel/model 字段行为优化（完成）

> 将 `model`、`session`、`parallel` 三个 frontmatter 字段从纯描述性元数据升级为 Core 强制执行的行为配置。
> 移除 dispatch 输出中的 `## Configuration` 区块，信息整合进 `## Session Guidance`。

---

## 变更概览

| 阶段    | 内容                                                 | 涉及文件数 |
| ------- | ---------------------------------------------------- | ---------- |
| Phase A | model 字段：角色文件 + plugin.ts 默认值改具体模型名  | 6          |
| Phase B | session 字段：Core 强制执行 none/persistent/optional | 1          |
| Phase C | parallel 字段：running dispatch 时强制新 session     | 2          |
| Phase D | 移除 ## Configuration，整合进 Session Guidance       | 1          |
| Phase E | 文档同步                                             | 1          |

## 详细变更清单

### Phase A — model 字段

| 编号 | 内容                                               | 涉及文件                           |
| ---- | -------------------------------------------------- | ---------------------------------- |
| A1   | coordinator.md: `medium` → `claude-sonnet-4`       | workflows/dev/roles/coordinator.md |
| A2   | architect.md: `strong` → `claude-opus-4`           | workflows/dev/roles/architect.md   |
| A3   | developer.md: `medium` → `claude-sonnet-4`         | workflows/dev/roles/developer.md   |
| A4   | tester.md: `medium` → `claude-sonnet-4`            | workflows/dev/roles/tester.md      |
| A5   | `parseRoleFile` 默认值 × 2 处: → `claude-sonnet-4` | src/core/plugin.ts                 |
| A6   | 测试期望值更新                                     | tests/plugin.test.ts               |

### Phase B — session 字段 Core 强制执行

| 编号 | 内容                                                                          | 涉及文件                   |
| ---- | ----------------------------------------------------------------------------- | -------------------------- |
| B1   | `session: none` → 不调用 `findIdleSession`，直接指示"启动新会话"              | src/tools/dispatch-role.ts |
| B2   | `session: persistent` → 调用 `findIdleSession`，找到则指示复用（含 --resume） | src/tools/dispatch-role.ts |
| B3   | `session: optional` → 调用 `findIdleSession`，找到则以建议性语气呈现          | src/tools/dispatch-role.ts |

### Phase C — parallel 字段 Core 强制执行

| 编号 | 内容                                                                                  | 涉及文件                   |
| ---- | ------------------------------------------------------------------------------------- | -------------------------- |
| C1   | 新增 `hasRunningDispatch()` 函数：查询同角色是否有 dispatched/running 状态的 dispatch | src/core/dispatch.ts       |
| C2   | `parallel=true` + 同角色有 running dispatch → 跳过 idle session 查找，强制新会话      | src/tools/dispatch-role.ts |

### Phase D — 移除 ## Configuration

| 编号 | 内容                                                                     | 涉及文件                   |
| ---- | ------------------------------------------------------------------------ | -------------------------- |
| D1   | 删除 `## Configuration` 区块（model/session/parallel/agent）             | src/tools/dispatch-role.ts |
| D2   | model + agent 信息整合进 `buildSessionGuidance()` 输出                   | src/tools/dispatch-role.ts |
| D3   | 清理未使用的类型导入（OverrideConfig, WorkflowNode, ArtifactDefinition） | src/tools/dispatch-role.ts |
| D4   | 更新文件顶部注释，反映新的 session/parallel 强制行为                     | src/tools/dispatch-role.ts |

### Phase E — 文档同步

| 编号 | 内容                                                             | 涉及文件               |
| ---- | ---------------------------------------------------------------- | ---------------------- |
| E1   | Frontmatter 定位说明：从"描述性元数据"改为"Core 强制执行"        | docs/workflow-guide.md |
| E2   | 字段表：默认值 + 说明更新，反映 Core 强制行为                    | docs/workflow-guide.md |
| E3   | 示例 frontmatter：`claude-sonnet-4-20250514` → `claude-sonnet-4` | docs/workflow-guide.md |
| E4   | 角色参考表：`medium`/`strong` → 具体模型名                       | docs/workflow-guide.md |
| E5   | overrides 示例：`strong` → `claude-opus-4`                       | docs/workflow-guide.md |
| E6   | 默认值说明：模型名更新                                           | docs/workflow-guide.md |

## 验证

- TypeScript 编译通过（`npm run build`）
- 20 个测试文件、331 个测试全部通过（`npm test`）
- 全项目扫描确认无残留的 `medium`/`strong` 模型引用
- 全项目扫描确认无残留的 `claude-sonnet-4-20250514` 长模型名

## 架构变化说明

### 之前

- `model`/`session`/`parallel` 是纯描述性元数据
- Core 无条件调用 `findIdleSession`，不关心 session type
- `## Configuration` 区块原样输出 frontmatter 值给 Coordinator

### 之后

- Core 根据 `session` 值决定是否查找空闲 session + 输出何种指示语气
- Core 根据 `parallel` + running dispatch 状态决定是否强制新会话
- `## Configuration` 已删除，所有信息整合进 `## Session Guidance`
- `buildSessionGuidance()` 现在接收结构化参数，输出包含 model/agent/session 全部信息
