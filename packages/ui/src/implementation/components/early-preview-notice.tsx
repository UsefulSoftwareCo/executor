import { earlyPreview } from "../../contracts/early-preview.ts";

interface EarlyPreviewNoticeProps {
  readonly avatarSrc: string;
}

/** The early preview dialog shown by both the marketing site and cloud dashboard. */
export function EarlyPreviewNotice({ avatarSrc }: EarlyPreviewNoticeProps) {
  return (
    <dialog
      id="early-preview-notice"
      aria-labelledby="early-preview-title"
      aria-describedby="early-preview-description"
      className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-[520px] overflow-y-auto overscroll-contain rounded-2xl border border-[#eaeaea] bg-white p-6 text-[#111] shadow-[0_24px_100px_#00000026] backdrop:bg-black/25 backdrop:backdrop-blur-sm sm:p-8 dark:border-[#444] dark:bg-[#1b1b1b] dark:text-[#ededed]"
    >
      <p className="mb-3 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-[#888] dark:text-[#aaa]">
        Early preview
      </p>
      <h2
        id="early-preview-title"
        className="text-[26px] font-semibold leading-tight tracking-[-0.035em]"
      >
        {earlyPreview.title}
      </h2>
      <div
        id="early-preview-description"
        className="mt-5 space-y-4 text-[15px] leading-[1.65] text-[#666] dark:text-[#aaa]"
      >
        {earlyPreview.paragraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      <form
        method="dialog"
        className="mt-7 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-center gap-3">
          <img
            src={avatarSrc}
            alt=""
            width="40"
            height="40"
            className="size-10 rounded-full object-cover ring-1 ring-[#eaeaea] dark:ring-[#444]"
          />
          <div className="text-sm leading-snug">
            <p className="font-medium">Rhys Sullivan</p>
            <p className="mt-0.5 text-[#888] dark:text-[#aaa]">Founder, Executor</p>
          </div>
        </div>
        <button
          type="submit"
          autoFocus
          className="min-h-11 w-full cursor-pointer rounded-lg bg-[#111] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#333] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#111] sm:w-auto dark:bg-[#ededed] dark:text-[#111] dark:hover:bg-white dark:focus-visible:outline-[#ededed]"
        >
          Got it
        </button>
      </form>
    </dialog>
  );
}
