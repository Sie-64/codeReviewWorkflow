/**
 * @file prompts.js
 * @description 【核心层】通用 Prompt 片段。
 *              多个 Agent 都要「把代码包成代码块」或「按要求总结」，统一收敛在这里，
 *              避免各 Agent 各写一份、口径不一致。
 */

/**
 * 把一段代码包成 Markdown 代码块。
 *
 * @param {string} lang - 代码语言标记（如 "javascript"）。
 * @param {string} code - 代码正文。
 * @returns {string} 形如 ```javascript\ncode\n``` 的 Markdown 代码块。
 */
export function FORMAT_CODE_BLOCK(lang, code) {
  const safeLang = typeof lang === "string" ? lang.trim() : "";
  const safeCode = typeof code === "string" ? code : String(code ?? "");
  return `\`\`\`${safeLang}\n${safeCode}\n\`\`\``;
}

/**
 * 通用总结指令：要求模型在给出结论时先概括、再列要点、不要空话。
 *
 * @type {string}
 */
export const SUMMARY_INSTRUCTION = `输出结论时请遵循以下要求：
1. 先用 1-3 句话给出总体判断（做了什么、结论是什么）。
2. 再按要点列出关键信息，每条只讲一件事，避免重复与空话。
3. 如果存在不确定的地方，请明确说明，不要编造。`;
