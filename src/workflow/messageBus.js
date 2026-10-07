/**
 * @file messageBus.js
 * @description 【Workflow 层】消息总线。
 *              Agent 不直接互相调用，而是「发布事件 / 订阅事件」，由总线负责转发与留痕。
 *              所有消息都会进入 messages 数组，既是通信通道，也是审计日志的数据源。
 */

/**
 * 消息总线：支持按 topic 发布 / 订阅。
 */
export class MessageBus {
  constructor() {
    /** @type {Array<{topic: string, payload: any, from: string, timestamp: number}>} 全部消息。 */
    this.messages = [];
    /** @type {Map<string, Function[]>} topic → 订阅者回调列表。 */
    this.subscribers = new Map();
  }

  /**
   * 发布一条消息，并同步通知该 topic 的所有订阅者。
   *
   * @param {string} topic - 主题名，例如 "node:done"。
   * @param {any} payload - 消息负载。
   * @param {string} [from="unknown"] - 发送方标识（通常是 Agent 名或 "orchestrator"）。
   * @returns {{topic: string, payload: any, from: string, timestamp: number}} 已发布的消息。
   */
  publish(topic, payload, from = "unknown") {
    const message = { topic, payload, from, timestamp: Date.now() };
    this.messages.push(message);

    const handlers = this.subscribers.get(topic) ?? [];
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (err) {
        // 订阅者自身出错不应影响发布方，记录后继续通知其余订阅者
        console.error(`[messageBus] 订阅者处理 ${topic} 时出错：${err.message}`);
      }
    }
    return message;
  }

  /**
   * 订阅某个 topic。
   *
   * @param {string} topic - 主题名。
   * @param {(message: {topic: string, payload: any, from: string, timestamp: number}) => void} handler - 处理函数。
   * @returns {() => void} 取消订阅的函数。
   */
  subscribe(topic, handler) {
    const handlers = this.subscribers.get(topic) ?? [];
    handlers.push(handler);
    this.subscribers.set(topic, handlers);

    return () => {
      const current = this.subscribers.get(topic) ?? [];
      this.subscribers.set(
        topic,
        current.filter((h) => h !== handler),
      );
    };
  }

  /**
   * 获取全部消息的浅拷贝。
   *
   * @returns {Array<{topic: string, payload: any, from: string, timestamp: number}>} 消息列表。
   */
  getHistory() {
    return this.messages.slice();
  }

  /**
   * 按 topic 过滤消息。
   *
   * @param {string} topic - 主题名。
   * @returns {Array<{topic: string, payload: any, from: string, timestamp: number}>} 匹配的消息列表。
   */
  getByTopic(topic) {
    return this.messages.filter((m) => m.topic === topic);
  }

  /**
   * 清空消息记录（不会移除订阅者）。
   *
   * @returns {void}
   */
  clear() {
    this.messages = [];
  }
}
