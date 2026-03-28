# 019 — 用户反馈 Refinement 完成

**日期**: 2026-03-16
**类型**: 完成日志
**分支**: develop

## 概述

根据用户反馈对 018 的产出进行 4 项精化：移除不再需要的 `project_setup` MCP tool、CLI 去掉 `--scale` 参数（scale 改由 PM 在需求澄清后评估）、README 中英混排清理、测试同步更新。

## 变更清单

### 删除文件

| 文件                         | 说明                                                            |
| ---------------------------- | --------------------------------------------------------------- |
| `src/tools/setup-project.ts` | 原 `project_setup` MCP tool，功能已由 CLI `harmonia setup` 替代 |

### 修改文件

| 文件                   | 变更                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`         | 移除 `registerSetupProject` 引用；`--help` 文本移除 `--scale` 选项                                                                                                        |
| `src/cli/setup.ts`     | `SetupOptions` 接口移除 `scale` 字段；`parseSetupArgs` 移除 `--scale` 解析；`runSetup` 内部默认 `'small'`，注释说明 PM 后续调整                                           |
| `src/hooks/content.ts` | `HARMONIA_TOOLS` 数组移除 `'project_setup'`                                                                                                                               |
| `tests/cli.test.ts`    | 移除 `'should parse --scale'`、`'should throw on invalid --scale'` 两个用例；`'should parse all options together'` 去掉 scale 断言；3 个 `runSetup` 调用移除 `scale` 参数 |
| `tests/hooks.test.ts`  | 新增 `not.toContain('project_setup')` 断言                                                                                                                                |
| `README.md`            | 中英混排清理：`Via CLI` → `通过命令行：`、`Or add to` → `或添加到`、`Add to` → `添加到`、`(via mcporter)` → `（通过 mcporter）`；tool 表格从 15 行缩减到 14 行            |

## 设计决策

### Scale 延迟评估

`--scale` 从 CLI 参数中移除，`runSetup` 内部硬编码 `'small'` 作为初始值。设计意图：

- 项目初始化时用户通常还没有完整需求，无法准确判断 scale
- PM agent 在需求澄清阶段（requirements step）后有足够信息评估 scale
- 未来将增加 scale 动态设定机制（deferred）

### project_setup 工具移除

原 `project_setup` 是面向 agent 的 MCP tool，功能与 CLI `harmonia setup` 重叠。移除后：

- agent 通过 `project_init` 初始化项目（纯数据层）
- 人类通过 `harmonia setup` 初始化（数据 + prompt 注入 + hook 安装）
- 职责更清晰，减少工具数量

## 提交记录

| 提交      | 内容                                                                |
| --------- | ------------------------------------------------------------------- |
| `98c89ec` | 一次性提交：删除 project_setup、移除 --scale、README 清理、测试更新 |

## 测试结果

- 全部 254 个测试通过（13 个文件）
- 构建零错误

## 未来待做（Deferred）

1. **Scale 链路优化** — `project_init` 阶段延迟设定 scale，PM 在需求澄清后动态评估
2. **PM prompt 泛化** — 移除硬编码项目信息，让 PM 运行时通过工具发现
3. **多项目并行支持** — 当前 AGENTS.md 注入为单项目，需设计并发方案
4. **P4 并行协调** — 需真实使用反馈后再设计
