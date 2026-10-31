import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Exit, type Cause } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { FailureProps } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import { Spinner } from "../components/spinner.tsx";
import { CopyButton } from "./code.tsx";

/** What the app asks the person to do; the host keeps the sign-in's session. */
export interface InteractivePrompt {
  readonly url?: string | undefined;
  readonly code?: string | undefined;
  readonly paste?:
    | { readonly label: string; readonly placeholder?: string | undefined }
    | undefined;
  /** Milliseconds since the epoch. */
  readonly expiresAt?: number | undefined;
  readonly message?: string | undefined;
}

export type InteractiveState<A> =
  | { readonly state: "waiting" }
  | { readonly state: "connected"; readonly account: A }
  | { readonly state: "failed"; readonly message: string };

/** How often the dialog asks whether the service finished. */
const pollEvery = 3_000;

type Step<A, E> =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "waiting"; readonly prompt: InteractivePrompt }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "error"; readonly cause: Cause.Cause<E>; readonly prompt?: InteractivePrompt }
  | { readonly kind: "connected"; readonly account: A };

/**
 * Sign-in steps for an account the app acquires: a page to open, a code to enter, a value to paste
 * back, then waiting while the service finishes. The host saves and names the account.
 */
export function InteractiveSignIn<A, E>({
  label,
  start,
  status,
  submit,
  cancel,
  onSaved,
  onPendingChange,
  Failure,
  disabled,
}: {
  /** The method's label, such as the service's name. */
  readonly label: string;
  readonly start: () => Promise<Exit.Exit<InteractivePrompt, E>>;
  readonly status: () => Promise<Exit.Exit<InteractiveState<A>, E>>;
  readonly submit: (value: string) => Promise<Exit.Exit<InteractiveState<A>, E>>;
  /**
   * Called when the person leaves or restarts before the sign-in finishes. The product runs every
   * step of one connection in order, so a start after a cancel never meets the cancelled attempt.
   */
  readonly cancel: () => void;
  readonly onSaved: (account: A) => void;
  readonly onPendingChange: (pending: boolean) => void;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly disabled: boolean;
}) {
  const [step, setStep] = useState<Step<A, E>>({ kind: "idle" });
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // The latest handlers, so a poll that resolves after a re-render reads current props.
  const latest = useRef({ status, cancel, onSaved, onPendingChange });
  latest.current = { status, cancel, onSaved, onPendingChange };
  // A submit and a poll can both report the account; it is saved once.
  const saved = useRef(false);
  // Polls pause while a pasted value is being checked, so the two never race.
  const checking = useRef(false);

  const settle = (exit: Exit.Exit<InteractiveState<A>, E>, prompt: InteractivePrompt) => {
    if (Exit.isFailure(exit)) return setStep({ kind: "error", cause: exit.cause, prompt });
    const result = exit.value;
    if (result.state === "connected") {
      if (saved.current) return;
      saved.current = true;
      setStep({ kind: "connected", account: result.account });
      latest.current.onSaved(result.account);
    } else if (result.state === "failed") setStep({ kind: "failed", message: result.message });
  };

  // Poll while waiting. Each poll starts after the previous one answers, so none overlap.
  const prompt = step.kind === "waiting" ? step.prompt : undefined;
  useEffect(() => {
    if (prompt === undefined) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = () => {
      timer = window.setTimeout(() => {
        if (checking.current) return poll();
        void latest.current.status().then((exit) => {
          if (stopped) return;
          if (Exit.isSuccess(exit) && exit.value.state === "waiting") poll();
          else settle(exit, prompt);
        });
      }, pollEvery);
    };
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- one poll chain per started sign-in
  }, [prompt]);

  // Leaving an unfinished sign-in cancels it, so the service isn't left waiting. Saving an account
  // closes the dialog mid-submit, so leaving also says nothing is pending any more.
  // Any attempt the app was asked for counts, including a refused or expired one, so switching
  // methods never leaves the connection holding it. Cancelling is safe to repeat.
  const unfinished = useRef(false);
  unfinished.current = step.kind !== "idle" && step.kind !== "connected";
  useEffect(
    () => () => {
      if (unfinished.current) latest.current.cancel();
      latest.current.onPendingChange(false);
    },
    [],
  );

  useEffect(
    () => onPendingChange(step.kind === "starting" || submitting),
    [step.kind, submitting, onPendingChange],
  );

  const begin = () => {
    // Starting again retires the attempt that failed or expired before asking for a new one.
    if (step.kind !== "idle") latest.current.cancel();
    setValue("");
    setStep({ kind: "starting" });
    void start().then((exit) =>
      setStep(
        Exit.isSuccess(exit)
          ? { kind: "waiting", prompt: exit.value }
          : { kind: "error", cause: exit.cause },
      ),
    );
  };

  if (step.kind === "idle" || step.kind === "starting" || (step.kind === "error" && !step.prompt))
    return (
      <>
        <p className="text-xs leading-relaxed text-muted-foreground">
          You sign in on {label}'s own page. The app keeps the sign-in; this account saves only a
          reference to it.
        </p>
        {step.kind === "error" && <Failure cause={step.cause} layout="compact" />}
        <Button
          type="button"
          className="w-full"
          loading={step.kind === "starting"}
          disabled={disabled}
          onClick={begin}
        >
          {step.kind === "error" ? "Try again" : `Sign in with ${label}`}
        </Button>
      </>
    );

  if (step.kind === "connected")
    return (
      <p className="text-sm" role="status">
        Account connected.
      </p>
    );

  if (step.kind === "failed")
    return (
      <>
        <p className="text-sm text-destructive text-pretty" role="alert">
          {step.message}
        </p>
        <Button type="button" className="w-full" disabled={disabled} onClick={begin}>
          Start again
        </Button>
      </>
    );

  const current = step.prompt ?? {};
  // In the order they show: copy the code before opening the page that asks for it.
  const steps = [
    current.code !== undefined && "code",
    current.url !== undefined && "open",
    current.paste !== undefined && "paste",
  ].filter((name) => name !== false);
  const numbered = steps.length > 1;
  return (
    <div className="flex flex-col gap-4">
      {current.message !== undefined && <p className="text-sm text-pretty">{current.message}</p>}
      <ol className={numbered ? "m-0 flex list-none flex-col gap-4 p-0" : "contents"}>
        {current.code !== undefined && (
          <Numbered index={steps.indexOf("code")} numbered={numbered}>
            <p className="text-sm">Copy this code. You'll enter it on {label}'s page.</p>
            <div className="relative flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-4 py-3">
              <span className="font-mono text-xl font-medium tracking-[0.12em] tabular-nums select-all">
                {current.code}
              </span>
              <CopyButton
                code={current.code}
                label="Copy code"
                text="Copy"
                inline
                variant="outline"
                size="sm"
              />
            </div>
          </Numbered>
        )}
        {current.url !== undefined && (
          <Numbered index={steps.indexOf("open")} numbered={numbered}>
            <p className="text-sm">Sign in on {label}'s page. It opens in a new tab.</p>
            <Button
              asChild
              variant={current.paste === undefined ? "default" : "outline"}
              className="w-fit"
            >
              {/* Opened from the person's own click, so a popup blocker doesn't stop it. */}
              <a href={current.url} target="_blank" rel="noopener noreferrer">
                Open {label}
                <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} aria-hidden />
              </a>
            </Button>
          </Numbered>
        )}
        {current.paste !== undefined && (
          <Numbered index={steps.indexOf("paste")} numbered={numbered}>
            <label className="text-sm text-pretty" htmlFor="interactive-paste">
              {current.paste.label}
            </label>
            <div className="flex gap-2 max-[480px]:flex-col">
              <Input
                id="interactive-paste"
                value={value}
                autoComplete="off"
                spellCheck={false}
                placeholder={current.paste.placeholder}
                disabled={submitting || disabled}
                className="font-mono text-[13px]"
                onChange={(event) => setValue(event.target.value)}
              />
              <Button
                type="button"
                loading={submitting}
                disabled={value.trim() === "" || disabled}
                onClick={() => {
                  setSubmitting(true);
                  checking.current = true;
                  void submit(value.trim()).then((exit) => {
                    checking.current = false;
                    setSubmitting(false);
                    if (Exit.isSuccess(exit) && exit.value.state === "waiting") return;
                    settle(exit, current);
                  });
                }}
              >
                Connect
              </Button>
            </div>
          </Numbered>
        )}
      </ol>
      {step.kind === "error" ? (
        <Failure
          cause={step.cause}
          layout="compact"
          retry={() => setStep({ kind: "waiting", prompt: current })}
        />
      ) : (
        current.paste === undefined && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <Spinner aria-hidden /> Waiting for {label}. This updates by itself.
          </p>
        )
      )}
      {current.expiresAt !== undefined && <Expiry at={current.expiresAt} />}
    </div>
  );
}

function Numbered({
  index,
  numbered,
  children,
}: {
  readonly index: number;
  readonly numbered: boolean;
  readonly children: ReactNode;
}) {
  if (!numbered) return <div className="flex flex-col gap-2">{children}</div>;
  return (
    <li className="grid grid-cols-[1.5rem_1fr] gap-x-2 gap-y-2">
      <span className="row-span-3 grid size-6 place-items-center rounded-full border border-border text-xs font-medium tabular-nums text-muted-foreground">
        {index + 1}
      </span>
      {children}
    </li>
  );
}

/** When the service stops waiting, rounded to minutes. */
function Expiry({ at }: { readonly at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const minutes = Math.ceil((at - now) / 60_000);
  return (
    <p className="text-xs text-muted-foreground">
      {minutes <= 0
        ? "This sign-in expired. Start again."
        : `This sign-in expires in ${minutes === 1 ? "a minute" : `${minutes} minutes`}.`}
    </p>
  );
}
