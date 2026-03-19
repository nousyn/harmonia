# 044 — session/parallel/model 字段行为优化

> 将 `model`、`session`、`parallel` 三个 frontmatter 字段从纯描述性元数据升级为 Core 强制执行的行为配置。

---

## 目标

1. **model** — 角色文件改用具体模型名，`plugin.ts` 默认值同步
2. **session** — Core 根据 `session` 字段决定是否调用 `findIdleSession`、是否生成 `--resume` 建议
3. **parallel** — Core 根据 `parallel` 字段 + 同角色 running dispatch 状态决定是否强制新 session
4. **Configuration 区块** — 从 dispatch 输出中移除，信息吸收进 Session Guidance 和 prompt
5. **文档同步** — `workflow-guide.md` 更新

## 变更计划

### A. model 字段

| 编号 | 内容                                                     | 文件                               |
| ---- | -------------------------------------------------------- | ---------------------------------- |
| A1   | coordinator.md: `medium` → `claude-sonnet-4`             | workflows/dev/roles/coordinator.md |
| A2   | architect.md: `strong` → `claude-opus-4`                 | workflows/dev/roles/architect.md   |
| A3   | developer.md: `medium` → `claude-sonnet-4`               | workflows/dev/roles/developer.md   |
| A4   | tester.md: `medium` → `claude-sonnet-4`                  | workflows/dev/roles/tester.md      |
| A5   | `parseRoleFile` 默认值: `'medium'` → `'claude-sonnet-4'` | src/core/plugin.ts                 |

### B. session 字段 — Core 强制执行

在 `dispatch-role.ts` 中根据 `roleDef.frontmatter.session` 值控制行为：

- `none` → 不调用 `findIdleSession`，Session Guidance 只说"启动新会话"
- `persistent` → 调用 `findIdleSession`，找到则包含 `--resume` 建议
- `optional` → 调用 `findIdleSession`，找到则以建议性语气包含信息

涉及文件: `src/tools/dispatch-role.ts`

### C. parallel 字段 — Core 强制执行

在 `dispatch-role.ts` 中：

- `parallel=true` 且同角色有 `running` dispatch → 跳过 `findIdleSession`，强制新 session
- 其他情况按 session 字段正常处理

需要新增函数: 查询同角色是否有 running dispatch
涉及文件: `src/tools/dispatch-role.ts`, `src/core/dispatch.ts`

### D. 移除 Configuration 区块

dispatch 输出中的 `## Configuration` 删除，model/agent 信息吸收进 Session Guidance。

涉及文件: `src/tools/dispatch-role.ts`

### E. 文档同步

- `workflow-guide.md` Frontmatter 字段表: 更新定位说明（从描述性→强制执行）
- `workflow-guide.md` 角色参考表: `medium`/`strong` → 具体模型名
- `workflow-guide.md` 示例和默认值说明: 更新模型名
