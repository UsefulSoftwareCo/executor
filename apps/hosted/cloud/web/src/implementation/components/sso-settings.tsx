import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useOrganizationRoute } from "@executor-js/hosted-web/organization";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { Textarea } from "@executor-js/ui/components/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";
import { AsyncResult } from "effect/unstable/reactivity";
import { Exit, Option, Redacted } from "effect";
import { useState } from "react";
import { billingAtom } from "../../contracts/billing.ts";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import {
  deleteSsoAtom,
  updateSsoAtom,
  registerSsoAtom,
  ssoConnectionsAtom,
  ssoDomainTokenAtom,
  ssoSignInAtom,
  verifySsoDomainAtom,
  type SsoConnection,
} from "../../contracts/sso.ts";

/** Enterprise owners and admins can configure SSO; other teams never load its controls. */
export function SsoSettings() {
  const organization = useOrganizationRoute();
  if (
    organization.role === undefined ||
    organization.role === "member" ||
    organization.id === undefined
  )
    return null;
  return (
    <EnterpriseSsoSettings
      key={organization.id}
      organization={organization.organization}
      organizationId={organization.id}
      slug={organization.slug}
    />
  );
}

function EnterpriseSsoSettings({
  organization,
  organizationId,
  slug,
}: {
  readonly organization: OrganizationReference;
  readonly organizationId: string;
  readonly slug: string;
}) {
  const billing = useAtomValue(billingAtom(organization));
  const confirmed = Option.getOrUndefined(AsyncResult.value(billing));
  if (confirmed?.enterprise !== true) return null;
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="gap-1.5 px-4 pt-4 pb-3">
        <CardTitle>
          <h2>Single sign-on</h2>
        </CardTitle>
        <CardDescription>
          Connect your team's identity provider. Other sign-in methods stay available.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <Connections organizationId={organizationId} slug={slug} />
      </CardContent>
    </Card>
  );
}

function Connections({
  organizationId,
  slug,
}: {
  readonly organizationId: string;
  readonly slug: string;
}) {
  const query = useAtomValue(ssoConnectionsAtom(organizationId));
  const refresh = useAtomRefresh(ssoConnectionsAtom(organizationId));
  const rows = Option.getOrUndefined(AsyncResult.value(query));
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      {rows === undefined && !AsyncResult.isFailure(query) && (
        <div
          className="h-16 animate-pulse rounded-md bg-muted"
          aria-label="Loading SSO connections"
        />
      )}
      {AsyncResult.isFailure(query) && (
        <div role="alert" className="flex items-center gap-3 text-sm">
          <p>Unable to load SSO connections.</p>
          <Button variant="outline" onClick={refresh}>
            Try again
          </Button>
        </div>
      )}
      {rows?.map((connection) => (
        <Connection key={connection.providerId} connection={connection} slug={slug} />
      ))}
      {rows !== undefined &&
        rows.length === 0 &&
        (adding ? (
          <SetupForm
            organizationId={organizationId}
            onSaved={() => setAdding(false)}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <Button variant="outline" className="self-start" onClick={() => setAdding(true)}>
            Add SSO connection
          </Button>
        ))}
    </div>
  );
}

function SetupValues({
  providerId,
  type,
}: {
  readonly providerId: string;
  readonly type: "saml" | "oidc";
}) {
  const base = `${window.location.origin}/api/auth/sso`;
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-3">
      {type === "saml" && (
        <Value
          label="Identifier (Entity ID)"
          value={`${base}/saml2/sp/metadata?providerId=${providerId}`}
        />
      )}
      <Value
        label={type === "saml" ? "Reply URL (ACS)" : "Sign-in redirect URI"}
        value={
          type === "saml" ? `${base}/saml2/sp/acs/${providerId}` : `${base}/callback/${providerId}`
        }
      />
    </div>
  );
}

function Value({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Input
        aria-label={label}
        readOnly
        value={value}
        onFocus={(event) => event.target.select()}
        className="font-mono text-xs text-foreground"
      />
    </label>
  );
}

function SetupForm({
  organizationId,
  onSaved,
  onCancel,
}: {
  readonly organizationId: string;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}) {
  const [providerId] = useState(
    () => `sso-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
  );
  const [type, setType] = useState<"oidc" | "saml">("oidc");
  const [error, setError] = useState<string>();
  const save = useAtomSet(registerSsoAtom(organizationId), { mode: "promiseExit" });
  const saving = useAtomValue(registerSsoAtom(organizationId)).waiting;
  return (
    <form
      className="flex max-w-xl flex-col gap-4 [&_label]:flex [&_label]:flex-col [&_label]:gap-1.5 [&_label]:text-sm"
      onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const common = {
          organizationId,
          providerId,
          domain: String(data.get("domain")).trim().toLowerCase(),
        };
        setError(undefined);
        const result = await save(
          type === "oidc"
            ? {
                ...common,
                type,
                issuer: String(data.get("issuer")).trim(),
                clientId: String(data.get("clientId")).trim(),
                clientSecret: Redacted.make(String(data.get("clientSecret"))),
              }
            : {
                ...common,
                type,
                issuer: `${window.location.origin}/api/auth/sso/saml2/sp/metadata?providerId=${providerId}`,
                metadata: String(data.get("metadata")).trim(),
              },
        );
        if (Exit.isSuccess(result)) onSaved();
        else setError("The connection was not saved. Check the provider details and try again.");
      }}
    >
      <div className="flex gap-2" role="group" aria-label="SSO protocol">
        <Button
          type="button"
          variant={type === "oidc" ? "default" : "outline"}
          disabled={saving}
          onClick={() => setType("oidc")}
        >
          OpenID Connect
        </Button>
        <Button
          type="button"
          variant={type === "saml" ? "default" : "outline"}
          disabled={saving}
          onClick={() => setType("saml")}
        >
          SAML
        </Button>
      </div>
      <SetupValues providerId={providerId} type={type} />
      <p className="text-sm text-muted-foreground">
        Add these values to your identity provider. Keep your existing application's settings while
        testing this connection.
      </p>
      <label>
        Email domain
        <Input
          name="domain"
          placeholder="example.com"
          required
          disabled={saving}
          autoComplete="off"
        />
      </label>
      {type === "oidc" ? (
        <>
          <label>
            Issuer URL
            <Input
              name="issuer"
              type="url"
              required
              disabled={saving}
              placeholder="https://example.okta.com"
            />
          </label>
          <label>
            Client ID
            <Input name="clientId" required disabled={saving} autoComplete="off" />
          </label>
          <label>
            Client secret
            <Input
              name="clientSecret"
              type="password"
              required
              disabled={saving}
              autoComplete="new-password"
            />
          </label>
        </>
      ) : (
        <label>
          Federation metadata XML
          <Textarea
            name="metadata"
            required
            disabled={saving}
            rows={6}
            className="font-mono text-xs"
            maxLength={102400}
          />
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button loading={saving} disabled={saving}>
          Save connection
        </Button>
        <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Connection({
  connection,
  slug,
}: {
  readonly connection: SsoConnection;
  readonly slug: string;
}) {
  const token = useAtomSet(ssoDomainTokenAtom(connection.providerId), { mode: "promiseExit" });
  const tokenState = useAtomValue(ssoDomainTokenAtom(connection.providerId));
  const verify = useAtomSet(verifySsoDomainAtom(connection.organizationId), {
    mode: "promiseExit",
  });
  const verifying = useAtomValue(verifySsoDomainAtom(connection.organizationId)).waiting;
  const signIn = useAtomSet(ssoSignInAtom, { mode: "promiseExit" });
  const remove = useAtomSet(deleteSsoAtom(connection.organizationId), { mode: "promiseExit" });
  const removing = useAtomValue(deleteSsoAtom(connection.organizationId)).waiting;
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string>();
  const value = Option.getOrUndefined(AsyncResult.value(tokenState));
  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{connection.domain}</h3>
        <span className="text-xs text-muted-foreground">
          {connection.type === "saml" ? "SAML" : "OpenID Connect"} ·{" "}
          {connection.domainVerified ? "Domain verified" : "Verify domain"}
        </span>
      </div>
      <SetupValues providerId={connection.providerId} type={connection.type} />
      {connection.domainVerified ? (
        <Button
          variant="outline"
          className="self-start"
          onClick={async () => {
            const result = await signIn({
              providerId: connection.providerId,
              redirect: `/org/${slug}/organization`,
            });
            if (Exit.isFailure(result))
              setError("Unable to start SSO. Check the connection settings and try again.");
          }}
        >
          Test sign-in
        </Button>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Verify ownership of {connection.domain} before anyone can sign in through this
            connection.
          </p>
          {value ? (
            <>
              <Value
                label="DNS record name (TXT)"
                value={`_better-auth-token-${connection.providerId}.${connection.domain}`}
              />
              <Value label="DNS record value" value={value.domainVerificationToken} />
              <Button
                variant="outline"
                className="self-start"
                loading={verifying}
                disabled={verifying}
                onClick={async () => {
                  setError(undefined);
                  const result = await verify(connection.providerId);
                  if (Exit.isFailure(result))
                    setError(
                      "The DNS record could not be verified. Check its name and value, allow time for DNS to update, then try again.",
                    );
                }}
              >
                Verify domain
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              className="self-start"
              loading={tokenState.waiting}
              disabled={tokenState.waiting}
              onClick={async () => {
                setError(undefined);
                if (Exit.isFailure(await token()))
                  setError("Unable to load the DNS record. Try again.");
              }}
            >
              Show DNS record
            </Button>
          )}
        </>
      )}
      {editing ? (
        <RotateCredentials connection={connection} onClose={() => setEditing(false)} />
      ) : (
        <Button variant="ghost" className="self-start" onClick={() => setEditing(true)}>
          {connection.type === "oidc" ? "Rotate client secret" : "Update signing certificate"}
        </Button>
      )}
      {confirmRemove ? (
        <div className="space-y-2 text-sm">
          <p>Remove this SSO connection? Members will need another sign-in method.</p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              disabled={removing}
              loading={removing}
              onClick={async () => {
                setError(undefined);
                if (Exit.isFailure(await remove(connection.providerId)))
                  setError("The connection was not removed. Try again.");
              }}
            >
              Remove connection
            </Button>
            <Button variant="ghost" disabled={removing} onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          className="self-start text-destructive"
          onClick={() => setConfirmRemove(true)}
        >
          Remove SSO connection
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function RotateCredentials({
  connection,
  onClose,
}: {
  readonly connection: SsoConnection;
  readonly onClose: () => void;
}) {
  const update = useAtomSet(updateSsoAtom(connection.providerId), { mode: "promiseExit" });
  const pending = useAtomValue(updateSsoAtom(connection.providerId)).waiting;
  const [error, setError] = useState<string>();
  return (
    <form
      className="flex flex-col gap-3 text-sm"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(undefined);
        const value = String(new FormData(event.currentTarget).get("credential"));
        const result = await update({
          organizationId: connection.organizationId,
          ...(connection.type === "oidc"
            ? { clientSecret: Redacted.make(value) }
            : { metadata: value }),
        });
        if (Exit.isSuccess(result)) onClose();
        else
          setError(
            "The update was not saved. Check the credential and keep the same identity provider.",
          );
      }}
    >
      <label className="flex flex-col gap-1.5">
        {connection.type === "oidc" ? "New client secret" : "Updated federation metadata XML"}
        {connection.type === "oidc" ? (
          <Input
            name="credential"
            type="password"
            autoComplete="new-password"
            required
            disabled={pending}
          />
        ) : (
          <Textarea name="credential" required disabled={pending} rows={6} maxLength={102400} />
        )}
      </label>
      <div className="flex gap-2">
        <Button loading={pending} disabled={pending}>
          Save credential
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
