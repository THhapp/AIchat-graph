import { createLayoutWorkerState, handleLayoutMessage } from './workerHandler.js';
import type { LayoutWorkerResponse } from './workerProtocol.js';

/** 只负责 Worker 环境接线；协议与序号保护在 workerHandler 中。 */
interface WorkerScope {
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ) => void;
  postMessage: (message: LayoutWorkerResponse) => void;
}

const scope = globalThis as unknown as WorkerScope;
const state = createLayoutWorkerState();

scope.addEventListener('message', (event: MessageEvent<unknown>) => {
  const response = handleLayoutMessage(event.data, state);
  if (response !== null) scope.postMessage(response);
});
