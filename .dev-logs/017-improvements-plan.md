# 017 — 发布前改进计划

**日期**: 2026-03-16
**类型**: 计划日志

## 背景

P0–P3 优化全部完成并合并到 main（`09e6abc`）后，针对发布前的可用性和代码质量进行最后一轮改进。

## 计划项

| #   | 任务                   | 优先级 | 说明                                                                                                              |
| --- | ---------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| 1   | README tagline 优化    | 高     | 当前 tagline 过于技术化，改为中文诗意风格                                                                         |
| 2   | README 去除 P0–P3 标签 | 高     | 用户不关心内部优先级编号，改为语义化功能名称                                                                      |
| 3   | MCP tool 重命名        | 高     | 全部 15 个 tool 从动词前缀改为资源前缀命名（如 `write_doc` → `doc_write`），提升 agent 在扁平工具列表中的可发现性 |
| 4   | README 配置段落        | 高     | 补全 4 种 agent（OpenCode、Claude Code、Codex、OpenClaw）的配置示例                                               |
| 5   | CLI 全局命令           | 高     | 新增 `harmonia setup` CLI 入口，支持 `--name`、`--workflow`、`--scale`、`--agent` 参数，一键初始化项目            |

## 设计决策

### Tool 命名规范

MCP tool 列表是扁平且按字母排序的，资源前缀分组能让 agent 更容易模式匹配：

```
旧: approve_doc, dispatch_role, get_project_status, ...
新: doc_approve, doc_write, doc_read, doc_list,
    role_prompt, role_dispatch,
    project_init, project_status,
    phase_update,
    guard_set, guard_get,
    review_set_rule, review_list,
    dispatch_report
```

### CLI 架构

- 入口 `src/index.ts` 根据 `process.argv[2]` 路由：无参数 → MCP server，`setup` → CLI 模式
- CLI 解析独立在 `src/cli/setup.ts`，纯函数 `parseSetupArgs` + 异步 `runSetup`
- `package.json` 的 `bin.harmonia` 指向 `build/index.js`
