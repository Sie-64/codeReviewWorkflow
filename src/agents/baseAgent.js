/**
 * @file baseAgent.js
 * @description 【Agent 层】Agent 基类。
 *              统一三件事：LLM 调用（带记忆）、工具调用、消息收发。
 *              子类只需要关心「拿什么输入、产出什么结果」，不必重复处理通信与记忆细节。
 */

import { LLMClient } from "../core/llmClient.js";
import { Memory } from "../core/memory.js";
import { callTool } from "../tools/registry.js";

/**
 * 从 LLM 输出中提取 Markdown 代码块内容。
 *
 * 容错顺序：优先匹配 ```javascript / ```js 代码块 → 其次匹配任意语言标记的代码块 →
 * 都失败则把整段输出当作代码，并打印 warning（对应规格书边界情况 #2）。
 *
 * @param {string} text - LLM 原始输出。
 * @returns {string} 提取到的代码正文。
 */
export function extractCodeBlock(text) {
  const raw = typeof text === "string" ? text : "";

  const jsFence = raw.match(/```(?:javascript|js)[ \t]*\r?\n([\s\S]*?)```/i);
  if (jsFence && jsFence[1].trim() !== "") {
    return jsFence[1].replace(/\s+$/, "");
  }

  const anyFence = raw.match(/```[a-zA-Z0-9]*[ \t]*\r?\n([\s\S]*?)```/);
  if (anyFence && anyFence[1].trim() !== "") {
    console.warn("[agent] 未识别到 javascript 代码块，已回退为任意语言代码块。");
    return anyFence[1].replace(/\s+$/, "");
  }

  console.warn("[agent] 未找到 Markdown 代码块，已整段输出当作代码处理。");
  return raw.trim();
}

/**
 * Agent 基类。
 */
export class BaseAgent {
  /**
   * @param {object} options - 构造参数。
   * @param {string} options.name - Agent 名称（同时作为消息的 from 字段）。
   * @param {string} options.systemPrompt - 该 Agent 的系统提示词。
   * @param {ReturnType<import("../config.js").loadConfig>} options.config - 全局配置。
   * @param {import("../workflow/messageBus.js").MessageBus} [options.messageBus] - 消息总线（可选）。
   */
  constructor({ name, systemPrompt, config, messageBus }) {
    /** @type {string} Agent 名称。 */
    this.name = name;
    /** @type {string} 系统提示词。 */
    this.systemPrompt = systemPrompt;
    /** @type {object} 全局配置。 */
    this.config = config;
    /** @type {import("../workflow/messageBus.js").MessageBus|null} 消息总线。 */
    this.messageBus = messageBus ?? null;

    /** @type {LLMClient} LLM 客户端（每个 Agent 独立持有，互不干扰）。 */
    this.llm = new LLMClient(config);
    /** @type {Memory} 独立记忆。 */
    this.memory = new Memory(config);
    this.memory.add("system", systemPrompt);
  }

  /**
   * 执行该 Agent 的核心逻辑（抽象方法，子类必须实现）。
   *
   * @abstract
   * @param {any} input - 由节点的 inputMapper 构造的输入。
   * @param {import("../workflow/state.js").WorkflowState} state - 共享状态。
   * @throws {Error} 基类未实现时抛出。
   * @returns {Promise<any>} 任意结果对象，交给 outputMapper 处理。
   */
  async run(input, state) {
    throw new Error(`Agent ${this.name} 未实现 run(input, state) 方法。`);
  }

  /**
   * 调用 LLM：把用户消息写入记忆 → 请求模型 → 把回复写入记忆 → 返回回复文本。
   *
   * @param {string} userMessage - 本轮用户消息。
   * @param {number} [temperature=0.2] - 采样温度。
   * @returns {Promise<string>} 模型回复文本。
   */
  async callLLM(userMessage, temperature = 0.2) {
    this.memory.add("user", userMessage);
    const reply = await this.llm.chat(this.memory.get(), temperature);
    this.memory.add("assistant", reply);
    return reply;
  }

  /**
   * 调用工具，并把结果作为 Observation 写入记忆。
   *
   * @param {string} toolName - 工具名（read_file / execute_code）。
   * @param {Record<string, any>} args - 工具参数对象。
   * @returns {Promise<string>} 工具返回结果或 "ERROR: ..." 错误信息。
   */
  async useTool(toolName, args) {
    const result = await callTool(toolName, args);
    this.memory.add("user", `Observation: ${result}`);
    return result;
  }

  /**
   * 通过消息总线发布一条消息（未注入总线时静默跳过）。
   *
   * @param {string} topic - 主题名。
   * @param {any} payload - 消息负载。
   * @returns {void}
   */
  publish(topic, payload) {
    this.messageBus?.publish(topic, payload, this.name);
  }

  /**
   * 重置记忆：清空历史，仅保留 system 消息。
   *
   * @returns {void}
   */
  reset() {
    this.memory.clear();
    this.memory.add("system", this.systemPrompt);
  }
}
