import { useEffect, useId, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { trackEvent } from "@executor-js/react/api/analytics";
import { Button } from "@executor-js/react/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor-js/react/components/dialog";
import { Label } from "@executor-js/react/components/label";
import { McpServerUrl } from "@executor-js/react/components/mcp-install-card";
import { Textarea } from "@executor-js/react/components/textarea";
import { useAuth, v2ImportAtom } from "../auth";
import {
  browserSnoozeStorage,
  isV2MovedSnoozed,
  snoozeV2Moved,
  V2_MOVED_DISMISS_SNOOZE_MS,
  V2_MOVED_FEEDBACK_SNOOZE_MS,
} from "../v2-moved-snooze";

// ---------------------------------------------------------------------------
// Cloud-only notice for an organization v2 has already imported (the server
// reads the move from the WorkOS organization, `auth/v2-moved.ts`). It opens
// once per dashboard load unless snoozed for this org in this browser:
//   - ✕ / Escape / opening v2   hidden for 7 days, nothing asked
//   - "Keep using v1"           step 2 asks why; sending hides it for 30 days
// v1 keeps working for a moved org; this only tells the user where it went,
// and where its agents should connect (the org's v2 MCP URL, when known).
// ---------------------------------------------------------------------------

type Step = "notice" | "feedback";

const FEEDBACK_MAX_LENGTH = 2000;

const movedDate = (movedAt: string): string =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(movedAt),
  );

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-3.5" aria-hidden>
      <path
        d="M3 8h9M8.5 4.5L12 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function V2MovedNotice() {
  const auth = useAuth();
  const result = useAtomValue(v2ImportAtom);
  const moved = AsyncResult.isSuccess(result) ? result.value.moved : null;
  const organization = auth.status === "authenticated" ? auth.organization : null;
  const organizationId = organization?.id ?? null;

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("notice");
  const [feedback, setFeedback] = useState("");
  const shownFor = useRef<string | null>(null);
  const feedbackId = useId();

  // Decide once per org per page load, after hydration: the snooze lives in
  // localStorage, which the server render cannot see.
  useEffect(() => {
    if (moved === null || organizationId === null) return;
    if (shownFor.current === organizationId) return;
    shownFor.current = organizationId;
    if (isV2MovedSnoozed(browserSnoozeStorage(), organizationId, Date.now())) return;
    setStep("notice");
    setFeedback("");
    setOpen(true);
    trackEvent("v2_moved_modal_shown");
  }, [moved, organizationId]);

  if (moved === null || organization === null) return null;

  const close = (snoozeMs: number) => {
    snoozeV2Moved(browserSnoozeStorage(), organization.id, Date.now(), snoozeMs);
    setOpen(false);
  };

  const trimmed = feedback.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        trackEvent("v2_moved_dismissed", { step });
        close(V2_MOVED_DISMISS_SNOOZE_MS);
      }}
    >
      {/* One shrinkable column: a grid item's default min-width is its content, which let a long
          organization name push the pair and the buttons past the dialog's edge. */}
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-[460px]">
        {step === "notice" ? (
          <>
            <DialogHeader className="gap-3">
              <span className="w-fit rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                Moved {movedDate(moved.movedAt)}
              </span>
              <DialogTitle className="font-display text-xl leading-snug">
                {organization.name} now lives in Executor v2
              </DialogTitle>
            </DialogHeader>

            <div
              data-testid="v2-moved-pair"
              className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs"
            >
              <span className="min-w-0 truncate text-muted-foreground">
                v1 · <span className="text-foreground">{organization.name}</span>
              </span>
              <span aria-hidden className="shrink-0 text-muted-foreground">
                →
              </span>
              <span className="min-w-0 truncate text-muted-foreground">
                v2 · <span className="text-foreground">{moved.v2Slug}</span>
              </span>
            </div>

            <DialogDescription className="text-sm">
              Changes made here won't sync to v2.
            </DialogDescription>

            {moved.v2McpUrl !== undefined && (
              <section aria-label="v2 MCP server URL" className="grid min-w-0 gap-1.5">
                {/* The slug can be 45 characters with no break opportunity. */}
                <p className="min-w-0 text-sm wrap-anywhere text-muted-foreground">
                  Connect your agents to v2 instead, and choose {moved.v2Slug} when you sign in:
                </p>
                <McpServerUrl url={moved.v2McpUrl} />
              </section>
            )}

            <DialogFooter>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  trackEvent("v2_moved_stay_clicked");
                  setStep("feedback");
                }}
              >
                Keep using v1
              </Button>
              <Button size="sm" asChild>
                <a
                  href={moved.v2Url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    trackEvent("v2_moved_open_clicked", { via: "modal" });
                    close(V2_MOVED_DISMISS_SNOOZE_MS);
                  }}
                >
                  Open in v2
                  <ArrowIcon />
                </a>
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (trimmed === "") return;
              trackEvent("v2_moved_feedback_sent", { feedback: trimmed });
              close(V2_MOVED_FEEDBACK_SNOOZE_MS);
            }}
          >
            <DialogHeader>
              <DialogTitle className="font-display text-xl">What went wrong?</DialogTitle>
              <DialogDescription className="text-sm leading-relaxed">
                Tell us why you're staying on v1, so we can fix it.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-2">
              <Label htmlFor={feedbackId} className="sr-only">
                Why are you staying on v1?
              </Label>
              <Textarea
                id={feedbackId}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                maxLength={FEEDBACK_MAX_LENGTH}
                required
                autoFocus
                rows={4}
                className="min-h-24"
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep("notice")}>
                Back
              </Button>
              <Button type="submit" size="sm" disabled={trimmed === ""}>
                Send and stay in v1
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
