/**
 * @file fixerAgent.js
 * @description 【Agent 层】修复 Agent：根据审查问题清单修复代码。
 *              与编码 Agent 的区别是：输入里多了 issues，prompt 明确要求「只改问题、别改对的地方」。
 */

import { BaseAgent, extractCodeBlock } from "./baseAgent.js";

/** 修复 Agent 的系统提示词。 */
const FIXER_SYSTEM_PROMPT = `你是一名资深软件工程师，擅长根据审查意见修复代码。

你的职责是接收一段代码与一份问题清单，产出修复后的完整代码。

工作原则：
- 逐条修复问题清单中的问题，不要遗漏。
- 保留原有正确的逻辑与公开接口（函数名、参数、导出），不要顺手重构。
- 修复后的代码必须完整、可直接运行，不要用省略号或注释占位。
- 只输出一个 Markdown 代码块，不要输出任何解释、寒暄或代码块之外的文字。`;

/**
 * 把 issues 数组渲染成易读的清单文本，便于模型逐条处理。
 *
 * @param {Array<Record<string, any>>} issues - 问题列表。
 * @returns {string} 清单文本。
 */
function renderIssues(issues) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return "（本轮没有问题清单）";
  }
  return issues
    .map((issue, index) => {
      const severity = issue?.severity ?? "medium";
      const location = issue?.location ?? "未标注位置";
      const description = issue?.description ?? "";
      const suggestion = issue?.suggestion ?? "";
      return `${index + 1}. [${severity}] 位置：${location}\n   问题：${description}\n   建议：${suggestion}`;
    })
    .join("\n");
}

/**
 * 修复 Agent。
 */
export class FixerAgent extends BaseAgent {
  /**
   * @param {object} options - 构造参数。
   * @param {ReturnType<import("../config.js").loadConfig>} options.config - 全局配置。
   * @param {import("../workflow/messageBus.js").MessageBus} [options.messageBus] - 消息总线。
   */
  constructor({ config, messageBus }) {
    super({ name: "fixer", systemPrompt: FIXER_SYSTEM_PROMPT, config, messageBus });
  }

  /**
   * 根据问题清单修复代码。
   *
   * @param {{ code?: string, issues?: Array<Record<string, any>> }} input - 节点输入。
   * @returns {Promise<{ code: string, raw: string }>} 修复后的代码与模型原始输出。
   */
  async run(input) {
    const code = typeof input?.code === "string" ? input.code : "";
    const issues = Array.isArray(input?.issues) ? input.issues : [];

    if (code.trim() === "") {
      console.warn("[fixer] 输入代码为空，修复结果可能没有意义。");
    }

    const prompt = `请根据下面的问题清单修复代码，并输出修复后的完整代码。

# 待修复代码
\`\`\`javascript
${code}
\`\`\`

# 问题清单
${renderIssues(issues)}

# 输出要求
1. 逐条修复上述问题，不要遗漏。
2. 保留原有正确的逻辑与公开接口（函数名、参数、导出）。
3. 只输出一个 Markdown 代码块，语言标记为 javascript。
4. 不要输出任何解释、寒暄或代码块之外的文字。`;

    const raw = await this.callLLM(prompt);
    const fixedCode = extractCodeBlock(raw);

    this.publish("fixer:done", { code: fixedCode, fixedCount: issues.length });
    return { code: fixedCode, raw };
  }
}
