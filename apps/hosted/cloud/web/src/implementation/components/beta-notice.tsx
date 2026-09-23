import { useState } from "react";
import { betaNoticeDismissalKey, earlyPreview } from "@executor-js/ui/contracts/early-preview";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@executor-js/ui/components/dialog";
import rhysAvatar from "../assets/rhys-sullivan.jpg";

/** Show the cloud beta notice on organization pages until the browser dismisses it. */
export function BetaNotice() {
  const [open, setOpen] = useState(false);
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

  return (
    <>
      {!dismissed && (
        <aside
          aria-label="Beta notice"
          className="relative shrink-0 border-y border-[#e9ddb5] bg-[#fff9e8] px-8 text-[#3d3523]"
        >
          <div className="mx-auto flex min-h-8 w-fit max-w-full flex-wrap items-center justify-center gap-x-2 text-center text-xs leading-4">
            <strong className="font-mono font-semibold">Executor v2 Beta</strong>
            <span>You may see bugs.</span>
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() => setOpen(true)}
              className="min-h-8 cursor-pointer font-semibold underline underline-offset-2 hover:text-[#765b21] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#765b21]"
            >
              Learn more
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
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby="beta-notice-description"
          showCloseButton={false}
          overlayClassName="bg-black/25 backdrop-blur-sm"
          className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto rounded-2xl p-6 sm:max-w-[520px] sm:p-8"
        >
          <p className="mb-3 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Early preview
          </p>
          <DialogTitle className="text-[26px] leading-tight tracking-[-0.035em]">
            {earlyPreview.title}
          </DialogTitle>
          <div
            id="beta-notice-description"
            className="mt-5 space-y-4 text-[15px] leading-[1.65] text-muted-foreground"
          >
            {earlyPreview.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
          <div className="mt-7 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <img
                src={rhysAvatar}
                alt=""
                width="40"
                height="40"
                className="size-10 rounded-full object-cover ring-1 ring-border"
              />
              <div className="text-sm leading-snug">
                <p className="font-medium">Rhys Sullivan</p>
                <p className="mt-0.5 text-muted-foreground">Founder, Executor</p>
              </div>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                className="min-h-11 w-full cursor-pointer rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground sm:w-auto"
              >
                Got it
              </button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
