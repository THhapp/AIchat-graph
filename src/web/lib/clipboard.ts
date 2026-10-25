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
