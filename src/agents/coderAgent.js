/**
 * @file coderAgent.js
 * @description 【Agent 层】编码 Agent：根据需求生成初版代码。
 *              Workflow 的第一个节点，负责把自然语言需求变成可审查的代码。
 */

import { BaseAgent, extractCodeBlock } from "./baseAgent.js";

/** 编码 Agent 的系统提示词。 */
const CODER_SYSTEM_PROMPT = `你是一名资深软件工程师，擅长根据需求编写高质量、可运行的代码。

你的职责是根据给定的需求，产出一份完整、可直接运行的 JavaScript（Node.js，ESM）实现。

工作原则：
- 严格按需求实现功能，不要自行增加需求之外的功能。
- 代码要完整可运行，包含必要的 export，不要使用伪代码或省略号占位。
- 对边界情况（空输入、非法参数、越界等）做出合理处理，并让行为可预期。
- 只输出一个 Markdown 代码块，不要输出任何解释、寒暄或代码块之外的文字。`;

/**
 * 编码 Agent。
 */
export class CoderAgent extends BaseAgent {
  /**
   * @param {object} options - 构造参数。
   * @param {ReturnType<import("../config.js").loadConfig>} options.config - 全局配置。
   * @param {import("../workflow/messageBus.js").MessageBus} [options.messageBus] - 消息总线。
   */
  constructor({ config, messageBus }) {
    super({ name: "coder", systemPrompt: CODER_SYSTEM_PROMPT, config, messageBus });
  }

  /**
   * 根据需求生成代码。
   *
   * @param {{ requirement?: string }} input - 节点输入。
   * @returns {Promise<{ code: string, raw: string }>} 提取到的代码与模型原始输出。
   */
  async run(input) {
    const requirement = typeof input?.requirement === "string" ? input.requirement.trim() : "";
    if (requirement === "") {
      console.warn("[coder] 输入需求为空，将请模型生成一个最小占位实现。");
    }

    const prompt = `请根据下面的需求编写完整、可直接运行的 JavaScript 代码。

# 需求
${requirement === "" ? "（需求为空，请生成一个最小可运行的占位模块并说明用途）" : requirement}

# 输出要求
1. 只输出一个 Markdown 代码块，语言标记为 javascript。
2. 代码必须完整：包含全部函数/类定义与必要的 export，不要用省略号或注释占位。
3. 处理边界情况（空输入、非法参数等），行为要明确。
4. 不要输出任何解释、寒暄或代码块之外的文字。`;

    const raw = await this.callLLM(prompt);
    const code = extractCodeBlock(raw);

    this.publish("coder:done", { code });
    return { code, raw };
  }
}
