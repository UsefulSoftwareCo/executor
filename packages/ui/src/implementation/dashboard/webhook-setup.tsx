import { useState, type ComponentType } from "react";
import { Cause, Exit, Option, Redacted, Schema } from "effect";
import type { AsyncResult } from "effect/unstable/reactivity";
import { QueryResult } from "./context.tsx";
import type { WebhookSetupView, WebhookSubscription } from "@executor-js/sdk";
import type { WebhookSetupSubmission } from "../../contracts/webhook-setup.ts";
import type { FailureProps } from "../../contracts/dashboard.ts";
import {
  accountFields,
  credentialValues,
  credentialsComplete,
} from "../../contracts/credentials.ts";
import { CredentialFields } from "../components/credential-fields.tsx";
import { Button } from "../components/button.tsx";
import { Card, CardContent } from "../components/card.tsx";
import { Checkbox } from "../components/checkbox.tsx";
import { Input } from "../components/input.tsx";
import { Textarea } from "../components/textarea.tsx";
import { CopyButton } from "./code.tsx";

type Action<E> = () => Promise<Exit.Exit<WebhookSubscription, E>>;
/** Compact setup UI shared by every product; authentication and exact error types stay in the caller. */
export function WebhookSetupPage<E>({
  result,
  complete,
  remove,
  confirmRemoval,
  Failure,
  retry,
}: {
  readonly result: AsyncResult.AsyncResult<WebhookSetupView, E>;
  readonly complete: (input: WebhookSetupSubmission) => Promise<Exit.Exit<WebhookSubscription, E>>;
  readonly remove: Action<E>;
  readonly confirmRemoval: Action<E>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly retry: () => void;
}) {
  return (
    <section className="page mx-auto w-full max-w-xl gap-4">
      <QueryResult
        result={result}
        Failure={Failure}
        retry={retry}
        pending={<p className="muted">Loading webhook setup…</p>}
      >
        {(current) => (
          <SetupForm
            key={`${current.subscription.id}:${current.step}`}
            view={current}
            complete={complete}
            remove={remove}
            confirmRemoval={confirmRemoval}
            Failure={Failure}
          />
        )}
      </QueryResult>
    </section>
  );
}
function CopyValue({
  label,
  value,
  secret = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly secret?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-1.5">
      <span className="field-label">{label}</span>
      <div className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2">
        <code className="min-w-0 flex-1 break-all text-xs" data-private={secret || undefined}>
          {secret && !visible ? "••••••••••••••••" : value}
        </code>
        {secret && (
          <Button type="button" size="xs" variant="ghost" onClick={() => setVisible(!visible)}>
            {visible ? "Hide" : "Show"}
          </Button>
        )}
        <CopyButton code={value} label={`Copy ${label.toLowerCase()}`} inline />
      </div>
    </div>
  );
}
function SetupForm<E>({
  view,
  complete,
  remove,
  confirmRemoval,
  Failure,
}: {
  readonly view: WebhookSetupView;
  readonly complete: (input: WebhookSetupSubmission) => Promise<Exit.Exit<WebhookSubscription, E>>;
  readonly remove: Action<E>;
  readonly confirmRemoval: Action<E>;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Cause.Cause<E>>();
  const [confirmed, setConfirmed] = useState(false);
  const [secret, setSecret] = useState("");
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [json, setJson] = useState("{}");
  const run = (action: Action<E>) => {
    setPending(true);
    setFailure(undefined);
    void action().then((exit) => {
      setPending(false);
      if (Exit.isFailure(exit)) setFailure(exit.cause);
      else {
        setValues({});
        setSecret("");
        setJson("{}");
      }
    });
  };
  if (view.step === "done")
    return (
      <Card className="gap-4 py-4 shadow-none">
        <CardContent className="space-y-4 px-4">
          <h1 className="text-xl font-semibold">
            {view.subscription.status === "active" ? "Webhook ready" : "Removal confirmed"}
          </h1>
          <p className="muted">You can return to your agent.</p>
          {failure && <Failure cause={failure} />}
          {view.subscription.status === "active" && (
            <Button variant="outline" loading={pending} onClick={() => run(remove)}>
              Remove webhook
            </Button>
          )}
        </CardContent>
      </Card>
    );
  if (view.step === "remove")
    return (
      <Card className="gap-4 py-4 shadow-none">
        <CardContent className="space-y-4 px-4">
          <h1 className="text-xl font-semibold">Webhook disabled</h1>
          <p>
            Executor has stopped accepting deliveries. If you added this webhook in your provider,
            remove it there before confirming.
          </p>
          <CopyValue label="Callback URL" value={view.subscription.callbackUrl} />
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(value) => setConfirmed(value === true)}
              disabled={pending}
            />
            <span>This webhook is no longer registered with the provider.</span>
          </label>
          {failure && <Failure cause={failure} />}
          <Button disabled={!confirmed} loading={pending} onClick={() => run(confirmRemoval)}>
            Confirm removal
          </Button>
        </CardContent>
      </Card>
    );
  const parsedFields = accountFields({ type: "secrets", fields: view.stateSchema });
  const fields =
    parsedFields !== undefined && Option.isSome(parsedFields) ? parsedFields.value : undefined;
  const raw = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(json);
  const ready =
    confirmed &&
    (view.signingSecret.source === "executor" || secret.length > 0) &&
    (fields === undefined ? Option.isSome(raw) : credentialsComplete(fields, values));
  return (
    <Card className="gap-4 py-4 shadow-none">
      <CardContent className="px-4">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || pending) return;
            const state =
              fields === undefined
                ? Option.isSome(raw)
                  ? raw.value
                  : undefined
                : credentialValues(fields, values);
            if (state === undefined) return;
            run(() =>
              complete({
                revision: view.revision,
                state: Redacted.make(state),
                ...(view.signingSecret.source === "provider"
                  ? { secret: Redacted.make(secret) }
                  : {}),
              }),
            );
          }}
        >
          <h1 className="text-xl font-semibold">Set up webhook</h1>
          <p className="whitespace-pre-line text-sm">{view.instructions}</p>
          <CopyValue label="Callback URL" value={view.subscription.callbackUrl} />
          {view.signingSecret.source === "executor" ? (
            <CopyValue
              label="Signing secret"
              value={Redacted.value(view.signingSecret.value)}
              secret
            />
          ) : (
            <label className="field-label">
              Provider signing secret
              <Input
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
                required
                disabled={pending}
              />
            </label>
          )}
          {fields !== undefined ? (
            <CredentialFields
              fields={fields}
              values={values}
              onChange={setValues}
              pending={pending}
            />
          ) : (
            <label className="field-label">
              Setup details (JSON)
              <Textarea
                data-private
                value={json}
                onChange={(event) => setJson(event.target.value)}
                spellCheck={false}
                disabled={pending}
              />
              {Option.isNone(raw) && <span role="alert">Enter valid JSON.</span>}
            </label>
          )}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(value) => setConfirmed(value === true)}
              disabled={pending}
            />
            <span>I added this webhook in the provider.</span>
          </label>
          {failure && <Failure cause={failure} />}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!ready} loading={pending}>
              Finish setup
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => run(remove)}>
              Cancel setup
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
