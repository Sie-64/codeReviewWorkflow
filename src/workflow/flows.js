/**
 * @file flows.js
 * @description 【Workflow 层】声明式流程定义。
 *              流程 = 节点顺序（nodes） + 流转规则（condition）。
 *              编排器只负责「照着跑」，因此新增/调整流程只需要动这个文件。
 */

/**
 * 用工厂函数生成流程，好处是能把 `config`（如 maxIterations）闭包进 condition，
 * 而不必让 condition 去读全局变量。
 *
 * @param {ReturnType<import("../config.js").loadConfig>} config - 全局配置。
 * @returns {{
 *   name: string,
 *   nodes: string[],
 *   entry: string,
 *   condition: (currentNode: string, state: import("./state.js").WorkflowState) => string,
 *   describe: () => string
 * }} 流程定义。
 */
export function createFlow(config) {
  /**
   * 流转条件。
   *
   * 返回值语义（编排器据此决定下一步）：
   * - `"NEXT"`：沿 `nodes` 顺序走下一个节点；
   * - `"END"`：流程结束；
   * - 其他字符串：跳转到指定节点（例如回到 "reviewer" 形成循环）。
   *
   * @param {string} currentNode - 当前节点名。
   * @param {import("./state.js").WorkflowState} state - 共享状态。
   * @returns {string} 下一步：`"NEXT"` | `"END"` | 节点名。
   */
  function condition(currentNode, state) {
    if (currentNode === "coder") {
      // 编码完成 → 顺序进入 reviewer
      return "NEXT";
    }

    if (currentNode === "reviewer") {
      const issues = state.get("issues") || [];
      // 没有问题时直接结束：这是「条件分支」的关键出口
      if (issues.length === 0) return "END";

      const iteration = state.get("iteration") || 0;
      // 达到最大迭代轮次时不再修复，避免无限循环
      if (iteration >= config.maxIterations) return "END";

      return "fixer";
    }

    if (currentNode === "fixer") {
      // 修复完成 → 回到 reviewer 复检，形成循环
      return "reviewer";
    }

    return "NEXT";
  }

  return {
    name: "code-review",
    nodes: ["coder", "reviewer", "fixer"],
    entry: "coder",
    condition,

    /**
     * 生成人类可读的流程描述，用于 CLI 展示与日志。
     *
     * @returns {string} 流程描述文本。
     */
    describe() {
      return [
        `流程名称：${this.name}`,
        `入口节点：${this.entry}`,
        `节点顺序：${this.nodes.join(" → ")}`,
        `流转规则：coder → NEXT(reviewer)；reviewer → issues 为空 ? END : (iteration >= ${config.maxIterations} ? END : fixer)；fixer → reviewer`,
      ].join("\n");
    },
  };
}
