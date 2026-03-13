# 003 — P2 实现完成

**日期**: 2026-03-13
**类型**: 完成记录

## 背景

P1（角色增强、文档审核、dispatch_role）已在 commit ca596a4 完成。P2 的目标是让 Harmonia 真正可用——通过 setup 注入让宿主 agent 自动扮演 PM 角色，并增强状态查询。

## 完成内容

### Setup 注入系统 (`src/setup/`)

- **inject.ts**: 宿主 agent 检测（V1 支持 opencode / claude-code / codex）、AGENTS.md / CLAUDE.md 注入逻辑（幂等操作，重复调用会替换已有 harmonia 块）、移除注入功能
- **templates.ts**: PM 引导 prompt 模板（已在 P1 创建），包含完整的工具速查表、阶段推进指南、文档审核流程、任务派发指南

### MCP 工具（新增 1 个）

| 工具            | 功能                                                           |
| --------------- | -------------------------------------------------------------- |
| `setup_project` | 注入 PM 引导到宿主 agent 配置文件（自动检测 agent 类型，幂等） |

### get_project_status 增强

- 待审核文档列表（docId + 提交日期）
- 已完成文档带审核状态标注（pending/approved/rejected）
- 当前阶段预期输出和角色信息
- **下一步建议**（自动推导）：
  - 有待审核文档 → 提示 present + approve_doc
  - 缺少阶段输出 → 提示 dispatch_role 或 write_doc
  - 全部就绪 → 提示 update_phase 推进

### 组员 Agent/Model 配置

（已在 P1 实现：overrides.ts 的 resolveRoleConfig + dispatch_role 返回值包含 agent/model 配置）

### 测试

- 6 个测试文件，61 个测试全部通过
- 新增 `setup.test.ts`（10 个测试）：agent 检测、注入创建/追加/替换/移除、prompt 内容校验

### 质量

- tsc 零错误
- 全部 61 个测试通过
