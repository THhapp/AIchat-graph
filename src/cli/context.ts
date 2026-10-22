/** CLI 运行上下文：注入 stdin/stdout、cwd 与关停信号，便于测试不启动真实进程。 */

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CliContext extends CliIo {
  readonly cwd: string;
  /** 测试用关停信号；存在时不注册进程级 SIGINT/SIGTERM。 */
  readonly shutdownSignal?: AbortSignal | undefined;
  /** 测试用服务模块替身；缺省时从 ../service/index.js 动态加载。 */
  readonly startService?: StartServiceLike | undefined;
  /** 测试用 HTTP 实现；缺省为全局 fetch。CLI 不另设网络层。 */
  readonly fetchImpl?: typeof fetch | undefined;
  /** 正文输入：缺省读取真实 stdin；测试可注入固定文本。 */
  readonly stdin?: (() => Promise<string>) | undefined;
}

export interface ServiceHandleLike {
  readonly url: string;
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly rootPath: string;
  stop(): Promise<void>;
}

export type StartServiceLike = (options: {
  root: string;
  port?: number;
}) => Promise<ServiceHandleLike>;

export function defaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}