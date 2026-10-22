/**
 * 工作区内的唯一串行队列。
 *
 * watcher 重读、check、apply 与快照发布都经同一队列；任务抛出错误不会阻断后续任务。
 * close 后拒绝新任务，但已排队任务会继续执行，stop 可等待队列清空。
 */
import { ServiceError } from "./errors.js";

export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private pending = 0;
  private idleWaiters: Array<() => void> = [];

  get isClosed(): boolean {
    return this.closed;
  }

  get pendingCount(): number {
    return this.pending;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new ServiceError(503, "SHUTTING_DOWN", "服务正在停止", {}));
    }
    this.pending += 1;
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    void result.then(
      () => this.finish(),
      () => this.finish(),
    );
    return result;
  }

  private finish(): void {
    this.pending -= 1;
    if (this.pending > 0) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  /** 停止接受新任务；已排队任务继续。 */
  close(): void {
    this.closed = true;
  }

  whenIdle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }
}
