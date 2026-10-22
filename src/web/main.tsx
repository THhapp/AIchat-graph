import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { LayoutEngineContext, createWorkerLayoutEngine, type LayoutEngineSlot } from './graph/layoutBridge.js';
import './styles/tokens.css';
import './styles/base.css';
import './styles/graph.css';
import './styles/detail.css';
import 'katex/dist/katex.min.css';

function LayoutProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [slot, setSlot] = useState<LayoutEngineSlot>({ status: 'loading', engine: null });

  useEffect(() => {
    // Vite bundles this as a separate module worker. The path is relative to
    // this file (src/web/main.tsx), so the layout worker resolves to
    // src/web/layout/worker.ts.
    let worker: Worker;
    try {
      worker = new Worker(new URL('./layout/worker.ts', import.meta.url), { type: 'module', name: 'aichat-layout' });
    } catch {
      setSlot({ status: 'missing', engine: null });
      return;
    }
    const engine = createWorkerLayoutEngine(worker);
    worker.addEventListener('error', () => { setSlot({ status: 'missing', engine: null }); }, { once: true });
    setSlot({ status: 'ready', engine });
    return () => {
      engine.dispose();
    };
  }, []);

  return <LayoutEngineContext.Provider value={slot}>{children}</LayoutEngineContext.Provider>;
}

const container = document.getElementById('root');
if (container === null) throw new Error('缺少 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <a className="skip-link" href="#main-content">跳到思想图</a>
    <LayoutProvider>
      <App />
    </LayoutProvider>
  </StrictMode>,
);