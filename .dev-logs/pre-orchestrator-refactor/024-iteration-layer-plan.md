# 024 - 迭代层（Iteration Layer）引入

## 背景

当前 harmonia 的数据模型是 project → state/docs/sessions，一个项目只有一份状态。
这无法支持"已有项目多轮迭代需求"的场景。需要引入迭代层，使一个项目可以有多轮迭代，
每轮迭代走一遍完整的 workflow。

同时，新项目和老项目的 workflow 流程完全复用，区别仅在于项目目录下是否有已有代码。
架构师在 design 阶段会自行判断并读取存量代码。

## 设计决策

### 数据目录结构

```
<data_dir>/
├── registry.json                  (项目注册 + 迭代索引)
├── overrides.json                 (全局 override)
├── .workflows/
├── my-app/
│   ├── overrides.json             (项目级 override，跨迭代共享)
│   ├── iter-1/
│   │   ├── state.json
│   │   ├── sessions.json
│   │   ├── dispatches.json
│   │   ├── reviews.json
│   │   ├── steps.json
│   │   └── docs/
│   ├── iter-2/
│   │   └── ...
```

### registry.json ProjectEntry 变更

```typescript
interface ProjectEntry {
  dir: string;
  workflow: string;
  createdAt: string;
  currentIteration: number; // 新增：当前活跃迭代（从 1 开始）
  totalIterations: number; // 新增：总迭代数
}
```

### 路径构建

```typescript
getProjectDataDir(projectName)                    → <dataDir>/<projectName>   (不变)
getIterationDir(projectName, iteration)           → <dataDir>/<projectName>/iter-<n>  (新增)
```

### Core 函数签名变更

所有操作迭代级数据的函数加 `iteration: number` 必填参数，由 tool 层负责从 registry 读取 currentIteration 并传入：

- state.ts: readState(projectName, iteration), writeState(...), initProjectState(...), etc.
- docs.ts: writeDoc(projectName, iteration, ...), readDoc(...), etc.
- reviews.ts: readReviews(projectName, iteration), etc.
- dispatch.ts: readSessions(projectName, iteration), createDispatch(...), etc.
- steps.ts: readSteps(projectName, iteration), etc.
- overrides.ts: 项目级 override 不变（跨迭代），仍用 getProjectDataDir

### Tool 变更

| Tool            | 变更                                                      |
| --------------- | --------------------------------------------------------- |
| project_init    | 只注册项目（写 registry），不初始化 state，不创建迭代目录 |
| iteration_start | 新增。创建迭代目录，初始化 state.json，更新 registry      |
| project_status  | 无参不变。有参显示当前迭代状态 + 迭代历史摘要             |
| 其余 tool       | 签名不变，内部从 registry 读 currentIteration 传给 core   |

### CLI 变更

| 命令                | 变更                                                      |
| ------------------- | --------------------------------------------------------- |
| harmonia setup      | 不变                                                      |
| harmonia unregister | 新增。--project <name>，删除 registry 条目 + 可选清理数据 |

### Agent 引导机制

1. project_init 对已注册项目返回提示："项目已注册，如需新迭代请调用 iteration_start"
2. project_status 当所有 phase completed 时，next-steps 推荐 iteration_start
3. PM prompt 中明确说明 project_init vs iteration_start 的区别

## 改造范围

### Core 层（函数签名 + 路径逻辑）

- types.ts: ProjectEntry 新增字段，新增 IterationInfo 类型
- registry.ts: 新增 getIterationDir()，修改 registerProject()
- state.ts: 所有函数加 iteration 参数
- docs.ts: 所有函数加 iteration 参数
- reviews.ts: 所有函数加 iteration 参数
- dispatch.ts: 所有函数加 iteration 参数
- steps.ts: 所有函数加 iteration 参数
- overrides.ts: 不变（项目级，跨迭代）

### Tool 层

- project-init.ts: 精简为只注册
- iteration-start.ts: 新增
- 其余 10+ tool: handler 开头读 registry 取 currentIteration 传给 core

### CLI 层

- 新增 unregister 命令

### 测试

- 全部 13 个测试文件需要适配 iteration 参数

## 实施顺序

1. types.ts — 新增类型
2. registry.ts — 路径 + 注册逻辑
3. state.ts — iteration 参数
4. docs.ts, reviews.ts, dispatch.ts, steps.ts — iteration 参数
5. overrides.ts — 确认不需要改（或微调）
6. project-init.ts — 精简
7. iteration-start.ts — 新增
8. 其余 tools — 加 iteration resolve
9. templates.ts — 更新 PM prompt
10. CLI unregister
11. 全部测试适配
