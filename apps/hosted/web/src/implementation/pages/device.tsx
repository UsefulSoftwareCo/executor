import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { reportBrowserUsage } from "../../contracts/product-analytics.ts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Cause, Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { grantTarget, type GrantTarget } from "@executor-js/mcp-auth/grants";
import {
  deviceVerificationPath,
  formatUserCode,
  normalizeUserCode,
  type DeviceRequestView,
} from "@executor-js/mcp-auth/device";
import {
  McpConsentActions,
  McpConsentLayout,
  McpConsentLoading,
  McpConsentRow,
  McpConsentSummary,
} from "@executor-js/ui/dashboard/mcp-consent";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import {
  McpConnectionFailed,
  deviceDecisionAtom,
  deviceRequestAtom,
  mcpClientAtom,
} from "../../contracts/mcp.ts";
import { organizationsAtom, type OrganizationSummary } from "../../contracts/organization.ts";
import { useResourceOrigins } from "../resource-origin.ts";
import { useGrantChoices } from "../components/grant-choices.tsx";

/** `verification_uri_complete` carries the code; the plain `verification_uri` asks for it. */
export const deviceSearch = (search: Record<string, unknown>) => ({
  user_code: typeof search.user_code === "string" ? search.user_code : "",
});

/**
 * RFC 8628 verification: a signed-in person enters or confirms the code a device shows, sees
 * which registered client asks and for what, chooses the organization as consent does, and
 * approves or denies. The device finishes signing in on its own.
 */
export function DevicePage({ user_code }: { readonly user_code: string }) {
  const code = normalizeUserCode(user_code);
  // A new code starts a new decision; nothing from a previous code carries over.
  return code === undefined ? (
    <EnterCode initial={user_code} error={user_code === "" ? null : invalidCode} />
  ) : (
    <DeviceLookup key={code} code={code} />
  );
}

const invalidCode = "Enter the eight-letter code your device shows, such as BCDF-GHJK.";

function EnterCode({
  initial,
  error,
}: {
  readonly initial: string;
  readonly error: string | null;
}) {
  const navigate = useNavigate();
  const [value, setValue] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void navigate({
      to: deviceVerificationPath,
      search: { user_code: value.trim() },
      replace: true,
    });
  };
  return (
    <McpConsentLayout description={<p>Enter the code shown on your device to connect it.</p>}>
      <form onSubmit={submit} className="grid gap-5">
        <div className="grid gap-2 text-[13px] [font-weight:550]">
          <label htmlFor="device-code">Code</label>
          <Input
            id="device-code"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus
            aria-invalid={error !== null}
            className="font-mono text-[16px] tracking-[0.12em] uppercase"
          />
        </div>
        {error && (
          <p role="alert" className="text-destructive text-[13px]">
            {error}
          </p>
        )}
        <div className="mcp-consent-actions grid gap-2.5">
          <Button type="submit" disabled={value.trim() === ""}>
            Continue
          </Button>
        </div>
      </form>
    </McpConsentLayout>
  );
}

function DeviceLookup({ code }: { readonly code: string }) {
  const request = useAtomValue(deviceRequestAtom(code));
  return AsyncResult.builder(request)
    .onInitial(() => <McpConsentLoading />)
    .onFailure((cause) => {
      const failure = Cause.squash(cause);
      return (
        <EnterCode
          initial={formatUserCode(code)}
          error={
            failure instanceof McpConnectionFailed
              ? failure.message
              : "This code could not be checked. Try again."
          }
        />
      );
    })
    .onSuccess((view) => <DeviceReview code={code} view={view} />)
    .exhaustive();
}

function DeviceReview({ code, view }: { readonly code: string; readonly view: DeviceRequestView }) {
  const resourceOrigins = useResourceOrigins();
  const target = grantTarget(resourceOrigins, [view.resource]);
  const client = useAtomValue(mcpClientAtom(view.clientId));
  const organizations = useAtomValue(organizationsAtom);
  const [decided, setDecided] = useState<"approved" | "denied">();
  if (decided === "approved")
    return (
      <McpConsentLayout description={<p>Your device is connected.</p>}>
        <p role="status" className="text-[14px] leading-[1.6]">
          Return to your device. It finishes signing in on its own; you can close this page.
        </p>
      </McpConsentLayout>
    );
  if (decided === "denied")
    return (
      <McpConsentLayout description={<p>Request denied.</p>}>
        <p role="status" className="text-[14px] leading-[1.6]">
          Your device was not connected. You can close this page.
        </p>
      </McpConsentLayout>
    );
  if (target === undefined || AsyncResult.isFailure(client) || AsyncResult.isFailure(organizations))
    return (
      <McpConsentLayout description="This request could not be loaded.">
        <p role="alert">Start signing in again on your device.</p>
      </McpConsentLayout>
    );
  if (!AsyncResult.isSuccess(client) || !AsyncResult.isSuccess(organizations))
    return <McpConsentLoading />;
  return (
    <DeviceDecision
      code={code}
      target={target}
      client={client.value.client_name ?? "An application"}
      organizations={organizations.value}
      onDecided={setDecided}
    />
  );
}

function DeviceDecision({
  code,
  target,
  client,
  organizations,
  onDecided,
}: {
  readonly code: string;
  readonly target: GrantTarget;
  readonly client: string;
  readonly organizations: readonly OrganizationSummary[];
  readonly onDecided: (decision: "approved" | "denied") => void;
}) {
  const decide = useAtomSet(deviceDecisionAtom, { mode: "promiseExit" });
  const state = useAtomValue(deviceDecisionAtom);
  const [error, setError] = useState<string | null>(null);
  const choices = useGrantChoices({ target, organizations, disabled: state.waiting });
  const submit = async (accept: boolean) => {
    const action = accept ? "approve_device" : "deny_device";
    reportBrowserUsage({ area: "mcp", action, outcome: "started" });
    setError(null);
    const result = await decide({ userCode: code, accept, ...choices.decision });
    reportBrowserUsage({
      area: "mcp",
      action,
      outcome: Exit.isSuccess(result) ? "success" : "failure",
    });
    if (Exit.isSuccess(result)) onDecided(result.value.status);
    else {
      const failure = Cause.squash(result.cause);
      setError(
        failure instanceof McpConnectionFailed
          ? failure.message
          : "Unable to complete this request. Try again.",
      );
    }
  };
  return (
    <McpConsentLayout
      description={
        <p>
          <strong>{client}</strong> on another device wants to connect to Executor.
        </p>
      }
    >
      {organizations.length === 0 ? (
        <EmptyState size="compact" title="No organizations">
          Ask an organization admin for an invitation, then return here to connect.
        </EmptyState>
      ) : (
        <McpConsentSummary note="Only continue if your device shows this code.">
          <McpConsentRow label="Code">
            <span className="font-mono tracking-[0.12em] text-foreground [font-weight:550]">
              {formatUserCode(code)}
            </span>
          </McpConsentRow>
          {choices.rows}
        </McpConsentSummary>
      )}
      {error && (
        <p role="alert" className="auth-error text-destructive text-[13px]">
          {error}
        </p>
      )}
      <McpConsentActions
        decline="Deny"
        onDecline={() => submit(false)}
        onConnect={organizations.length > 0 ? () => submit(true) : undefined}
        connectDisabled={!choices.ready}
        waiting={state.waiting}
      />
    </McpConsentLayout>
  );
}
