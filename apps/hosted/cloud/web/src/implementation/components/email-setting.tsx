import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Exit } from "effect";
import { useState } from "react";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@executor-js/ui/components/dialog";
import { accountSettingClass, readOnlyInputClass } from "@executor-js/hosted-web/account";
import {
  AuthFailed,
  invalidEmailMessage,
  plausibleEmail,
} from "@executor-js/hosted-web/contracts/auth";
import {
  changeEmailAtom,
  requestEmailChangeAtom,
  sendEmailChangeApprovalAtom,
} from "../../contracts/auth.ts";

const actionClass =
  "flex items-center gap-2.5 text-[12px] [&_>_button]:h-7.5 [&_>_button]:py-0 [&_>_button]:px-[12px] [&_>_button]:text-[12px] [&_>_button]:bg-transparent [&_>_button]:shadow-none max-[640px]:[&_>_button]:min-h-10";

const errorMessage = (cause: Cause.Cause<AuthFailed>) => {
  const error = Cause.squash(cause);
  return error instanceof AuthFailed ? error.message : "Unable to change your email. Try again.";
};

/**
 * Both addresses take part: the current one approves the change with a code, then the new one
 * proves it can receive mail. The account keeps its address until the second code is accepted.
 */
type Step =
  | { readonly kind: "address" }
  | { readonly kind: "approve"; readonly newEmail: string }
  | { readonly kind: "confirm"; readonly newEmail: string };

/** Cloud's email setting; email codes sign people in, so changing it needs both inboxes. */
export function EmailSetting({ current }: { readonly current: string }) {
  const [open, setOpen] = useState(false);
  const [changed, setChanged] = useState(false);
  return (
    <Card className={accountSettingClass}>
      <CardHeader>
        <CardTitle>
          <h2>Email</h2>
        </CardTitle>
        <CardDescription>Used for sign-in and invitations.</CardDescription>
      </CardHeader>
      <CardContent>
        <Input aria-label="Email" className={readOnlyInputClass} value={current} readOnly />
      </CardContent>
      <CardFooter>
        <p>Changing it needs a code from your current and new email.</p>
        <div className={actionClass}>
          {changed && <span role="status">Email changed</span>}
          <Button
            variant="outline"
            onClick={() => {
              setChanged(false);
              setOpen(true);
            }}
          >
            Change email
          </Button>
        </div>
      </CardFooter>
      {open && (
        <ChangeEmailDialog
          current={current}
          onClose={() => setOpen(false)}
          onChanged={() => {
            setOpen(false);
            setChanged(true);
          }}
        />
      )}
    </Card>
  );
}

function ChangeEmailDialog({
  current,
  onClose,
  onChanged,
}: {
  readonly current: string;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const sendApproval = useAtomSet(sendEmailChangeApprovalAtom, { mode: "promiseExit" });
  const request = useAtomSet(requestEmailChangeAtom, { mode: "promiseExit" });
  const change = useAtomSet(changeEmailAtom, { mode: "promiseExit" });
  const sending = useAtomValue(sendEmailChangeApprovalAtom).waiting;
  const requesting = useAtomValue(requestEmailChangeAtom).waiting;
  const changing = useAtomValue(changeEmailAtom).waiting;
  const [step, setStep] = useState<Step>({ kind: "address" });
  const [newEmail, setNewEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [resent, setResent] = useState(false);
  const pending = sending || requesting || changing;

  const sendApprovalCode = async () => {
    setError(undefined);
    setResent(false);
    const result = await sendApproval(current);
    if (Exit.isFailure(result)) {
      setError(errorMessage(result.cause));
      return false;
    }
    return true;
  };

  const submit = async () => {
    setError(undefined);
    setResent(false);
    if (step.kind === "address") {
      const target = newEmail.trim();
      if (!plausibleEmail(target)) return setError(invalidEmailMessage);
      if (target.toLowerCase() === current.toLowerCase())
        return setError("Enter an address other than your current email.");
      if (await sendApprovalCode()) setStep({ kind: "approve", newEmail: target });
    } else if (step.kind === "approve") {
      const result = await request({ newEmail: step.newEmail, otp: code.trim() });
      if (Exit.isFailure(result)) return setError(errorMessage(result.cause));
      setCode("");
      setStep({ kind: "confirm", newEmail: step.newEmail });
    } else {
      const result = await change({ newEmail: step.newEmail, otp: code.trim() });
      if (Exit.isFailure(result)) return setError(errorMessage(result.cause));
      onChanged();
    }
  };

  const description =
    step.kind === "address"
      ? "We'll send a code to your current email to approve the change."
      : step.kind === "approve"
        ? `Enter the code we sent to ${current}. It expires in 5 minutes.`
        : `Enter the code we sent to ${step.newEmail}. If it doesn't arrive, another account may already use that address.`;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <div className="space-y-2 pr-6">
          <DialogTitle>Change email</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </div>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            await submit();
          }}
        >
          {step.kind === "address" ? (
            <label className="block text-sm font-medium">
              New email
              <Input
                key="address"
                className="mt-2"
                type="email"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                autoFocus
                required
                disabled={pending}
              />
            </label>
          ) : (
            <label className="block text-sm font-medium">
              {step.kind === "approve" ? "Approval code" : "Confirmation code"}
              <Input
                key={step.kind}
                className="mt-2 font-mono tracking-[0.3em]"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/gu, ""))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                autoFocus
                required
                disabled={pending}
              />
            </label>
          )}
          {step.kind === "approve" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <button
                type="button"
                className="underline underline-offset-4 hover:text-foreground disabled:opacity-50"
                disabled={pending}
                onClick={async () => {
                  if (await sendApprovalCode()) setResent(true);
                }}
              >
                Resend code
              </button>
              {resent && <span role="status">Code sent</span>}
            </div>
          )}
          {error && (
            <p role="alert" className="auth-error text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="border-t pt-4">
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={pending}
              disabled={pending || (step.kind === "address" ? !newEmail.trim() : code.length !== 6)}
            >
              {step.kind === "confirm" ? "Change email" : "Continue"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
