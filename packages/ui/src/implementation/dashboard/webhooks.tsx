/** Saved webhook lifecycle stays visible independently of account-dependent app evaluation. */
import {
  ProfileWebhookConfig,
  type Profile,
  type ProfileInputs,
  type WebhookSubscription,
  type WebhookId,
} from "@executor-js/sdk";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import { Exit, Schema } from "effect";
import { useState, type ComponentType, type ReactNode } from "react";
import type { FailureProps, Query } from "../../contracts/dashboard.ts";
import { QueryView } from "./context.tsx";
import { Button } from "../components/button.tsx";
import { Textarea } from "../components/textarea.tsx";
/** Profile-owned subscriptions are stopped through the account toggle, never a misleading per-hook stop button. */
export function AppWebhooks<E>({
  query,
  retry,
  Failure,
  setupLink,
  children,
}: {
  readonly query: Query<readonly WebhookSubscription[], E>;
  readonly retry: (id: WebhookId) => Atom.AtomResultFn<void, WebhookSubscription, E>;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly setupLink: (subscription: WebhookSubscription) => ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="space-y-4 px-5 py-3">
      <QueryView
        query={query}
        Failure={Failure}
        pending={<p className="text-sm text-muted-foreground">Loading webhooks…</p>}
      >
        {(rows) => (
          <div className="divide-y">
            {rows.length === 0 && (
              <p className="text-sm text-muted-foreground">No webhook subscriptions.</p>
            )}
            {rows.map((row) => (
              <WebhookRow
                key={row.id}
                hook={row}
                retry={retry(row.id)}
                Failure={Failure}
                setupLink={setupLink}
              />
            ))}
          </div>
        )}
      </QueryView>
      {children}
    </div>
  );
}
function WebhookRow<E>({
  hook,
  retry,
  Failure,
  setupLink,
}: {
  readonly hook: WebhookSubscription;
  readonly retry: Atom.AtomResultFn<void, WebhookSubscription, E>;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly setupLink: (subscription: WebhookSubscription) => ReactNode;
}) {
  const run = useAtomSet(retry),
    result = useAtomValue(retry);
  return (
    <div className="space-y-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div>
          <span className="font-medium">{hook.name}</span>
          <span className="ml-3 text-xs text-muted-foreground">
            {hook.status.replaceAll("-", " ")}
          </span>
        </div>
        {(hook.status === "setup-required" || hook.status === "disabled") && setupLink(hook)}
        {hook.failure !== null && (
          <Button
            size="sm"
            variant="outline"
            disabled={AsyncResult.isWaiting(result)}
            onClick={() => run()}
          >
            Retry webhook
          </Button>
        )}
      </div>
      {hook.failure !== null && (
        <p role="alert" className="text-xs text-destructive">
          {hook.failure === "register" ? "Registration failed." : "Removal failed."}
        </p>
      )}
      {AsyncResult.isFailure(result) && <Failure cause={result.cause} />}
    </div>
  );
}
/** Capture account bindings with the editor revision; a concurrent selection change must conflict. */
export function WebhookConfiguration<E>({
  profile,
  update,
  Failure,
}: {
  readonly profile: Profile;
  readonly update: Atom.AtomResultFn<
    Omit<typeof ProfileInputs.update.Type, "app" | "profile">,
    Profile,
    E
  >;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const [base, setBase] = useState(profile);
  const [config, setConfig] = useState(() => JSON.stringify(profile.webhookConfig, null, 2));
  const [invalid, setInvalid] = useState(false);
  const save = useAtomSet(update, { mode: "promiseExit" }),
    result = useAtomValue(update);
  return (
    <details open={profile.failure === "configuration"} className="max-w-xl">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Webhook configuration
      </summary>
      <form
        className="mt-3 space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          const value = Schema.decodeUnknownExit(Schema.fromJsonString(ProfileWebhookConfig))(
            config,
          );
          setInvalid(Exit.isFailure(value));
          if (Exit.isFailure(value)) return;
          const saved = await save({
            accounts: base.accounts,
            expectedRevision: base.revision,
            webhookConfig: value.value,
          });
          if (Exit.isSuccess(saved)) setBase(saved.value);
        }}
      >
        <Textarea
          aria-label="Webhook configuration"
          className="min-h-32 font-mono text-xs"
          value={config}
          onChange={(event) => setConfig(event.target.value)}
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">
          Enter a JSON object with one configuration per webhook name.
        </p>
        {invalid && (
          <p role="alert" className="text-sm text-destructive">
            Enter a JSON object.
          </p>
        )}
        {AsyncResult.isFailure(result) && <Failure cause={result.cause} />}
        <Button size="sm" variant="outline" disabled={AsyncResult.isWaiting(result)}>
          Save webhook configuration
        </Button>
      </form>
    </details>
  );
}
