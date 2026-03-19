# 042 — 文档修正与扩展名统一

> 基于文档审查发现的 9 个问题，修正 docs/workflow-guide.md 中的错误和不完善描述，
> 同时将 workflows/dev/tools.ts 重命名为 tools.js 以与 hooks.js 保持一致。

---

## 变更清单

| 编号 | 内容                                             | 类型     | 涉及文件                                                        |
| ---- | ------------------------------------------------ | -------- | --------------------------------------------------------------- |
| 1    | 快速示例文件数量 3→2                             | 文档错误 | docs/workflow-guide.md                                          |
| 2    | artifact_field field 说明：仅 JSON、支持嵌套路径 | 文档错误 | docs/workflow-guide.md                                          |
| 3    | model 字段：改为具体模型名称                     | 文档改进 | docs/workflow-guide.md                                          |
| 4    | session/parallel 字段：补充使用场景描述          | 文档改进 | docs/workflow-guide.md                                          |
| 5    | frontmatter 整体定位说明：描述性元数据           | 文档改进 | docs/workflow-guide.md                                          |
| 6    | Markdown Schema required 语义澄清                | 文档改进 | docs/workflow-guide.md                                          |
| 7    | 移除部署方式一（包内 workflows/）                | 文档变更 | docs/workflow-guide.md                                          |
| 8    | 查找优先级：移除内置目录回退描述                 | 文档变更 | docs/workflow-guide.md                                          |
| 9    | 文档中 tools.ts→tools.js                         | 文档同步 | docs/workflow-guide.md, README.md                               |
| 10   | 源码 tools.ts→tools.js + 注释同步                | Bug 修复 | workflows/dev/tools.js, plugin.ts, types.ts, action-registry.ts |

## 提交

- `da5187f` docs: #042 文档修正与扩展名统一
- 20/334 测试全部通过

## 后续待做

- 查找优先级源码改动（resolveWorkflowDir 移除内置回退 + setup 复制逻辑）→ #043
- dispatch prompt 优化（Configuration 数据罗列 → 行动指引文本）
- role_prompt 工具输出格式同步调整
