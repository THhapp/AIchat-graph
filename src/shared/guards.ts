/** browser/node 中立的结构判定；不依赖运行时或框架。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
