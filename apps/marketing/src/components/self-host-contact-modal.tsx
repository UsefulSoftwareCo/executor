import { Button } from "@executor-js/react/components/button";
import { CopyButton } from "@executor-js/react/components/copy-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@executor-js/react/components/dialog";
const TEMPLATE = "Hi Rhys, I'm at {company} and interested in self hosting executor.";
const EMAIL = "rhys@executor.sh";

export function SelfHostContactModal() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="link"
          className="btn-link self-start h-auto p-0 text-current hover:no-underline"
        >
          Get in touch →
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="surface-card gap-0 border-0 p-6 sm:max-w-[520px] sm:p-7"
        style={{
          background: "var(--color-surface)",
          color: "var(--color-ink)",
        }}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <DialogTitle className="text-[20px] font-semibold tracking-[-0.01em]">
            Get in touch
          </DialogTitle>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              style={{ color: "var(--color-ink-3)" }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </Button>
          </DialogClose>
        </div>

        <p className="mb-3 text-[13.5px] leading-[1.55]" style={{ color: "var(--color-ink-2)" }}>
          Copy the template, fill in your company, and send it to me.
        </p>

        <div
          className="mb-4 rounded-md border p-3"
          style={{
            background: "var(--color-surface-2)",
            borderColor: "var(--color-rule)",
          }}
        >
          <p
            className="mb-2 font-mono text-[14px] leading-[1.55]"
            style={{ color: "var(--color-ink)" }}
          >
            {TEMPLATE}
          </p>
          <div className="flex justify-end">
            <CopyButton value={TEMPLATE} label="Copy" />
          </div>
        </div>

        <div
          className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
          style={{
            background: "var(--color-surface-2)",
            borderColor: "var(--color-rule)",
          }}
        >
          <a
            href={`mailto:${EMAIL}`}
            className="truncate font-mono text-[14px] hover:underline"
            style={{ color: "var(--color-ink)" }}
          >
            {EMAIL}
          </a>
          <CopyButton value={EMAIL} label="Copy" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default SelfHostContactModal;
