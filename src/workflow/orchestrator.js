/**
 * @file orchestrator.js
 * @description 【Workflow 层】编排器：按 flows.js 的声明调度 Agent，并负责日志与错误兜底。
 *              编排器不认识任何具体 Agent，只认识「节点」这个抽象，因此加节点/改流程不必改它。
 */

import fs from "node:fs";
import path from "node:path";

/** 各节点执行前必须存在的关键字段，缺失时记录 warning（对应规格书边界情况 #5）。 */
const REQUIRED_FIELDS = {
  coder: ["requirement"],
  reviewer: ["code"],
  fixer: ["code"],
};

/**
 * Workflow 执行日志器：内存留痕 + JSONL 文件持久化。
 *
 * 文件写入失败时自动降级为「仅控制台输出」，不影响主流程。
 */
export class WorkflowLogger {
  /**
   * @param {object} [options] - 构造参数。
   * @param {string} [options.dir="logs"] - 日志目录。
   * @param {boolean} [options.verbose=false] - 是否输出 debug 级日志。
   * @param {boolean} [options.echo=true] - 是否把日志回显到控制台。
   */
  constructor({ dir = "logs", verbose = false, echo = true } = {}) {
    this.dir = dir;
    this.verbose = verbose;
    this.echo = echo;
    /** @type {Array<Record<string, any>>} 内存中的日志条目。 */
    this.entries = [];
    /** @type {string|null} 日志文件路径。 */
    this.filePath = null;
    /** @type {boolean} 日志文件当前是否可写。 */
    this.fileWritable = false;

    this._initFile();
  }

  /**
   * 初始化日志文件；失败则降级为仅控制台输出。
   *
   * @private
   * @returns {void}
   */
  _initFile() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // ISO 时间里的冒号在 Windows 上是非法文件名，这里统一替换
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.filePath = path.join(this.dir, `workflow-${stamp}.jsonl`);
      fs.appendFileSync(this.filePath, "", "utf-8");
      this.fileWritable = true;
    } catch (err) {
      this.fileWritable = false;
      this.filePath = null;
      console.error(`[logger] 日志文件初始化失败，降级为仅控制台输出：${err.message}`);
    }
  }

  /**
   * 追加一条日志。
   *
   * @param {string} message - 日志正文。
   * @param {Record<string, any>} [extra={}] - 附加结构化字段。
   * @returns {Record<string, any>} 写入的日志条目。
   */
  log(message, extra = {}) {
    const entry = { timestamp: new Date().toISOString(), message, ...extra };
    this.entries.push(entry);
    this._persist(entry);
    if (this.echo) process.stdout.write(`${message}\n`);
    return entry;
  }

  /**
   * 调试级日志：始终写入文件，但只有 verbose 模式才回显到控制台。
   *
   * @param {string} message - 日志正文。
   * @param {Record<string, any>} [extra={}] - 附加结构化字段。
   * @returns {void}
   */
  debug(message, extra = {}) {
    const entry = { timestamp: new Date().toISOString(), level: "debug", message, ...extra };
    this.entries.push(entry);
    this._persist(entry);
    if (this.echo && this.verbose) process.stdout.write(`${message}\n`);
  }

  /**
   * 把条日志写入 JSONL 文件；写入失败则永久降级。
   *
   * @private
   * @param {Record<string, any>} entry - 日志条目。
   * @returns {void}
   */
  _persist(entry) {
    if (!this.fileWritable || !this.filePath) return;
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch (err) {
      this.fileWritable = false;
      console.error(`[logger] 日志写入失败，降级为仅控制台输出：${err.message}`);
    }
  }

  /**
   * @returns {string|null} 日志文件路径；不可写时返回 null。
   */
  getFilePath() {
    return this.filePath;
  }

  /**
   * @returns {Array<Record<string, any>>} 内存日志条目的浅拷贝。
   */
  getEntries() {
    return this.entries.slice();
  }
}

/**
 * 编排器：按流程定义驱动节点执行。
 */
export class Orchestrator {
  /**
   * @param {object} options - 构造参数。
   * @param {Record<string, {agent: object, inputMapper: Function, outputMapper: Function}>} options.nodes - 节点注册表。
   * @param {ReturnType<import("./flows.js").createFlow>} options.flow - 流程定义。
   * @param {import("./state.js").WorkflowState} options.state - 共享状态。
   * @param {import("./messageBus.js").MessageBus} options.messageBus - 消息总线。
   * @param {WorkflowLogger} options.logger - 日志器。
   * @param {number} [options.maxSteps=20] - 执行步数安全上限，防止死循环。
   */
  constructor({ nodes, flow, state, messageBus, logger, maxSteps = 20 }) {
    this.nodes = nodes;
    this.flow = flow;
    this.state = state;
    this.messageBus = messageBus;
    this.logger = logger;
    this.maxSteps = maxSteps;
  }

  /**
   * 按流程顺序取下一个节点。
   *
   * @param {string} current - 当前节点名。
   * @throws {Error} 当前节点不在流程定义中时抛出。
   * @returns {string} 下一个节点名；已是最后一个则返回 "END"。
   */
  nextNodeInFlow(current) {
    const index = this.flow.nodes.indexOf(current);
    if (index === -1) {
      throw new Error(`节点 ${current} 不在流程定义 nodes 中，请检查 flows.js。`);
    }
    return index === this.flow.nodes.length - 1 ? "END" : this.flow.nodes[index + 1];
  }

  /**
   * 执行整个流程。
   *
   * 终止条件：流转到 "END"、节点重试后仍失败（status=failed）、或超过步数安全上限（抛错）。
   *
   * @returns {Promise<import("./state.js").WorkflowState>} 执行结束后的共享状态。
   */
  async run() {
    const { flow, nodes, state, messageBus, logger } = this;

    state.set("status", "running");
    let current = flow.entry;
    let steps = 0;

    while (current && current !== "END") {
      steps += 1;
      if (steps > this.maxSteps) {
        state.set("status", "failed");
        throw new Error(
          `Workflow 执行步数超过安全上限 ${this.maxSteps}，流程可能存在死循环（请检查 flows.js 的 condition）。`,
        );
      }

      const node = nodes[current];
      if (!node) {
        state.set("status", "failed");
        throw new Error(`流程引用了不存在的节点：${current}（可用节点：${Object.keys(nodes).join(", ")}）`);
      }

      logger.log(`▶ 执行节点：${current}`);

      // 关键字段缺失检查（只告警，不中断流程）
      for (const field of REQUIRED_FIELDS[current] ?? []) {
        const value = state.get(field);
        if (value === undefined || value === null || value === "") {
          logger.log(`⚠ 节点 ${current} 依赖的字段「${field}」为空，结果可能不符合预期。`);
        }
      }

      const input = node.inputMapper(state);
      logger.debug(`  input(${current}) = ${JSON.stringify(input)?.slice(0, 300)}`);

      let result;
      try {
        result = await node.agent.run(input, state);
      } catch (err) {
        logger.log(`✖ 节点 ${current} 执行失败，重试 1 次：${err.message}`);
        try {
          result = await node.agent.run(input, state);
        } catch (retryErr) {
          state.set("status", "failed");
          state.set("error", retryErr.message);
          logger.log(`✖ 节点 ${current} 重试后仍失败，流程终止：${retryErr.message}`);
          return state;
        }
      }

      node.outputMapper(result, state);
      messageBus.publish("node:done", { node: current, result }, "orchestrator");
      logger.log(`✔ 节点完成：${current}`);

      const next = flow.condition(current, state);
      current = next === "NEXT" ? this.nextNodeInFlow(current) : next;

      if (current === "END") {
        logger.log("⏹ 流程结束");
      } else {
        logger.log(`↳ 流转到下一个节点：${current}`);
      }
    }

    state.set("status", "done");
    return state;
  }
}
