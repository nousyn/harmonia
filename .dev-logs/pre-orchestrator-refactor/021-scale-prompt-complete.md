# 021 — Scale 延迟设定 & PM Prompt 去项目化 & Setup 简化 — 完成

> 状态: 完成  
> 日期: 2026-03-16  
> 分支: develop  
> 计划文档: [020-scale-prompt-plan.md](./020-scale-prompt-plan.md)

## 概要

完成了 020 计划中的全部 6 个阶段，实现了 4 项架构变更：

1. **Scale 延迟设定** — scale 从 `project_init` 参数移除，改为 PRD 审批后通过 `project_set_scale` 设定，设定后不可更改
2. **PM Prompt 去项目化** — PM 提示词模板不再包含 projectName/projectDir/scale，PM 通过 `project_status` 获取运行时信息
3. **Setup 简化** — `harmonia setup` 仅做 prompt 注入 + hook 安装，移除 `--name`/`--workflow` 参数
4. **project_status 渐进式查询** — `project_name` 变可选，无参返回项目列表，有参返回项目详情

## 实施阶段

### Phase 1: 类型 & 状态层

- `types.ts`: `ProjectState.scale` 类型从 `ProjectScale` 改为 `ProjectScale | null`
- `state.ts`: `initProjectState()` 移除 scale 参数（初始化为 null）；新增 `setScale()` 函数（PRD-approved + immutability 双守卫）；新增 `ScaleNotSetError` 错误类

### Phase 2: 工具层

- `project-init.ts`: 移除 scale/workflow 参数；新增 `project_name` 强校验（regex + 长度限制）和 `project_dir` 路径校验（绝对路径 + refine 检查目录存在性）
- `set-scale.ts`: **新文件** — `project_set_scale` 工具，前置条件: PRD approved，设定后不可更改
- `get-project-status.ts`: `project_name` 变可选；无参时调用 `listProjects()` + `buildProjectList()` 返回摘要；scale=null 显示 `(未设定)`

### Phase 3: 下游适配

- `doc-tools.ts`: `isSequentialActive()` 接受 null（null → 非 sequential）
- `update-phase.ts`: 新增 Guard 0（scale 未设定时阻止阶段推进）；Guards 2&3 仅在 scale !== null 时执行
- `dispatch-role.ts`: `resolveExpectedOutputs()` 接受 null scale；显示层 scale=null 展示 `(未设定)`
- `schema.ts`: `validateDoc()` 第 4 参数接受 `ProjectScale | null`；null 时所有 `required[scale]` 视为 false（即所有章节可选）

### Phase 4: Setup & Prompt

- `templates.ts`: `generatePmPrompt()` 无参数，移除所有项目特定信息；新增 "Getting Started" 引导段落
- `inject.ts`: `injectPrompt()` 签名简化，移除第 3 参数 `params`
- `setup.ts`: CLI 重写 — 仅保留 `--agent` 选项，不做项目注册/状态初始化
- `index.ts`: 注册 `project_set_scale`，更新 --help 文本，`runSetup` 调用简化

### Phase 5: Hook 适配

- `content.ts`: `HookParams` 从 `{dataDir, projectName, projectDir}` 简化为 `{dataDir}`；HARMONIA_TOOLS 列表添加 `'project_set_scale'`
- `claude-code.ts`: PreToolUse 仅检查文件扩展名（不依赖 PROJECT_DIR）；UserPromptSubmit 扫描 DATA_DIR 下所有项目
- `opencode.ts`: 移除 PROJECT_DIR/PROJECT_NAME；新增 `listProjectDirs()` 扫描所有项目
- `openclaw.ts`: 同 opencode 模式

### Phase 6: 测试更新

- `state.test.ts`: 适配 null scale 初始化 + 新增 `setScale()` 测试
- `cli.test.ts`: 重写 — 移除 `--name`/`--workflow` 测试
- `hooks.test.ts`: 重写 — TEST_PARAMS 仅 `{dataDir}`，移除 projectName/projectDir 断言
- `setup.test.ts`: 重写 — `generatePmPrompt()` 无参调用，验证无项目特定内容

## 测试结果

```
Test Files  13 passed (13)
     Tests  260 passed (260)
```

从 256 → 260 测试（+4: setScale 功能测试）

## 其他变更

- `README.md`: 更新工具表（15 个工具），移除 `--name`/`--workflow` 文档，更新 setup 描述，更新测试计数

## 新增工具

| 工具                | 说明                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `project_set_scale` | 设定项目规模（small/medium/large），前置条件: PRD approved，设定后不可更改 |

## 设计决策记录

| 决策                               | 选择                                 | 理由                                                          |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| scale 初始值                       | `null` (不是默认 'small')            | 强制 PM 显式设定，避免隐式假设                                |
| doc_write 不 hard-block scale=null | schema 校验跳过 scale-dependent 检查 | 允许 PRD 在 scale 设定前写入（PRD 本身就是 scale 评估的输入） |
| phase_update 阻止 scale=null       | Guard 0 前置检查                     | 阶段推进依赖 scale（文档完整性检查需要 scale）                |
| Hook 不依赖项目信息                | 方案 B: 扫描 DATA_DIR                | 减少 setup 耦合，支持多项目场景                               |
| PM Prompt 保留工作流规则           | 静态常量保留                         | 移除会翻倍交互轮次（每次决策都要查）                          |
