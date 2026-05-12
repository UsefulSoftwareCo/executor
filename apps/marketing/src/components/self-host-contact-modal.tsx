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

type Variant = "card" | "inline";

interface Props {
  /**
   * "card" (default) — block-level "Get in touch →" link styled like a card CTA.
   * "inline" — accent-colored inline link sized to flow inside a paragraph.
   */
  readonly variant?: Variant;
}

export function SelfHostContactModal({ variant = "card" }: Props) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {variant === "inline" ? (
          <Button variant="link" className="link-accent inline-flex h-auto items-baseline p-0">
            Looking for self-hosted? →
          </Button>
        ) : (
          <Button
            variant="link"
            className="btn-link self-start h-auto p-0 text-current hover:no-underline"
          >
            Get in touch →
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="surface-card gap-0 border-0 p-6 sm:max-w-[560px] sm:p-7"
        style={{
          background: "var(--color-surface)",
          color: "var(--color-ink)",
        }}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <DialogTitle className="text-[20px] font-semibold tracking-[-0.01em]">
            Self-hosted Executor
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

        <p className="mb-4 text-[14px] leading-[1.6]" style={{ color: "var(--color-ink-2)" }}>
          We're looking for early adopters to give feedback and use the self hosted product. If
          you're a company interested in self hosting get in touch.
        </p>

        <p className="mb-2 text-[13px] font-medium" style={{ color: "var(--color-ink-3)" }}>
          Copy this and send it over:
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
