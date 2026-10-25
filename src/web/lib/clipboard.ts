import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Clipboard write with the same fallback the rest of the reader already uses:
 * `navigator.clipboard` when present, otherwise a hidden textarea plus
 * `execCommand('copy')`. Callers only need to react to the outcome.
 */
export function copyText(text: string, onDone: () => void, onFail: () => void): void {
  const fallback = (): void => {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    if (ok) onDone();
    else onFail();
  };
  if (navigator.clipboard !== undefined) {
    navigator.clipboard.writeText(text).then(onDone, () => { fallback(); });
  } else {
    fallback();
  }
}

export interface CopyFeedback {
  /** True for two seconds after the most recent successful copy. */
  copied: boolean;
  copy: (text: string) => void;
  /** Clears the hint immediately when the copied context changes. */
  reset: () => void;
}

/**
 * One copied flag per copy affordance. The timer and its cleanup live here so
 * pages do not each repeat `setTimeout`/`clearTimeout` and copied state.
 */
export function useCopyFeedback(): CopyFeedback {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    setCopied(false);
  }, [clearTimer]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  const copy = useCallback((text: string) => {
    clearTimer();
    copyText(
      text,
      () => {
        if (!mounted.current) return;
        clearTimer();
        setCopied(true);
        timer.current = window.setTimeout(() => {
          timer.current = null;
          if (mounted.current) setCopied(false);
        }, 2000);
      },
      () => {
        if (mounted.current) reset();
      },
    );
  }, [clearTimer, reset]);

  return { copied, copy, reset };
}
