import { NODE_ID_PATTERN, TOPIC_ID_PATTERN } from "./schema.js";

/** ID 只承载身份，不承载顺序或层级；创建后改名、改编号都不变。 */
export function isNodeId(value: string): boolean {
  return NODE_ID_PATTERN.test(value);
}

export function isTopicId(value: string): boolean {
  return TOPIC_ID_PATTERN.test(value);
}

export function createNodeId(): string {
  return `n_${randomHex32()}`;
}

export function createTopicId(): string {
  return `t_${randomHex32()}`;
}

function randomHex32(): string {
  const webCrypto = globalThis.crypto;
  if (!webCrypto || typeof webCrypto.randomUUID !== "function") {
    throw new Error("当前运行环境缺少 crypto.randomUUID，无法生成稳定 ID");
  }
  return webCrypto.randomUUID().replaceAll("-", "");
}
