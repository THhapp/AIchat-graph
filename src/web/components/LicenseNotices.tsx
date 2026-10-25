import { useId, useRef } from 'react';
import projectLicense from '../../../LICENSE?raw';
import thirdPartyNotices from '../../../THIRD_PARTY_NOTICES.txt?raw';
import '../styles/licenses.css';

/** Bundled in both readers so a moved, offline HTML retains the full notices. */
export function LicenseNotices(): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const dialogId = useId();

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-controls={dialogId}
        onClick={() => { dialogRef.current?.showModal(); }}
      >
        开源许可
      </button>
      <dialog ref={dialogRef} id={dialogId} className="license-notices" aria-labelledby={titleId}>
        <header className="license-notices__head">
          <h2 id={titleId}>开源许可</h2>
          <form method="dialog">
            <button type="submit" aria-label="关闭开源许可">关闭</button>
          </form>
        </header>
        <div className="license-notices__body" tabIndex={0}>
          <p>以下许可适用于程序；用户讨论、引文和图片的权利仍归各自权利人。</p>
          <h3>程序 MIT 许可</h3>
          <pre>{projectLicense}</pre>
          <h3>第三方声明</h3>
          <pre>{thirdPartyNotices}</pre>
        </div>
      </dialog>
    </>
  );
}
