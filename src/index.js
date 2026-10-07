/**
 * @file index.js
 * @description 【入口层】CLI 入口。
 *              只负责「收集需求 → 组装 Workflow → 展示结果」，流程本身写在 workflow/ 里。
 */

import { Command } from "commander";
import chalk from "chalk";
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { loadConfig, validateConfig } from "./config.js";
import { WorkflowState } from "./workflow/state.js";
import { MessageBus } from "./workflow/messageBus.js";
import { createNodes } from "./workflow/nodes.js";
import { createFlow } from "./workflow/flows.js";
import { Orchestrator, WorkflowLogger } from "./workflow/orchestrator.js";

/**
 * 统一输出函数（走 stdout，避免与日志级别混在一起）。
 *
 * @param {string} text - 待输出文本。
 * @returns {void}
 */
function out(text) {
  process.stdout.write(`${text}\n`);
}

/**
 * 解析命令行参数。
 *
 * @returns {{requirement?: string, requirementText?: string, out?: string, verbose?: boolean}} 命令行选项。
 */
function parseArgs() {
  const program = new Command();

  program
    .name("code-review-workflow")
    .description("多 Agent 协作的代码审查 Workflow：编码 Agent → 审查 Agent → 修复 Agent（可循环）。")
    .version("1.0.0")
    .option("-r, --requirement <path>", "需求文件路径（读取文件内容作为需求）")
    .option("-t, --requirement-text <text>", "直接传入需求文本")
    .option("-o, --out <path>", "最终代码的输出路径（可选）")
    .option("-v, --verbose", "输出调试日志（节点输入等细节）")
    .showHelpAfterError("（可用 --help 查看全部用法）");

  program.parse(process.argv);
  return program.opts();
}

/**
 * 解析需求内容：优先读文件，其次用命令行文本。
 *
 * @param {{requirement?: string, requirementText?: string}} options - 命令行选项。
 * @throws {Error} 未提供需求或需求为空时抛出。
 * @returns {Promise<string>} 需求文本。
 */
async function resolveRequirement({ requirement, requirementText }) {
  if (requirement) {
    try {
      const content = await fsReadFile(path.resolve(requirement), "utf-8");
      if (content.trim() === "") {
        throw new Error(`需求文件内容为空：${requirement}`);
      }
      return content;
    } catch (err) {
      throw new Error(`读取需求文件失败：${err.message}`);
    }
  }

  if (requirementText !== undefined) {
    if (String(requirementText).trim() === "") {
      throw new Error("需求文本为空。");
    }
    return String(requirementText);
  }

  throw new Error(
    "未提供需求。请使用 --requirement <文件路径> 或 --requirement-text \"<需求描述>\"，例如：\n" +
      "  npm run demo\n" +
      '  npm start -- --requirement-text "实现一个加法函数 add(a, b)"',
  );
}

/**
 * 程序主流程。
 *
 * @returns {Promise<void>} 流程结束后的 Promise。
 */
async function main() {
  const options = parseArgs();

  // 非 verbose 模式下关闭 console.debug，避免调试日志混入结果输出
  if (!options.verbose) {
    console.debug = () => {};
  }

  let config;
  try {
    config = loadConfig();
    validateConfig(config);
  } catch (err) {
    out(chalk.red(`✖ 配置错误：${err.message}`));
    process.exit(1);
  }

  let requirement;
  try {
    requirement = await resolveRequirement(options);
  } catch (err) {
    out(chalk.red(`✖ ${err.message}`));
    process.exit(1);
  }

  // ---- 组装 Workflow ----
  const state = new WorkflowState();
  state.set("requirement", requirement);
  state.set("iteration", 0);

  const messageBus = new MessageBus();
  const logger = new WorkflowLogger({ dir: "logs", verbose: Boolean(options.verbose) });

  // 演示消息总线的订阅能力：把每次节点完成都记进 debug 日志
  messageBus.subscribe("node:done", (message) => {
    logger.debug(`  [bus] node:done ← ${message.payload.node}`);
  });

  const nodes = createNodes({ config, messageBus });
  const flow = createFlow(config);

  out(chalk.bold("\n🔗 Code Review Workflow"));
  out(chalk.gray(`模型：${config.model} ｜ 接口：${config.baseURL}`));
  out(chalk.gray(flow.describe()));
  out(chalk.gray(`节点实现：${Object.keys(nodes).join(", ")}\n`));

  // ---- 执行流程 ----
  const orchestrator = new Orchestrator({ nodes, flow, state, messageBus, logger });
  const result = await orchestrator.run();

  // ---- 输出结果 ----
  const status = result.get("status");
  const finalCode = result.get("code") ?? "";
  const reviewReport = result.get("reviewReport") ?? null;
  const iteration = result.get("iteration") ?? 0;

  out(chalk.bold("\n════════════════ 最终代码 ════════════════\n"));
  if (finalCode.trim() === "") {
    out(chalk.red("（最终代码为空，流程可能异常，请检查日志。）"));
  } else {
    out(chalk.cyan(finalCode));
  }

  out(chalk.bold("\n════════════════ 审查报告 ════════════════\n"));
  out(chalk.cyan(JSON.stringify(reviewReport, null, 2)));

  out(chalk.bold("\n════════════════ 执行摘要 ════════════════"));
  out(
    `状态：${status === "done" ? chalk.green(status) : chalk.red(status)}` +
      ` ｜ 迭代轮次：${iteration}/${config.maxIterations}` +
      ` ｜ 消息数：${messageBus.getHistory().length}` +
      ` ｜ 状态快照：${result.getSnapshots().length}`,
  );
  out(`日志文件：${logger.getFilePath() ?? chalk.yellow("（写入失败，仅控制台输出）")}`);

  if (result.get("error")) {
    out(chalk.red(`错误信息：${result.get("error")}`));
  }

  // ---- 按需写文件 ----
  if (options.out && finalCode.trim() !== "") {
    const outPath = path.resolve(options.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await fsWriteFile(outPath, `${finalCode}\n`, "utf-8");
    out(chalk.green(`\n✔ 最终代码已写入：${outPath}`));
  }

  if (status !== "done") {
    out(chalk.red("\n✖ Workflow 未正常完成。"));
    process.exit(1);
  }
}

main().catch((err) => {
  out(chalk.red(`✖ Workflow 执行失败：${err?.message ?? err}`));
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
