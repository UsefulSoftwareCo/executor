import { useState } from "react";
import { betaNoticeDismissalKey, earlyPreview } from "@executor-js/ui/contracts/early-preview";
import { EarlyPreviewNotice } from "@executor-js/ui/components/early-preview-notice";
import rhysAvatar from "../assets/rhys-sullivan.jpg";

/** Show the cloud beta notice on organization pages until the browser dismisses it. */
export function BetaNotice() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(betaNoticeDismissalKey) === "true";
    } catch {
      return false;
    }
  });

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(betaNoticeDismissalKey, "true");
    } catch {}
  };

  const openPreview = () => {
    const dialog = document.getElementById("early-preview-notice");
    if (!(dialog instanceof HTMLDialogElement) || dialog.open) return;
    const previousOverflow = document.documentElement.style.overflow;
    dialog.addEventListener(
      "close",
      () => {
        document.documentElement.style.overflow = previousOverflow;
      },
      { once: true },
    );
    dialog.showModal();
    document.documentElement.style.overflow = "hidden";
  };

  return (
    <>
      {!dismissed && (
        <aside
          aria-label="Beta notice"
          className="relative shrink-0 border-y border-[#e9ddb5] bg-[#fff9e8] px-8 text-[#3d3523]"
        >
          <div className="mx-auto flex min-h-8 w-fit max-w-full flex-wrap items-center justify-center gap-x-2 text-center text-xs leading-4">
            <strong className="font-mono font-semibold">Executor v2 Beta</strong>
            <span className="hidden sm:inline">You may see bugs.</span>
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={openPreview}
              className="hidden sm:block min-h-8 cursor-pointer font-semibold underline underline-offset-2 hover:text-[#765b21] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#765b21]"
            >
              Learn more
            </button>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-controls="early-preview-notice"
              onClick={openPreview}
              className="min-h-8 cursor-pointer font-semibold underline underline-offset-2 hover:text-[#765b21] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#765b21]"
            >
              {earlyPreview.migration.title}
            </button>
          </div>
          <button
            type="button"
            aria-label="Dismiss beta notice"
            onClick={dismiss}
            className="absolute inset-y-0 right-1 flex min-w-8 cursor-pointer items-center justify-center text-lg leading-none text-[#75694d] hover:text-[#3d3523] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#765b21]"
          >
            ×
          </button>
        </aside>
      )}
      <EarlyPreviewNotice avatarSrc={rhysAvatar} />
    </>
  );
}
