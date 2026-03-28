# 049 — 节点级输入依赖声明 + getInputArtifacts 清理

> 为 workflow task 节点新增 `inputArtifacts` 声明，让 `role_dispatch` 自动将上游制品的引用（名称 + 路径）注入数据包；同时清理引擎层语义错误的 `getInputArtifacts` 函数。

---

## 背景

### 问题 1：没有输入依赖声明

当前工作流节点和角色定义中只有"产出"概念（`capabilities[].artifact`），没有"输入"概念。当 `role_dispatch` 组装数据包时，无法自动注入上游制品的信息，完全依赖协调者 LLM 在 `input_artifact_ids` 参数中手动指定。

具体表现：

- tester 不知道 prd、user-stories 在哪
- 下游角色无法得知上游 unmanaged 制品（如 code）的路径
- `beforeDispatch.inject` 中的自然语言提示（如"请基于 prd、user-stories..."）无法被系统解析和自动处理

### 问题 2：`getInputArtifacts()` 语义错误

`engine-helpers.ts:119` 中的 `getInputArtifacts(nodeId)` 函数名暗示"获取节点需要的输入制品"，但实际返回的是"该角色 capabilities 中关联的、已存在于磁盘上的制品"——即角色的**产出物**，而非输入物。

该函数通过 `EngineContext` 接口传入引擎，在 `activateTask()` 中填充 `nextAction.inputArtifacts`，但 `formatNextAction()` 不输出该字段，因此整条链路无消费者。

历史上多次审计标记为 P2/F5（dev-logs 033/034/037/038/039），最终实现方向错误。

---

## 设计决策

### D1：声明位置 — 节点级

在 `workflow.json` 的 task 节点上声明 `inputArtifacts`，而非角色级。

**理由**：角色是能力的定义，依赖关系属于任务上下文。同一角色在不同节点中可能需要不同的输入。

```json
{
  "type": "task",
  "id": "test",
  "role": "tester",
  "inputArtifacts": ["prd", "user-stories", "code"]
}
```

### D2：传递方式 — 名称 + 路径

`role_dispatch` 将输入制品统一处理为"名称 + 路径"注入数据包，不注入制品内容。

**理由**：

- 避免上下文爆炸（多个大型制品内联到数据包）
- 统一处理 managed 和 unmanaged 制品（对消费者透明）
- 子智能体（AI 编码助手）有文件系统访问能力，可按需自行读取

路径解析规则：

- **managed 制品**：通过 `ArtifactDefinition.format` 映射扩展名，拼接为完整文件路径（不做磁盘探测）
- **unmanaged 制品**：解析到 `resolveArtifactDir()` 返回的目录路径
- **制品不存在**：仍然列出，标注"未找到"（不报错，校验是 gate 的职责）

### D3：`input_artifact_ids` 参数保留

`role_dispatch` 的 `input_artifact_ids` 可选参数保留，作为协调者动态补充输入制品的手段。

- 节点声明的 `inputArtifacts` 是基础
- 协调者传入的 `input_artifact_ids` 是补充
- 两者合并去重后统一按"名称 + 路径"处理

### D4：unmanaged 制品的细粒度引导由工作流层处理

Harmonia 只给出 `resolveArtifactDir()` 的结果（目录级路径）。如果工作流作者需要更细粒度的引导（如"请查阅 src/ 目录"），通过 `beforeDispatch.inject` 或角色 prompt 自行补充。

**理由**：Harmonia 是编排层，注重协作和流程控制。unmanaged 的本质是"内容结构由工作流定义"，框架不应试图理解其内容结构。

### D5：移除引擎层的 inputArtifacts 职责

输入依赖的解析职责在工具层（`role_dispatch`），不在引擎层。

- 移除 `EngineContext.getInputArtifacts` 函数
- 移除 `NextAction.inputArtifacts` 字段
- 清理所有调用点（`activateTask`、`engine-helpers`、`patch-start`、`iteration-start`、测试文件）

---

## 变更计划

### Phase 1：清理引擎层 getInputArtifacts（问题 2）

| 编号 | 内容                                                         | 文件                          | 状态 |
| ---- | ------------------------------------------------------------ | ----------------------------- | ---- |
| 1.1  | 移除 `EngineContext` 接口中的 `getInputArtifacts` 字段       | src/core/workflow-engine.ts   | ✅   |
| 1.2  | 移除 `activateTask()` 中对 `getInputArtifacts` 的调用        | src/core/workflow-engine.ts   | ✅   |
| 1.3  | 移除 `NextAction` 类型中的 `inputArtifacts` 字段             | src/core/types.ts             | ✅   |
| 1.4  | 移除 `buildEngineContext()` 中的 `getInputArtifacts` 实现    | src/tools/engine-helpers.ts   | ✅   |
| 1.5  | 清理 `patch-start.ts` 中的 `getInputArtifacts: () => []`     | src/tools/patch-start.ts      | ✅   |
| 1.6  | 清理 `iteration-start.ts` 中的 `getInputArtifacts: () => []` | src/tools/iteration-start.ts  | ✅   |
| 1.7  | 更新相关测试文件中的 mock `getInputArtifacts`                | tests/workflow-engine.test.ts | ✅   |

### Phase 2：节点级 inputArtifacts 声明（问题 1）

| 编号 | 内容                                                                                                             | 文件                           | 状态 |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---- |
| 2.1  | `TaskNode` 类型新增可选字段 `inputArtifacts?: string[]`                                                          | src/core/types.ts              | ✅   |
| 2.2  | `ValidationError.type` 联合类型新增 `'invalid_input_artifact'`                                                   | src/core/types.ts              | ✅   |
| 2.3  | `workflow-validator.ts` 新增验证：inputArtifacts 中的 ID 必须在 artifactDefinitions 中存在（包括 floatingNodes） | src/core/workflow-validator.ts | ✅   |

> **注**：`plugin.ts` 无需修改。`loadDefinition()` 通过 `JSON.parse` + `as` 类型断言解析 workflow.json，`inputArtifacts` 字段自动映射到 `TaskNode` 类型。

### Phase 3：role_dispatch 数据包改造

| 编号 | 内容                                                                                                      | 文件                       | 状态 |
| ---- | --------------------------------------------------------------------------------------------------------- | -------------------------- | ---- |
| 3.1  | 新增辅助函数：解析制品引用（名称 + 路径），managed 通过 format 映射扩展名拼接文件路径，unmanaged 返回目录 | src/tools/dispatch-role.ts | ✅   |
| 3.2  | 合并节点声明 `inputArtifacts` 与协调者参数 `input_artifact_ids`，去重                                     | src/tools/dispatch-role.ts | ✅   |
| 3.3  | 替换数据包中的 `## Input Artifacts` 板块为 `## Input References`（名称 + 路径格式）                       | src/tools/dispatch-role.ts | ✅   |
| 3.4  | 制品不存在时标注"未找到"而非静默跳过                                                                      | src/tools/dispatch-role.ts | ✅   |
| 3.5  | 更新 `input_artifact_ids` 参数的 `.describe()` 文本，反映"补充作用"和"路径引用"语义                       | src/tools/dispatch-role.ts | ✅   |

### Phase 4：内置 dev 工作流适配

| 编号 | 内容                                                                                    | 文件                        | 状态 |
| ---- | --------------------------------------------------------------------------------------- | --------------------------- | ---- |
| 4.1  | 为 dev 工作流的 task 节点补充 `inputArtifacts` 声明（包括 floatingNodes 中的 escalate） | workflows/dev/workflow.json | ✅   |

### Phase 5：测试与验证

| 编号 | 内容                                | 文件                             | 状态 |
| ---- | ----------------------------------- | -------------------------------- | ---- |
| 5.1  | 新增 inputArtifacts 验证相关测试    | tests/workflow-validator.test.ts | ✅   |
| 5.2  | 新增 role_dispatch 输入引用注入测试 | tests/dispatch-role.test.ts      | ✅   |
| 5.3  | 全量测试通过                        | —                                | ✅   |
| 5.4  | `tsc --noEmit` 编译通过             | —                                | ✅   |

---

## 数据包格式变更（Phase 3 前后对比）

### 变更前

```markdown
## Input Artifacts (2)

### prd

（prd 的完整文本内容...）

### user-stories

（user-stories 的完整文本内容...）
```

### 变更后

```markdown
## Input References (3)

- **prd** (需求文档): `/Users/cat/Library/Application Support/harmonia/my-app/iter-1/artifacts/prd.md`
- **user-stories** (用户故事): `/Users/cat/Library/Application Support/harmonia/my-app/iter-1/artifacts/user-stories.md`
- **code** (代码实现): `/Users/cat/projects/my-app/`

### Missing

- **api-spec** (API 规格): 未找到
```

---

## 与 `## Unmanaged Artifact Output Paths` 板块的关系

新增的 `## Input References` 板块和已有的 `## Unmanaged Artifact Output Paths` 板块是**不同关注点**：

- **Input References** = "你要读什么"（来自节点 `inputArtifacts` 声明 + 协调者 `input_artifact_ids`）
- **Unmanaged Artifact Output Paths** = "你要写到哪"（来自角色 capabilities 中的 unmanaged 产出）

同一 unmanaged 制品可能在两个板块中都出现（如 developer 对 `code` 既读又写），这是合理的语义，不做去重。

---

## 路径解析实现说明

managed 制品的路径解析**不需要磁盘探测**。`ArtifactDefinition` 中有 `format` 字段，直接做 format → extension 映射即可：

- `format: 'html'` → `.html`
- `format: 'json'` → `.json`
- `format` 未设或 `'md'` → `.md`

路径 = `resolveArtifactDir(def.output, ioCtx)` + `/{artifactId}{ext}`。是否存在由制品不存在时的"未找到"标注处理，不需要像 `readArtifact` 那样逐个扩展名探测。

---

## 风险与注意事项

1. **行为变更**：`role_dispatch` 不再将制品内容注入数据包。子智能体需要自行读取文件。所有 AI 编码助手（Claude Code、OpenCode 等）都有文件系统访问能力，风险低。
2. **向后兼容**：`inputArtifacts` 是 task 节点的可选字段，未声明时无自动输入引用。但 `input_artifact_ids` 参数的行为从"注入内容"改为"注入路径引用"，这是**不向后兼容的变更**——即使节点未声明 `inputArtifacts`，协调者通过参数传入的制品也不再注入内容。
3. **版本升级影响**：已有的工作流插件不受影响（`inputArtifacts` 可选）。但依赖 `input_artifact_ids` 注入内容行为的协调者 prompt 可能需要调整。
