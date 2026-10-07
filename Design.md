# 多 Agent 协作 Workflow —— 设计文档

## 1. 设计目标

### 1.1 作业要求

| 要求 | 本项目的实现方式 |
|---|---|
| 至少 2 个 Agent 协作完成完整流程 | 3 个：`CoderAgent` / `ReviewerAgent` / `FixerAgent` |
| 实现 Agent 间的消息传递或状态共享 | 共享 `WorkflowState` 读写 + `MessageBus` 发布/订阅 |
| 支持基本流程控制（顺序执行） | `flows.js` 的 `nodes` 顺序 + `condition` 流转 |
| MVP 可运行 | `npm run demo` 一条命令跑通端到端 |
| 条件分支、循环、并行 | 已做**条件分支**（issues 为空则结束）与**循环**（fixer → reviewer） |
| 执行日志与状态追踪 | `WorkflowLogger` 写 JSONL + 每次 `state.set()` 自动打快照 |
| 错误处理与恢复 | LLM 重试、节点重试、JSON 解析纠正、死循环熔断、日志降级 |

### 1.2 为什么选「代码审查流程」

1. **能复用项目 1 的成果**。作业明确鼓励复用——项目 1 已经解决了「LLM 调用 + 工具 + 审查 Prompt」这些难题，本项目只需要解决「多个 Agent 怎么协作」，重心清晰。
2. **流程闭环天然完整**。「编码 → 审查 → 修复」是一条有明确输入输出的业务链，不是硬凑出来的多 Agent。
3. **天然带条件分支与循环**。审查结果为空要结束、不为空要修复，修完还要复检——这正好是评分表里「高级流程控制」的加分项，而且不是为了炫技而加，是业务本身要求的。
4. **可验证性强**。端到端结果是一段能跑的代码 + 一份问题清单，好坏一眼可见。

## 2. 整体架构

四层分离，自上而下单向依赖：

```
┌────────────────────────────────────────────────────────────┐
│  入口层 (src/index.js)                                      │
│  接收用户需求 → 启动 Workflow → 展示最终结果                │
└────────────────────────┬───────────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────────┐
│  Workflow 层 (src/workflow/)                                │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │ orchestrator.js │  │    state.js     │                  │
│  │  按流程调度      │──│  共享状态        │                  │
│  └────────┬────────┘  └─────────────────┘                  │
│           │  ┌─────────────────┐  ┌─────────────────┐       │
│           │──│ messageBus.js   │  │   flows.js      │       │
│           │  │  Agent 间通信    │  │  声明式流程定义  │       │
│           │  └─────────────────┘  └─────────────────┘       │
│           │  ┌─────────────────┐                            │
│           └──│   nodes.js      │  节点 = Agent + 输入输出映射 │
│              └─────────────────┘                            │
└────────────────────────┬───────────────────────────────────┘
                         │ 调用 Agent
┌────────────────────────▼───────────────────────────────────┐
│  Agent 层 (src/agents/)                                     │
│  ┌──────────────────┐                                       │
│  │  baseAgent.js    │  统一：LLM 调用 + 工具 + 消息收发      │
│  └────────┬─────────┘                                       │
│           │ 继承                                            │
│  ┌────────▼────────┐ ┌──────────────┐ ┌──────────────┐     │
│  │  coderAgent.js  │ │reviewerAgent │ │ fixerAgent   │     │
│  │  编码            │ │  审查         │ │  修复        │     │
│  └─────────────────┘ └──────────────┘ └──────────────┘     │
└────────────────────────┬───────────────────────────────────┘
                         │ 工具调用
┌────────────────────────▼───────────────────────────────────┐
│  工具层 (src/tools/)                                        │
│  read_file / execute_code（复用项目1）                       │
└────────────────────────────────────────────────────────────┘
```

各层职责与「不做什么」：

| 层 | 职责 | 刻意不做的事 |
|---|---|---|
| 入口层 | 读参数、读需求、组装对象、打印结果 | 不写任何流程逻辑 |
| Workflow 层 | 状态、通信、节点映射、流程声明、调度 | 不知道 Agent 内部如何调用 LLM |
| Agent 层 | 各自的 Prompt 与输出解析 | 不直接调用别的 Agent，不写 State |
| 工具层 | 读文件 / 跑代码 | 不感知 Workflow 的存在 |

**核心思想**：
1. **Agent 不直接互相调用**，一律通过 `State + MessageBus` 通信，降低耦合；
2. **编排器不关心 Agent 内部实现**，只按 `flows.js` 调度；
3. **新增 Agent 只需 3 步**：写 Agent 文件 → `nodes.js` 注册 → `flows.js` 引用。

## 3. Workflow 编排设计

### 3.1 声明式流程（flows.js）的优势

```js
export function createFlow(config) {
  function condition(currentNode, state) {
    if (currentNode === "coder") return "NEXT";
    if (currentNode === "reviewer") {
      const issues = state.get("issues") || [];
      if (issues.length === 0) return "END";
      if ((state.get("iteration") || 0) >= config.maxIterations) return "END";
      return "fixer";
    }
    if (currentNode === "fixer") return "reviewer";
    return "NEXT";
  }
  return { name: "code-review", nodes: ["coder", "reviewer", "fixer"], entry: "coder", condition };
}
```

对比「把流程写在编排器里」：

- **可读**：流程的全部信息（节点集合、入口、分支）集中在一个 30 行的文件里，一眼看全；
- **可改**：调整流程不动编排器，也就不会碰调度、重试、日志这些通用逻辑；
- **可测**：`condition` 是纯函数 `(currentNode, state) => string`，可以脱离 LLM 单独测各种分支；
- **可扩展**：将来接可视化编排界面时，`{nodes, entry, condition}` 天然就是一份可序列化的流程图描述。

用工厂函数 `createFlow(config)` 而非直接导出对象，是因为 `condition` 需要用到 `config.maxIterations`。工厂把配置**闭包**进去，避免 `condition` 去读全局变量或 `process.env`，保持纯函数性质。

### 3.2 条件分支与循环的实现

编排器的循环骨架只有一行是关键：

```js
const next = flow.condition(current, state);
current = next === "NEXT" ? this.nextNodeInFlow(current) : next;
```

- **顺序**：`condition` 返回 `"NEXT"` 时，查 `nodes` 数组取下一个，最后一个取到 `"END"`；
- **分支**：返回具体节点名（`"fixer"`）或 `"END"`；
- **循环**：`fixer` 的 `condition` 返回 `"reviewer"`，于是指针回跳，形成闭环。

**循环为什么不会失控**：三重保险。

1. `fixer` 的 `outputMapper` 每执行一次就把 `iteration` 加 1；
2. `reviewer` 的分支里检查 `iteration >= config.maxIterations`（默认 3）→ `END`；
3. 编排器另有 `steps > 20` 的硬上限，一旦触发直接抛错并把 `status` 置为 `failed`——即使将来有人改坏了 `condition` 导致 A→B→A 死循环，也不会把进程挂死。

### 3.3 节点 = Agent + inputMapper + outputMapper

```js
{
  agent: BaseAgent,                       // 谁来做
  inputMapper: (state) => object,         // 从 State 取什么给它
  outputMapper: (result, state) => void,  // 把它的产出写回 State 哪里
}
```

这一层抽象的收益是**把「数据流」和「计算」解耦**：

- Agent 只认自己的输入对象，不需要知道数据存在 State 的哪个字段；
- 同一个 Agent 可以被不同节点复用，只要换一对 mapper（例如「对初版代码审查」和「对修复后代码审查」）；
- State 的字段名发生变更时，只需要改 mapper，不必改 Agent。

## 4. Agent 间通信设计

### 4.1 为什么用共享 State + MessageBus，而不是 Agent 直接调用

如果让 `CoderAgent` 直接 `new ReviewerAgent()` 并调用它，会立刻产生三个问题：

1. **耦合**：编码 Agent 必须知道审查 Agent 的构造函数签名与输入格式，改一个就要改另一个；
2. **编排权错位**：流程顺序被硬编码在 Agent 的调用链里，`flows.js` 形同虚设，想加分支必须改 Agent 代码；
3. **难观测**：调用栈里看不到「当前处于流程第几步」，日志和状态追踪无从下手。

改成 State + Bus 之后：Agent 之间**零直接依赖**，谁调谁、按什么顺序调，完全由 Workflow 层决定。

### 4.2 消息格式与订阅机制

消息统一为：

```js
{ topic: string, payload: any, from: string, timestamp: number }
```

当前使用的 topic：

| topic | 发布者 | payload | 用途 |
|---|---|---|---|
| `coder:done` | CoderAgent | `{ code }` | 编码完成 |
| `reviewer:done` | ReviewerAgent | `{ issues: number, summary? }` / `{ degraded: true }` | 审查完成 / 降级告警 |
| `fixer:done` | FixerAgent | `{ code, fixedCount }` | 修复完成 |
| `node:done` | Orchestrator | `{ node, result }` | 任意节点完成（统一事件） |

订阅用法与取消订阅：

```js
const unsubscribe = bus.subscribe("reviewer:done", (msg) => { /* ... */ });
unsubscribe(); // 取消订阅
```

设计细节：

- `publish` 同步通知订阅者，且**订阅者抛错不影响发布方**（内部 try/catch），避免一个日志订阅者把主流程搞崩；
- 所有消息都会进 `messages` 数组，因此总线同时充当**审计日志**：`getHistory()` 看全部，`getByTopic(topic)` 按主题过滤；
- 入口层订阅 `node:done`，把它转成 debug 日志——这就是「加一个观察者」的示例，将来接 Web 界面时，只要在这里多订阅一个 topic 就能实时推送。

### 4.3 状态快照与回放

```js
set(key, value) {
  this.data[key] = value;
  this.snapshot(`set:${key}`);   // 每次写入自动留痕
}
```

每个快照是 `{ label, timestamp, data }`，其中 `data` 是 `structuredClone` 的**深拷贝**——这一点很重要：如果只存引用，后续的写入会把历史快照一并改掉，快照就失去意义了。

快照的实际用途：

- **定位是谁改坏的**：按 label 顺序看 `set:code` 出现几次、每次内容差异；
- **理解流程走向**：快照序列本身就是流程轨迹（`set:status` → `set:requirement` → `set:iteration` → `set:code` → `set:reviewReport` → `set:issues` → …）；
- **未来可扩展为回放**：给定一串快照，可以从任意一步重建状态，实现「从 reviewer 之后重跑」这类调试能力。

## 5. Agent 设计

### 5.1 BaseAgent 抽象

`BaseAgent` 把三个所有 Agent 都需要的能力收拢起来，子类只写业务：

| 方法 | 作用 |
|---|---|
| `run(input, state)` | **抽象方法**，子类必须实现，基类直接抛错（fail fast，避免出现「跑了但什么都没做」的静默错误） |
| `callLLM(userMessage, temperature)` | 写记忆 → 请求 → 写记忆 → 返回文本，子类不必碰 Memory |
| `useTool(toolName, args)` | 调工具并把结果作为 Observation 写进记忆 |
| `publish(topic, payload)` | 发消息，`from` 自动填 `this.name` |
| `reset()` | 清空记忆但保留 system 消息 |

**每个 Agent 持有独立的 `LLMClient` 与 `Memory`**。这一点是刻意的：如果三个 Agent 共用一份记忆，Coder 的「我要生成代码」的上下文会污染 Reviewer 的「我要挑毛病」的上下文，模型很容易开始重复别人说过的话。独立记忆让每个 Agent 只看到与自己角色相关的历史。

### 5.2 三个子 Agent 的 Prompt 设计

**CoderAgent**（角色：资深软件工程师）

```
工作原则：
- 严格按需求实现功能，不要自行增加需求之外的功能。
- 代码要完整可运行，包含必要的 export，不要使用伪代码或省略号占位。
- 对边界情况（空输入、非法参数、越界等）做出合理处理，并让行为可预期。
- 只输出一个 Markdown 代码块，不要输出任何解释、寒暄或代码块之外的文字。
```

关键点是「**不要自行增加需求之外的功能**」：不加这句，模型很喜欢顺手加一堆没要求的方法，而 Code Review 阶段会把这些多余功能当成「问题」报出来，导致修复轮次无谓增加。

**ReviewerAgent**（角色：资深代码审查专家）—— 本项目最关键的设计

它**不输出自然语言报告，而输出严格 JSON**：

```json
{
  "summary": "总体评价，1-3 句话",
  "issues": [
    { "severity": "high | medium | low", "location": "行号或函数名",
      "description": "问题描述", "suggestion": "修复建议" }
  ]
}
```

原因有两点，都是被 Workflow 逼出来的需求：

1. **流程分支需要可判定的条件**。`condition` 要回答「issues 为空吗」，如果审查结果是散文，就只能再写一个 LLM 调用去解析它——既贵又不稳。结构化输出让分支判断变成一次 `issues.length === 0`。
2. **下游 Agent 需要可靠输入**。Fixer 要逐条修，就必须拿到「位置 + 问题 + 建议」的列表，而不是一段需要二次理解的自然语言。

Prompt 里同时约束了 severity 的取值域、空问题的表示方式（空数组）和「不要为了凑数编造问题」——最后这条尤其重要，否则模型为了显得尽责，会把正确的代码也报成问题，让循环永不收敛。

**FixerAgent**（角色：资深软件工程师）

```
工作原则：
- 逐条修复问题清单中的问题，不要遗漏。
- 保留原有正确的逻辑与公开接口（函数名、参数、导出），不要顺手重构。
- 修复后的代码必须完整、可直接运行，不要用省略号或注释占位。
```

「**不要顺手重构**」是针对循环场景的专门约束：如果每次修复都顺手重写一遍，下一轮审查又会报出一批新问题，流程就很难收敛——这是把 Workflow 的收敛性要求写进了 Prompt。

另外，Fixer 的 prompt 里会把 issues 渲染成带序号的清单（`1. [high] 位置：...`），比直接塞 JSON 更利于模型逐条对照。

### 5.3 结构化输出（JSON）的解析与容错

即使 Prompt 写得再严，模型也偶尔会输出 ```` ```json ```` 之外的内容、尾随逗号或中文引号，所以解析分三步：

```
1. 提取：```json 代码块 → 任意代码块 → 第一个 { 到最后一个 } → 整段文本
2. 解析：JSON.parse → 失败则去掉尾随逗号再 parse
3. 重试：仍失败 → 追加纠正提示，让模型重新输出一次
        → 再失败 → 降级为 issues = [] 并记录 warning
```

解析成功后还要**规范化**：`severity` 不在 `high/medium/low` 内的一律归为 `medium`，缺失字段补默认值。这一步保证了下游（分支判断、Fixer 渲染）拿到的数据结构永远合法。

## 6. 错误处理策略

分四层，各层只处理自己兜得住的问题：

| 层 | 失败场景 | 策略 |
|---|---|---|
| **LLM 层**（llmClient） | 超时、限流、5xx、DNS/连接失败 | 指数退避重试（`2^attempt` 秒，1s→2s→…）；401/400 等客户端错误最多再试一次即放弃；最终抛错并保留 `cause` |
| **Agent 层** | 代码块解析失败 | 回退为「整段输出当代码」并 warning，不中断流程 |
| **Agent 层** | 审查 JSON 解析失败 | 追加纠正提示重试 1 次；仍失败则 `issues = []` + warning |
| **Workflow 层** | 节点执行抛异常 | `agent.run` 外层 try/catch，**重试 1 次**；仍失败则 `status = "failed"`、写入 `error` 字段并立即返回，不再执行后续节点 |
| **Workflow 层** | 死循环 | `steps > maxSteps(20)` 抛错 + `status = failed` |
| **Workflow 层** | 关键字段缺失 | 执行节点前检查（如 reviewer 依赖 `code`），缺失只记 warning，不中断（避免因一个空字段让整个流程白跑） |
| **日志层** | 日志文件写入失败 | 自动降级为「仅控制台输出」，主流程不受影响 |
| **入口层** | 配置缺失 / 需求为空 / 需求文件读不到 | 红字提示 + `exit(1)`，绝不带着空需求去烧 Token |
| **入口层** | 最终代码为空 | 输出前检查并明确提示「流程可能异常」 |

设计原则是**「能在下层修好的就不要上抛，上抛的必须带足诊断信息」**：工具错误变成字符串给模型自查，模型格式错误原地纠正，只有真正致命的错误才让 Workflow 停下并把 `cause`、`status`、`code` 一并暴露出来。

## 7. 可扩展性

### 7.1 如何新增 Agent（3 步）

以「测试 Agent」为例：

1. `src/agents/testerAgent.js`：继承 `BaseAgent`，实现 `run(input, state)`，内部可以用 `useTool("execute_code", ...)` 真的把生成的代码跑一遍。
2. `src/workflow/nodes.js`：加一个节点
   ```js
   tester: {
     agent: new TesterAgent({ config, messageBus }),
     inputMapper: (state) => ({ code: state.get("code") }),
     outputMapper: (result, state) => { state.set("testReport", result.report); },
   }
   ```
3. `src/workflow/flows.js`：把 `"tester"` 加进 `nodes` 数组，并在 `condition` 里声明它在 `reviewer` 之后、`fixer` 之前，且测试失败时可以跳回 `coder`。

`orchestrator.js` / `state.js` / `messageBus.js` **一行都不用改**——这就是分层带来的可扩展性。

### 7.2 如何新增流程

`flows.js` 可以导出多个流程（`createFlow` / `createParallelFlow` / …），由入口层通过 `--flow` 参数选择。由于编排器只依赖 `{nodes, entry, condition}` 这个接口，加流程不需要动编排器。

### 7.3 并行执行

当前节点是串行的。要支持并行，有两种由浅入深的改法：

1. **节点内并行**：`inputMapper` 返回的对象不变，让某个 Agent 内部用 `Promise.all` 跑多次 LLM 调用（例如同时生成 3 个方案）。
2. **真正的 DAG 编排**：把 `condition` 换成 `{next: string[]}`，编排器用 `Promise.all` 执行同层节点，再用一个「汇合节点」等待全部完成。此时 State 需要加锁或改为「按字段合并」以避免并发写冲突（`state.set` 目前是同步的，天然支持字段级无冲突写）。

### 7.4 接入可视化

接可视化界面需要的东西现在都已经具备：

- `flows.js` 的 `{nodes, entry, condition}` 本身就是图的**静态结构**（节点 + 边）；
- `MessageBus` 的 `node:done` 事件流是图的**动态执行轨迹**（哪一步在跑、跑到哪了）；
- `WorkflowLogger` 的 JSONL 是**执行历史**，可用于回放。

因此做一个 Web 界面只需：后端把 `node:done` 用 SSE/WebSocket 推给前端，前端把节点按 `nodes` 布局、按事件高亮当前节点即可——Workflow 层无需改动。

## 8. 边界情况与优化建议

| # | 边界情况 | 处理方案 | 可优化方向 |
|---|---|---|---|
| 1 | **LLM 输出非法 JSON**（reviewer） | 提取 ```` ```json ```` 代码块 → `JSON.parse` → 去尾随逗号重试 → 仍失败则追加纠正提示再请求一次 → 最终降级 `issues = []` + warning | 改用 function calling / JSON Schema 强约束（DeepSeek 与 OpenAI 均支持） |
| 2 | **代码块解析失败**（coder/fixer） | 正则 `` ```(?:javascript\|js)?\n([\s\S]*?)``` ``，失败则回退任意语言代码块，再失败则整段输出当代码 + warning | 让模型输出带唯一分隔标记，便于精确切分 |
| 3 | **Workflow 死循环** | Orchestrator `steps > 20` 抛错；`condition` 检查 `iteration >= maxIterations` | 把安全上限做成可配置项；对「代码连续两轮无变化」也做熔断 |
| 4 | **单个 Agent 调用失败** | `try/catch` + 重试 1 次；仍失败则 `status = "failed"`、写 `error` 并停止后续节点 | 支持从失败节点断点续跑（快照已具备这个基础） |
| 5 | **State 字段缺失** | `inputMapper` 用 `state.get(key)` 取，Agent prompt 里对空值有明确措辞（如「需求为空」「无代码可审查」）；Orchestrator 对关键字段记 warning | 给节点声明式地标注 `requires: ["code"]`，由编排器统一校验 |
| 6 | **API 超时 / 限流** | 复用项目 1 的 `llmClient`：`instanceof` 判定 + 错误码 + 文本兜底三重识别，指数退避重试 | 加抖动（jitter）避免多 Agent 同时重试造成惊群 |
| 7 | **需求为空** | 入口层校验，红字提示 + `exit(1)` | 支持从 stdin 读取需求，便于管道调用 |
| 8 | **最终代码为空** | 入口层输出前检查，明确提示「流程可能异常，请检查日志」 | 在 Workflow 层就判定失败，而不是留给入口层兜 |
| 9 | **上下文记忆溢出** | 复用项目 1 的 `Memory`：保留 system + 最近 `maxMemoryTurns * 2` 条 | 对长代码改用「摘要 + 引用」而不是全量重塞 |
| 10 | **日志文件写入失败** | try/catch 降级为仅控制台输出，主流程继续 | 增加内存日志上限与定期 flush，避免长跑占内存 |
| 11 | **模型把正确代码也报成问题** | Reviewer 的 Prompt 明确「没有问题时 issues 必须是空数组，不要为了凑数编造问题」 | 增加「问题必须能在代码中定位到具体位置」的自检环节 |
| 12 | **修复后引入新问题导致不收敛** | `maxIterations` 熔断；Fixer Prompt 约束「不要顺手重构、保留原有接口」 | 记录每轮 issues 数量，若连续两轮不下降则提前结束并告警 |

## 9. 与项目 1 的复用关系

| 模块 | 复用方式 | 说明 |
|---|---|---|
| `src/core/llmClient.js` | **原样复用（字节级一致）** | 含修复后的错误分类：`instanceof` 判定 + undici 错误码 + 文本兜底，指数退避，保留 `cause` |
| `src/core/memory.js` | **原样复用（字节级一致）** | 数组记忆 + 滑动窗口裁剪，system 消息永久保留 |
| `src/tools/registry.js` | **原样复用（字节级一致）** | `callTool(name, args)` 统一调度，异常转 `ERROR:` 字符串 |
| `src/tools/fileTool.js` | **原样复用（字节级一致）** | `read_file`，含 200KB 上限与行号输出 |
| `src/tools/codeTool.js` | **原样复用（字节级一致）** | `execute_code`，vm 沙箱 + 黑名单 + 5s 超时 |
| `src/core/prompts.js` | **重写**（不同职责） | 项目 1 是审查专用的 System Prompt；本项目改为通用片段 `FORMAT_CODE_BLOCK` / `SUMMARY_INSTRUCTION` |
| 审查能力 | **Prompt 经验复用** | 项目 1 的「按严重程度分级、给出位置/原因/建议」被继承下来，但输出格式从 Markdown 报告改为 **严格 JSON**——因为 Workflow 的分支判断需要结构化数据 |
| 架构经验 | **分层复用** | 入口层薄、核心层厚、工具层错误字符串化，这套分层直接沿用 |

> 复用的前提是「被复用模块的接口足够窄」：`llmClient` 只暴露 `chat(messages, temperature)`，
> `memory` 只暴露数组读写，工具只暴露「对象参数进、字符串出」。正因为它们不依赖项目 1 的任何业务概念，
> 才能被直接搬过来。这也是分层架构带来的最实际的好处。
