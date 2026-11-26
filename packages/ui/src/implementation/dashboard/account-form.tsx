import { useState, type ComponentType, type ReactNode } from "react";
import { Exit, Match, Option, Redacted, type Cause } from "effect";
import type {
  Account,
  AccountCheckStatus,
  AppId,
  CredentialCheck,
  Provider,
} from "@executor-js/sdk";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  SquareLock02Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import type { FailureProps } from "../../contracts/dashboard.ts";
import {
  type AccountFormFields,
  accountFields,
  credentialsComplete,
  credentialValues,
  type AccountSubmission,
  type AccountOAuthProps,
  type AccountInteractiveProps,
} from "../../contracts/credentials.ts";
import { CredentialFields } from "../components/credential-fields.tsx";
import { Button } from "../components/button.tsx";
import { Spinner } from "../components/spinner.tsx";
import { CopyButton } from "./code.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";
import { SetupHelp } from "./markdown.tsx";
import { CredentialHosts } from "./credential-hosts.tsx";

export function AccountForm<A, E>({
  provider,
  account,
  header,
  actions,
  submitLabel,
  submit,
  onSaved,
  oauth,
  interactive,
  Failure,
  onPendingChange,
  initialMethod,
  check,
  disabled = false,
}: {
  readonly check?: {
    readonly app: AppId;
    readonly run: (input: AccountSubmission) => Promise<Exit.Exit<CredentialCheck | null, E>>;
  };
  readonly provider: Provider;
  readonly account?: Pick<Account, "method">;
  readonly header?: ReactNode;
  readonly actions?: ReactNode;
  readonly submitLabel: string;
  readonly submit: (input: AccountSubmission) => Promise<Exit.Exit<A, E>>;
  readonly onSaved: (value: NoInfer<A>) => void;
  readonly oauth: (props: AccountOAuthProps) => ReactNode;
  readonly interactive?: ((props: AccountInteractiveProps) => ReactNode) | undefined;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly disabled?: boolean;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly initialMethod?: string | undefined;
}) {
  const methods = Object.entries(provider.definition.auth)
    .filter(([, method]) => method.type !== "secrets" || method.provisioned !== true)
    .sort(([, a], [, b]) => Number(b.type === "oauth2") - Number(a.type === "oauth2"));
  const [method, setMethod] = useState(account?.method ?? initialMethod ?? methods[0]?.[0] ?? "");
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [submitting, setPending] = useState(false);
  const pending = submitting || disabled;
  const [error, setError] = useState<Cause.Cause<E>>();
  const auth = provider.definition.auth[method];
  const parsed = auth && accountFields(auth);
  const fields = parsed && Option.isSome(parsed) ? parsed.value : undefined;
  const guide = auth?.type === "secrets" ? auth.guide : undefined;
  const updatePending = (value: boolean) => {
    setPending(value);
    onPendingChange?.(value);
  };
  const [verdict, setVerdict] = useState<Verdict>({ state: "idle" });
  const validates = check !== undefined && auth?.type === "secrets";
  const changeValues = (nextValues: Readonly<Record<string, string>>) => {
    setValues(nextValues);
    setVerdict({ state: "idle" });
  };
  const submitText =
    !validates || auth?.type !== "secrets"
      ? submitLabel
      : verdict.state === "checking"
        ? "Validating…"
        : verdict.state === "idle"
          ? "Validate"
          : verdict.state === "done" && verdict.result.status === "healthy"
            ? "Continue"
            : "Continue anyway";
  const busy = pending || verdict.state === "checking";
  const save = (input: AccountSubmission) => {
    updatePending(true);
    setError(undefined);
    void submit(input).then((exit) => {
      updatePending(false);
      if (Exit.isFailure(exit)) setError(exit.cause);
      else {
        changeValues({});
        onSaved(exit.value);
      }
    });
  };
  return (
    <form
      className="setup-form flex max-w-145 min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !fields ||
          pending ||
          verdict.state === "checking" ||
          !credentialsComplete(fields, values)
        )
          return;
        const input = {
          method,
          fields: Redacted.make(credentialValues(fields, values)),
        };
        if (!validates || check === undefined || verdict.state !== "idle") return save(input);
        setVerdict({ state: "checking" });
        void check.run(input).then((exit) => {
          if (Exit.isSuccess(exit) && exit.value === null) {
            setVerdict({ state: "idle" });
            save(input);
          } else
            setVerdict(
              Exit.isSuccess(exit) && exit.value !== null
                ? { state: "done", result: exit.value }
                : { state: "unverified" },
            );
        });
      }}
    >
      {header}
      {!account && methods.length > 1 && (
        <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
          Sign-in method
          <Select
            value={method}
            disabled={pending}
            onValueChange={(value) => {
              setMethod(value);
              changeValues({});
              setError(undefined);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="w-(--radix-select-trigger-width)">
              {methods.map(([name, auth]) => (
                <SelectItem key={name} value={name}>
                  {auth.type === "oauth2" ? `Sign in with ${provider.definition.name}` : auth.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      )}
      {auth?.type === "oauth2" ? (
        <div key={method} className="oauth-fields flex flex-col gap-4">
          {oauth({
            method,
            disabled,
            clientGuide: auth.clientGuide,
            onPendingChange: updatePending,
            access: (
              <SignInAccess provider={provider.definition.name} hosts={provider.definition.hosts} />
            ),
          })}
        </div>
      ) : auth?.type === "interactive" && interactive ? (
        <div key={method} className="flex flex-col gap-4">
          {interactive({ method, label: auth.label, disabled, onPendingChange: updatePending })}
        </div>
      ) : fields ? (
        <>
          {(Object.keys(fields.properties).length === 0 || !guide) && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {Object.keys(fields.properties).length === 0
                ? "This connection sends no credentials. Continue only if the service supports public access."
                : `Get these credentials from your ${provider.definition.name} account settings.`}
            </p>
          )}
          {guide && <SetupHelp label="Setup guide">{guide}</SetupHelp>}
          <CredentialFields
            fields={fields}
            hosts={provider.definition.hosts}
            values={values}
            onChange={changeValues}
            pending={pending}
          />
          <CredentialAccess
            hosts={provider.definition.hosts}
            {...secretAccess(fields, provider.definition.hosts)}
          />
          {check !== undefined && auth?.type === "secrets" && (
            <CredentialVerdict
              app={check.app}
              verdict={verdict}
              method={auth.label}
              provider={provider.definition.name}
            />
          )}
          {error && <Failure cause={error} />}
          <div className="form-actions flex items-center gap-5 pt-1 text-[13px] [&_a]:text-muted-foreground max-[740px]:[&_>_a]:min-h-11 max-[740px]:[&_>_a]:inline-flex max-[740px]:[&_>_a]:items-center max-[740px]:flex-wrap max-[740px]:gap-[12px_20px] max-[480px]:[&_>_button]:basis-full">
            <Button
              type="submit"
              className={busy ? "relative w-full" : "w-full"}
              disabled={busy || !credentialsComplete(fields, values)}
              aria-label={submitText}
            >
              <span className={busy ? "invisible" : undefined}>{submitText}</span>
              {busy && (
                <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
                  <Spinner className="size-3.5" />
                </span>
              )}
            </Button>
            {actions}
          </div>
        </>
      ) : (
        <p className="setup-notice py-[12px] px-[14px] border border-border rounded-[7px] text-muted-foreground bg-muted text-[13px] my-[8px] mx-0">
          This provider needs a custom credential form.
        </p>
      )}
    </form>
  );
}

const secretAccess = (fields: AccountFormFields, hosts: readonly string[] | undefined) => {
  const secrets = Object.entries(fields.properties)
    .filter(([name, field]) => field.type === "string" && !fields.plain?.includes(name))
    .map(([name]) => hosts !== undefined && !fields.raw?.includes(name));
  return { hidden: secrets.includes(true), readable: secrets.includes(false) };
};

function CredentialAccess({
  hosts,
  hidden,
  readable,
}: {
  readonly hosts?: readonly string[] | undefined;
  readonly hidden: boolean;
  readonly readable: boolean;
}) {
  if (!hidden && !readable) return null;
  return (
    <div
      className="flex flex-col gap-1.5 text-xs leading-relaxed text-muted-foreground"
      data-credential-hosts
    >
      {hidden && hosts !== undefined && (
        <div className="flex items-start gap-1.5" data-credential-access="hidden">
          <HugeiconsIcon
            icon={SquareLock02Icon}
            className="mt-0.5 size-3.5 shrink-0 text-emerald-600"
          />
          {hosts.length === 0 ? (
            <span className="min-w-0">
              Executor never sends hidden values on the app's requests. The app and your agent get a
              placeholder.
            </span>
          ) : (
            <CredentialHosts
              hosts={hosts}
              lead="Hidden values are only sent to"
              after="The app and your agent get a placeholder."
            />
          )}
        </div>
      )}
      {readable && (
        <p className="flex items-start gap-1.5" data-credential-access="readable">
          <HugeiconsIcon icon={ViewIcon} className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <span className="min-w-0">
            The app can read {hidden ? "the other" : "these"} values and send them anywhere.
            {hosts === undefined && " You can ask your agent to limit where they are sent."}
          </span>
        </p>
      )}
    </div>
  );
}

function SignInAccess({
  provider,
  hosts,
}: {
  readonly provider: string;
  readonly hosts?: readonly string[] | undefined;
}) {
  return hosts === undefined ? (
    <p
      className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground"
      data-credential-access="readable"
    >
      <HugeiconsIcon icon={ViewIcon} className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
      <span className="min-w-0">
        The app can read your {provider} sign-in and send it anywhere. You can ask your agent to
        limit where it is sent.
      </span>
    </p>
  ) : (
    <div
      className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground"
      data-credential-access="hidden"
      data-credential-hosts
    >
      <HugeiconsIcon
        icon={SquareLock02Icon}
        className="mt-0.5 size-3.5 shrink-0 text-emerald-600"
      />
      {hosts.length === 0 ? (
        <span className="min-w-0">
          Executor never sends your {provider} sign-in on the app's requests.
        </span>
      ) : (
        <CredentialHosts hosts={hosts} lead={`Your ${provider} sign-in is only sent to`} />
      )}
    </div>
  );
}

type Verdict =
  | { readonly state: "idle" }
  | { readonly state: "checking" }
  | { readonly state: "done"; readonly result: CredentialCheck }
  | { readonly state: "unverified" };

const checkFailure = (
  status: Exclude<AccountCheckStatus, "healthy">,
  provider: string,
  message: string | undefined,
) =>
  Match.value(status).pipe(
    Match.when("credentials_rejected", () => `${provider} rejected these credentials`),
    Match.when("forbidden", () => "These credentials are missing a permission the app needs"),
    Match.when("upstream_unavailable", () => `Couldn't reach ${provider} to check it`),
    Match.when(
      "check_failed",
      () => `Couldn't verify these credentials${message === undefined ? "" : `: ${message}`}`,
    ),
    Match.exhaustive,
  );

const checkFixPrompt = (app: AppId, provider: string, method: string, failure: string) =>
  [
    `The account check in my Executor app (app ID: ${app}) failed for my ${provider} credentials (sign-in method: ${method}), and the check itself may be wrong.`,
    "",
    `The check reported: ${failure}`,
    "",
    `Start with the Executor app's executor skill. Read the app's source, find the health check for the ${provider} provider, and fix it so it accepts working credentials and still rejects bad ones. Deploy the updated app. Don't ask me to paste the credentials into chat.`,
  ].join("\n");

function CredentialVerdict({
  app,
  verdict,
  method,
  provider,
}: {
  readonly app: AppId;
  readonly verdict: Verdict;
  readonly method: string;
  readonly provider: string;
}) {
  const shown =
    verdict.state === "done"
      ? verdict.result
      : verdict.state === "unverified"
        ? ({ status: "check_failed", info: null } as const)
        : undefined;
  const name = shown?.info?.displayName ?? shown?.info?.username ?? shown?.info?.email;
  const failure =
    shown === undefined || shown.status === "healthy"
      ? undefined
      : checkFailure(shown.status, provider, shown.message);
  const tone =
    shown === undefined
      ? "muted"
      : shown.status === "healthy"
        ? "good"
        : shown.status === "credentials_rejected"
          ? "bad"
          : "warn";
  const doubtsCheck =
    failure !== undefined && shown !== undefined && shown.status !== "upstream_unavailable";
  return (
    <div
      className={`-mt-1 flex min-h-4 items-start gap-1.5 text-xs transition-opacity duration-150 ${
        shown === undefined ? "opacity-0" : "opacity-100"
      } ${tone === "bad" ? "text-destructive" : "text-muted-foreground"}`}
      role="status"
      aria-live="polite"
      {...(shown === undefined ? {} : { "data-credential-check": shown.status })}
    >
      {verdict.state === "checking" && <span className="sr-only">Validating…</span>}
      {shown !== undefined && (
        <>
          <HugeiconsIcon
            icon={tone === "good" ? CheckmarkCircle02Icon : AlertCircleIcon}
            size={13}
            strokeWidth={2}
            className={
              tone === "good"
                ? "mt-px shrink-0 text-emerald-600 dark:text-emerald-400"
                : tone === "bad"
                  ? "mt-px shrink-0"
                  : "mt-px shrink-0 text-amber-600 dark:text-amber-400"
            }
            aria-hidden
          />
          <div className="flex min-w-0 flex-col items-start gap-0.5">
            <span className="line-clamp-3 wrap-anywhere">
              {failure ??
                (name === undefined ? (
                  <>Valid credentials</>
                ) : (
                  <>
                    Signed in as <span className="font-medium text-foreground">{name}</span>
                  </>
                ))}
            </span>
            {doubtsCheck && (
              <>
                <span className="text-muted-foreground" data-credential-check-advice>
                  The app's check may be wrong. You can still add these credentials and ask your
                  agent to fix the check.
                </span>
                <div className="mt-1 text-foreground">
                  <CopyButton
                    code={checkFixPrompt(app, provider, method, failure)}
                    label="Copy fix prompt"
                    text="Copy fix prompt"
                    variant="outline"
                    inline
                  />
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
