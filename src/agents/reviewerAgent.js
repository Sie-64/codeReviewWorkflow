/**
 * @file reviewerAgent.js
 * @description 【Agent 层】审查 Agent：审查代码并输出「结构化」问题清单。
 *              与项目 1 的自由文本报告不同，这里要求严格 JSON——
 *              因为下游的 FixerAgent 与流程条件（issues 是否为空）都依赖结构化数据。
 */

import { BaseAgent } from "./baseAgent.js";

/** 审查 Agent 的系统提示词。 */
const REVIEWER_SYSTEM_PROMPT = `你是一名资深代码审查专家，擅长发现代码中的 Bug、边界问题、安全隐患与可维护性缺陷。

你的职责是审查给定代码，并输出一份「严格 JSON」格式的审查结果。

工作原则：
- 只报告有依据的问题，不要臆测不存在的缺陷。
- 按严重程度区分 high / medium / low：
  - high：会导致错误结果、崩溃或数据损坏；
  - medium：边界情况未处理、健壮性不足；
  - low：可读性、可维护性、文档等改进建议。
- 代码没有问题时，issues 必须是空数组，不要为了凑数编造问题。
- 严格输出 JSON，不要输出解释文字、注释或尾随逗号。`;

/** 期望模型输出的 JSON 结构说明（写入 prompt，同时作为文档）。 */
const JSON_SCHEMA_HINT = `{
  "summary": "总体评价，1-3 句话",
  "issues": [
    {
      "severity": "high | medium | low",
      "location": "行号或函数名",
      "description": "问题描述",
      "suggestion": "修复建议"
    }
  ]
}`;

/**
 * 从 LLM 输出中提取 JSON 文本。
 *
 * 容错顺序：```json 代码块 → 任意代码块 → 第一个 `{` 到最后一个 `}` → 整段文本。
 *
 * @param {string} text - LLM 原始输出。
 * @returns {string} 候选 JSON 文本。
 */
function extractJsonText(text) {
  const raw = typeof text === "string" ? text : "";

  const jsonFence = raw.match(/```json[ \t]*\r?\n([\s\S]*?)```/i);
  if (jsonFence) return jsonFence[1].trim();

  const anyFence = raw.match(/```[a-zA-Z0-9]*[ \t]*\r?\n([\s\S]*?)```/);
  if (anyFence) return anyFence[1].trim();

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) return raw.slice(start, end + 1);

  return raw.trim();
}

/**
 * 尝试把文本解析为对象，失败时做最小化修复（去尾随逗号）后再试一次。
 *
 * @param {string} text - 候选 JSON 文本。
 * @returns {Record<string, any>|null} 解析结果；失败返回 null。
 */
function tryParseJson(text) {
  const candidates = [text, text.replace(/,\s*([}\]])/g, "$1")];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // 换下一种修复方式
    }
  }
  return null;
}

/**
 * 规范化 issues 数组：过滤非法项、收敛 severity 取值、补齐字段类型。
 *
 * @param {any} rawIssues - 模型给出的 issues。
 * @returns {Array<{severity: string, location: string, description: string, suggestion: string}>} 规范化结果。
 */
function normalizeIssues(rawIssues) {
  if (!Array.isArray(rawIssues)) return [];
  const allowed = new Set(["high", "medium", "low"]);
  return rawIssues
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const severity = String(item.severity ?? "").toLowerCase();
      return {
        severity: allowed.has(severity) ? severity : "medium",
        location: String(item.location ?? "未标注位置"),
        description: String(item.description ?? ""),
        suggestion: String(item.suggestion ?? ""),
      };
    });
}

/**
 * 审查 Agent。
 */
export class ReviewerAgent extends BaseAgent {
  /**
   * @param {object} options - 构造参数。
   * @param {ReturnType<import("../config.js").loadConfig>} options.config - 全局配置。
   * @param {import("../workflow/messageBus.js").MessageBus} [options.messageBus] - 消息总线。
   */
  constructor({ config, messageBus }) {
    super({ name: "reviewer", systemPrompt: REVIEWER_SYSTEM_PROMPT, config, messageBus });
  }

  /**
   * 构造本轮审查的 prompt。
   *
   * @param {string} code - 待审查代码。
   * @returns {string} prompt 文本。
   */
  _buildPrompt(code) {
    return `请审查下面的 JavaScript 代码。

# 待审查代码
\`\`\`javascript
${code}
\`\`\`

# 输出要求（必须严格遵守）
只输出一个 Markdown 代码块，语言标记为 json，内容为严格 JSON，不要有任何代码块之外的文字：

\`\`\`json
${JSON_SCHEMA_HINT}
\`\`\`

# 约束
- severity 只能是 "high"、"medium"、"low" 三者之一。
- 没有问题时，issues 必须是空数组 []。
- JSON 必须能被 JSON.parse 直接解析：不要注释、不要尾随逗号、不要使用中文引号。`;
  }

  /**
   * 审查代码，输出结构化审查结果。
   *
   * @param {{ code?: string }} input - 节点输入。
   * @returns {Promise<{ report: Record<string, any>, issues: Array<object>, raw: string }>} 审查结果。
   */
  async run(input) {
    const code = typeof input?.code === "string" ? input.code : "";
    if (code.trim() === "") {
      console.warn("[reviewer] 输入代码为空，将按「无代码可审查」处理。");
    }

    const raw = await this.callLLM(this._buildPrompt(code));
    let parsed = tryParseJson(extractJsonText(raw));

    // 解析失败 → 追加纠正提示，重试 1 次（对应规格书边界情况 #1）
    if (!parsed) {
      console.warn("[reviewer] 首次输出不是合法 JSON，已追加纠正提示并重试一次。");
      const retryRaw = await this.callLLM(
        `你上一条输出不是合法 JSON，无法被 JSON.parse 解析。请重新输出，只包含一个 \`\`\`json 代码块，结构如下：

\`\`\`json
${JSON_SCHEMA_HINT}
\`\`\`

要求：不要输出任何解释文字，不要使用注释与尾随逗号。`,
      );
      parsed = tryParseJson(extractJsonText(retryRaw));
    }

    // 仍然失败 → 降级：issues 置空并记录 warning
    if (!parsed) {
      console.warn("[reviewer] JSON 解析连续失败，已降级为「无问题」结果，请人工确认。");
      const fallback = { summary: "审查结果解析失败，未能获得结构化问题清单。", issues: [] };
      this.publish("reviewer:done", { issues: 0, degraded: true });
      return { report: fallback, issues: [], raw };
    }

    const issues = normalizeIssues(parsed.issues);
    const report = {
      summary: String(parsed.summary ?? ""),
      issues,
    };

    this.publish("reviewer:done", { issues: issues.length, summary: report.summary });
    return { report, issues, raw };
  }
}
