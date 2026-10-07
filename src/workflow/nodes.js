/**
 * @file nodes.js
 * @description 【Workflow 层】节点注册表。
 *              一个「节点」= 一个 Agent 实例 + inputMapper（State → Agent 输入）
 *              + outputMapper（Agent 结果 → State）。把「Agent 怎么跑」和「数据怎么流」分开。
 */

import { CoderAgent } from "../agents/coderAgent.js";
import { ReviewerAgent } from "../agents/reviewerAgent.js";
import { FixerAgent } from "../agents/fixerAgent.js";

/**
 * 创建全部节点。
 *
 * @param {object} options - 构造参数。
 * @param {ReturnType<import("../config.js").loadConfig>} options.config - 全局配置。
 * @param {import("./messageBus.js").MessageBus} [options.messageBus] - 消息总线。
 * @returns {Record<string, {agent: import("../agents/baseAgent.js").BaseAgent, inputMapper: Function, outputMapper: Function}>} 节点注册表。
 */
export function createNodes({ config, messageBus }) {
  return {
    /**
     * 编码节点：需求 → 代码。
     * 读：state.requirement ｜ 写：state.code
     */
    coder: {
      agent: new CoderAgent({ config, messageBus }),
      inputMapper: (state) => ({ requirement: state.get("requirement") }),
      outputMapper: (result, state) => {
        state.set("code", result.code);
      },
    },

    /**
     * 审查节点：代码 → 结构化审查报告。
     * 读：state.code ｜ 写：state.reviewReport、state.issues
     */
    reviewer: {
      agent: new ReviewerAgent({ config, messageBus }),
      inputMapper: (state) => ({ code: state.get("code") }),
      outputMapper: (result, state) => {
        state.set("reviewReport", result.report);
        state.set("issues", result.issues);
      },
    },

    /**
     * 修复节点：代码 + 问题清单 → 修复后的代码。
     * 读：state.code、state.issues ｜ 写：state.code、state.iteration
     */
    fixer: {
      agent: new FixerAgent({ config, messageBus }),
      inputMapper: (state) => ({
        code: state.get("code"),
        issues: state.get("issues"),
      }),
      outputMapper: (result, state) => {
        state.set("code", result.code);
        state.set("iteration", (state.get("iteration") || 0) + 1);
      },
    },
  };
}
