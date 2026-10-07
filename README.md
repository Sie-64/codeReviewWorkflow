# Code Review Workflow（多 Agent 协作工作流）

> 三个 Agent 协作的代码审查 Workflow：**编码 Agent → 审查 Agent → 修复 Agent**，审查有问题就自动进入修复、修完再审查，直到问题清零或达到最大轮次。

## 1. 项目简介

本项目是 **Simple Workflow MVP（2 Weeks）** 作业的实现，方向为 **代码审查流程**。

它由 3 个职责单一的 Agent 组成，通过**共享 State + 消息总线**协作：

| Agent | 职责 | 读 | 写 |
|---|---|---|---|
| `CoderAgent` | 根据需求生成初版代码 | `requirement` | `code` |
| `ReviewerAgent` | 审查代码，输出**结构化问题清单** | `code` | `reviewReport`、`issues` |
| `FixerAgent` | 按问题清单修复代码 | `code`、`issues` | `code`、`iteration` |

核心特性：

- 🔁 **条件分支 + 循环**：`issues` 为空则审查后直接结束；不为空则进修复，修完回到审查复检（受 `WORKFLOW_MAX_ITERATIONS` 限制）
- 🧩 **声明式流程**：流程写在 `flows.js` 的 `condition` 里，编排器不含任何硬编码流程
- 📡 **Agent 间通信**：Agent 不互相调用，全部通过 `WorkflowState` 读写 + `MessageBus` 广播
- 🗂️ **状态可追溯**：每次 `state.set()` 自动打深拷贝快照，可回放「哪个节点改了什么」
- 📝 **执行日志**：`logs/workflow-<时间戳>.jsonl` 记录每一步
- 🛡️ **错误处理**：LLM 指数退避重试；节点失败重试 1 次；JSON 解析失败自动纠正重试；死循环安全上限

## 2. 环境安装

要求 **Node.js >= 18**。

```bash
node --version   # 需 >= 18
npm install
cp .env.example .env
```

> Windows（PowerShell）下复制命令为：`copy .env.example .env`

> ⚠️ **`cp .env.example .env` 只做一次。** 如果 `.env` 已经配置好，再执行这条命令会把你的 Key 覆盖回模板占位符
> `your_api_key_here`，之后运行会收到 401（报错长这样：`401 Authentication Fails, Your api key: ****here is invalid`）。
> 遇到这个报错先打开 `.env` 确认 Key 是不是被覆盖了。

## 3. 配置 API Key

编辑项目根目录的 `.env`（本项目当前默认接入 **DeepSeek**）：

```dotenv
OPENAI_API_KEY=sk-你的密钥
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat
```

### 切换模型

只需改 `OPENAI_BASE_URL` 与 `OPENAI_MODEL` 两项，代码无需任何改动：

| 服务 | OPENAI_BASE_URL | OPENAI_MODEL 示例 |
|---|---|---|
| **DeepSeek（当前默认）** | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 通义千问（DashScope 兼容模式） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Kimi（Moonshot） | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |

其余可调参数：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LLM_TIMEOUT` | `60000` | 单次 LLM 请求超时（毫秒） |
| `LLM_MAX_RETRIES` | `3` | 单次请求最大重试次数（指数退避） |
| `AGENT_MAX_MEMORY_TURNS` | `10` | 单 Agent 记忆保留的最大对话轮数 |
| `WORKFLOW_MAX_ITERATIONS` | `3` | 「修复 → 再审查」的最大迭代轮次 |

## 4. 如何运行

```bash
# 1) 用需求文件跑完整流程（推荐先跑这个）
npm run demo
# 等价于
npm start -- --requirement examples/requirements.md

# 2) 直接传需求文本
npm start -- --requirement-text "实现一个加法函数 add(a, b)，非法参数要抛错"

# 3) 把最终代码落盘
npm start -- --requirement examples/requirements.md --out output/todolist.js

# 4) 看更细的调试日志（节点输入等）
npm start -- --requirement examples/requirements.md --verbose
```

运行时会看到节点执行顺序，例如「有问题」的情况：

```
▶ 执行节点：coder
✔ 节点完成：coder
↳ 流转到下一个节点：reviewer
▶ 执行节点：reviewer
✔ 节点完成：reviewer
↳ 流转到下一个节点：fixer
▶ 执行节点：fixer
✔ 节点完成：fixer
↳ 流转到下一个节点：reviewer
▶ 执行节点：reviewer
✔ 节点完成：reviewer
⏹ 流程结束
```

若代码本身没问题，`reviewer` 之后直接 `⏹ 流程结束`，不会进入 `fixer`。

## 5. 流程图

```
[用户输入需求]
       │
       ▼
┌──────────────┐
│  CoderAgent  │  根据需求生成初版代码
│   编码        │  写入 State.code
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ ReviewerAgent│  审查 State.code
│   审查        │  输出 issues 列表 → State.reviewReport
└──────┬───────┘
       │
       ▼
   ┌───────────────┐
   │ 条件判断：     │
   │ issues 为空？  │
   └───┬───────┬───┘
       │是     │否
       │       ▼
       │  ┌──────────────┐
       │  │  FixerAgent  │  根据 issues 修复代码
       │  │   修复        │  写回 State.code
       │  └──────┬───────┘
       │         │
       │         ▼
       │    ┌─────────────────┐
       │    │ 循环判断：       │
       │    │ 轮次 < 最大轮次？│
       │    └───┬─────────┬───┘
       │        │是       │否
       │        └────┐    │
       │             │    │
       │    ┌────────▼────▼───┐
       │    │ 回到 Reviewer   │
       │    └─────────────────┘
       │
       ▼
[输出最终代码 + 审查报告 + 执行日志]
```

## 6. 项目结构

```
code-review-workflow/
│
├── package.json                     # 项目清单
├── .env.example                     # 环境变量模板
├── .gitignore
│
├── src/
│   ├── index.js                     # 【入口层】CLI 入口
│   │
│   ├── config.js                    # 【配置层】环境变量
│   │
│   ├── core/                        # 【核心层】与项目1类似
│   │   ├── llmClient.js             # LLM 调用封装（复用项目1）
│   │   ├── memory.js                # 单 Agent 记忆（复用项目1）
│   │   └── prompts.js               # 通用 Prompt 片段
│   │
│   ├── agents/                      # 【Agent 层】每个 Agent 一个文件
│   │   ├── baseAgent.js             # Agent 基类：统一 LLM 调用 + 工具 + 消息收发
│   │   ├── coderAgent.js            # 编码 Agent
│   │   ├── reviewerAgent.js         # 审查 Agent（复用项目1的审查能力）
│   │   └── fixerAgent.js            # 修复 Agent
│   │
│   ├── workflow/                    # 【Workflow 层】编排核心
│   │   ├── state.js                 # 共享状态 State（读写 + 快照）
│   │   ├── messageBus.js            # 消息总线（Agent 间通信）
│   │   ├── orchestrator.js          # 编排器：按流程调度 Agent
│   │   ├── nodes.js                 # 节点定义：每个节点 = 一个 Agent + 输入输出映射
│   │   └── flows.js                 # 流程定义：声明式描述流程（顺序 + 条件 + 循环）
│   │
│   └── tools/                       # 【工具层】复用项目1
│       ├── registry.js              # 工具注册表
│       ├── fileTool.js              # read_file
│       └── codeTool.js              # execute_code
│
├── examples/
│   └── requirements.md              # 示例需求文档（编码 Agent 的输入）
│
├── logs/                            # 运行日志输出目录（.gitignore）
│
├── README.md
└── Design.md
```

## 7. 状态字段说明

| 字段 | 写入者 | 读取者 | 说明 |
|---|---|---|---|
| `requirement` | 入口层 | CoderAgent | 用户需求 |
| `code` | CoderAgent / FixerAgent | ReviewerAgent / 输出 | 当前代码 |
| `reviewReport` | ReviewerAgent | FixerAgent / 输出 | 审查报告（结构化） |
| `issues` | ReviewerAgent | 条件判断 / FixerAgent | 问题列表 |
| `iteration` | Orchestrator | 循环判断 | 当前轮次 |
| `history` | MessageBus | 日志 / 输出 | 所有消息记录 |
| `status` | Orchestrator | 入口层 | running / done / failed |

> 说明：`history` 由消息总线保存，通过 `messageBus.getHistory()` 读取；其余字段存在 `WorkflowState` 中。
> 另外 Orchestrator 在失败时会写入 `error` 字段。

## 8. 如何扩展

### 新增一个 Agent（例如「测试 Agent」）

只需改 3 个文件：

1. **写 Agent 文件**：`src/agents/testerAgent.js`，继承 `BaseAgent` 并实现 `run(input, state)`。
2. **在 `nodes.js` 注册节点**：`tester: { agent: new TesterAgent({config, messageBus}), inputMapper, outputMapper }`。
3. **在 `flows.js` 引用节点**：把 `"tester"` 加进 `nodes` 数组，并在 `condition` 里声明它前后的流转规则。

编排器（`orchestrator.js`）与状态、通信层**完全不需要修改**。

### 修改流程

只改 `src/workflow/flows.js` 的 `condition` 函数即可，返回值语义：

| 返回值 | 含义 |
|---|---|
| `"NEXT"` | 沿 `nodes` 顺序走下一个节点 |
| `"END"` | 流程结束 |
| 其他字符串 | 跳转到指定节点（如 `"reviewer"` 形成循环） |

例如想加一个「测试失败就打回重编码」的分支，只需在 `condition` 里对 `currentNode === "tester"` 增加判断。

## 9. 注意事项

- ⚠️ **`execute_code` 不是安全沙箱**。`node:vm` 只做上下文隔离，仍存在逃逸可能；本项目用黑名单、长度限制、5 秒超时、关闭动态代码生成来降低风险。生产环境请改用 `worker_threads` + 超时或独立容器。
- 🔁 **循环次数由 `WORKFLOW_MAX_ITERATIONS` 控制**。达到上限后流程会在 `reviewer` 之后直接结束（即使仍有问题），这是刻意的熔断设计——避免模型陷入「改不完」的死循环。
- 🧮 **迭代计数含义**：`iteration` 统计的是「已经执行了几轮修复」。默认 3 表示最多修 3 轮，总计最多 4 次审查。
- 🧾 **审查 JSON 解析失败会降级**：连续两次解析失败时，`issues` 会被置空并记录 warning。此时流程会判定「无问题」而提前结束，请务必人工确认日志。
- 💰 **Token 成本**：一轮完整流程最少 2 次 LLM 调用（coder + reviewer），每多修复一轮 +2 次（fixer + reviewer）。
- 🚪 **API Key 为空会直接退出**：CLI 会以红字提示并在退出码 `1` 结束。
