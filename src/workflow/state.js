/**
 * @file state.js
 * @description 【Workflow 层】共享状态。
 *              所有 Agent 都通过它读写数据，而不是互相持有引用；
 *              每次写入都会留下一个快照，便于事后回放「哪个节点改了什么」。
 */

/**
 * 深拷贝工具：优先用 structuredClone，遇到不可克隆的值时降级为 JSON 往返。
 *
 * @param {any} value - 待拷贝的值。
 * @returns {any} 深拷贝结果。
 */
function deepClone(value) {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
}

/**
 * Workflow 共享状态容器。
 */
export class WorkflowState {
  /**
   * @param {Record<string, any>} [initial={}] - 初始数据。
   */
  constructor(initial = {}) {
    /** @type {Record<string, any>} 当前状态数据。 */
    this.data = { ...initial };
    /** @type {Array<{label: string, timestamp: number, data: Record<string, any>}>} 历史快照。 */
    this.snapshots = [];
  }

  /**
   * 写入一个字段，并自动打一个快照。
   *
   * @param {string} key - 字段名。
   * @param {any} value - 字段值。
   * @returns {WorkflowState} 返回自身，便于链式调用。
   */
  set(key, value) {
    this.data[key] = value;
    this.snapshot(`set:${key}`);
    return this;
  }

  /**
   * 读取一个字段。
   *
   * @param {string} key - 字段名。
   * @returns {any} 字段值；不存在时返回 undefined。
   */
  get(key) {
    return this.data[key];
  }

  /**
   * 判断字段是否存在（注意：值为 undefined 的字段仍算存在）。
   *
   * @param {string} key - 字段名。
   * @returns {boolean} 是否存在。
   */
  has(key) {
    return Object.prototype.hasOwnProperty.call(this.data, key);
  }

  /**
   * 记录当前 data 的深拷贝快照。
   *
   * @param {string} label - 快照标签，例如 `set:code`。
   * @returns {{label: string, timestamp: number, data: Record<string, any>}} 刚生成的快照。
   */
  snapshot(label) {
    const entry = {
      label: String(label ?? "snapshot"),
      timestamp: Date.now(),
      data: deepClone(this.data),
    };
    this.snapshots.push(entry);
    return entry;
  }

  /**
   * 获取全部快照的浅拷贝。
   *
   * @returns {Array<{label: string, timestamp: number, data: Record<string, any>}>} 快照列表。
   */
  getSnapshots() {
    return this.snapshots.slice();
  }

  /**
   * 导出可序列化的状态数据，供日志与最终输出使用。
   *
   * @returns {Record<string, any>} data 的浅拷贝。
   */
  toJSON() {
    return { ...this.data };
  }
}
