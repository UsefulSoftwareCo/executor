/** Administrators register the OAuth clients members connect accounts with, and choose who may. */
import { useAtomSet } from "@effect/atom-react";
import { Cause, Exit, Option, Redacted } from "effect";
import { useState, type ReactNode } from "react";
import type { HttpUrl, OAuthClientId } from "@executor-js/sdk";
import type { AppAudience } from "@executor-js/hosted-server/resource-access";
import type {
  HostedOAuthClient,
  OAuthClientDirectory,
  OAuthClientService,
} from "@executor-js/hosted-server/oauth-clients";
import { Button } from "@executor-js/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@executor-js/ui/components/dropdown-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { Input } from "@executor-js/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/ui/components/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@executor-js/ui/components/dialog";
import { QueryView } from "@executor-js/ui/dashboard/context";
import { CopyButton } from "@executor-js/ui/dashboard/code";
import { DetailSkeleton } from "@executor-js/ui/dashboard/loading";
import { OAuthClientOrigin, issuerLabel } from "@executor-js/ui/dashboard/oauth-client-origin";
import { appError, type HostedError } from "../../contracts/errors.ts";
import { groupsAtom } from "../../contracts/groups.ts";
import {
  oauthClientsAtom,
  registerOAuthClientAtom,
  removeOAuthClientAtom,
  updateOAuthClientAtom,
} from "../../contracts/oauth-clients.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganization } from "../components/organization.tsx";
import { AudienceInput, audienceError } from "../components/sharing.tsx";

/** Administrators manage these from the account list; members never see the manager. */
export function OAuthClientsDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const organization = useOrganization();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] grid-cols-[minmax(0,1fr)] gap-4 overflow-x-hidden overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-base">OAuth clients</DialogTitle>
          <DialogDescription>
            Clients members can sign in with when they connect accounts. Secrets are never shown
            again.
          </DialogDescription>
        </DialogHeader>
        <QueryView
          query={oauthClientsAtom(organization.organization)}
          Failure={HostedFailure}
          pending={<DetailSkeleton label="Loading OAuth clients" />}
        >
          {(directory) => <OAuthClientList directory={directory} />}
        </QueryView>
      </DialogContent>
    </Dialog>
  );
}

/** One form is open at a time: registering a client, or editing one. */
type OpenForm =
  | { readonly kind: "register" }
  | { readonly kind: "edit"; readonly client: OAuthClientId };

/** The apps that sign in at a server, by name, as one label. */
const serviceName = (service: OAuthClientService) =>
  service.providers.map((provider) => provider.name).join(", ");

function OAuthClientList({ directory }: { readonly directory: OAuthClientDirectory }) {
  const [form, setForm] = useState<OpenForm>();
  const services = new Map(directory.services.map((service) => [service.issuer, service]));
  return (
    <div className="flex flex-col gap-4">
      <div>
        {directory.clients.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No OAuth clients yet.</p>
        ) : (
          <ul aria-label="OAuth clients" className="divide-y rounded-md border">
            {directory.clients.map((entry) => (
              <OAuthClientRow
                key={entry.client.id}
                entry={entry}
                clients={directory.clients.map((other) => other.client)}
                service={
                  entry.client.issuer === null ? undefined : services.get(entry.client.issuer)
                }
                redirectUri={directory.redirectUri}
                editing={form?.kind === "edit" && form.client === entry.client.id}
                onEdit={(editing) =>
                  setForm(editing ? { kind: "edit", client: entry.client.id } : undefined)
                }
              />
            ))}
          </ul>
        )}
        {form?.kind === "register" && (
          <RegisterOAuthClient
            services={directory.services}
            redirectUri={directory.redirectUri}
            onDone={() => setForm(undefined)}
          />
        )}
        {directory.unresolved.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Couldn’t reach the sign-in service of{" "}
            {directory.unresolved.map((provider) => provider.name).join(", ")} just now, so it isn’t
            listed. Try again later.
          </p>
        )}
      </div>
      {form?.kind !== "register" && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            disabled={directory.services.length === 0}
            disabledReason={
              directory.services.length === 0
                ? "Add an app that signs in with OAuth to register a client for it."
                : undefined
            }
            onClick={() => setForm({ kind: "register" })}
          >
            Register client
          </Button>
        </div>
      )}
    </div>
  );
}

function OAuthClientRow({
  entry,
  clients,
  service: known,
  redirectUri,
  editing,
  onEdit,
}: {
  readonly entry: HostedOAuthClient;
  /** Every listed client, to tell apart clients with the same client ID. */
  readonly clients: ReadonlyArray<HostedOAuthClient["client"]>;
  /** The organization's apps that sign in at the client's server, when any still do. */
  readonly service: OAuthClientService | undefined;
  readonly redirectUri: string;
  readonly editing: boolean;
  readonly onEdit: (editing: boolean) => void;
}) {
  const organization = useOrganization();
  const key = { organization: organization.organization, client: entry.client.id };
  const remove = useAtomSet(removeOAuthClientAtom(key), { mode: "promiseExit" });
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();
  const { client, access } = entry;
  // Clients have no names: the server, by the apps that sign in there, and the public client ID
  // identify one. A client stored before its server was recorded is offered to no sign-in.
  const server = client.issuer === null ? undefined : issuerLabel(client.issuer);
  const service =
    known !== undefined ? serviceName(known) : (server ?? "Sign-in service not recorded");
  const audience =
    access.audience.kind === "everyone"
      ? "Everyone"
      : access.audience.kind === "private"
        ? "Only the creator"
        : `${access.audience.groups.length} ${access.audience.groups.length === 1 ? "group" : "groups"}`;
  return (
    <li className="flex flex-col gap-3 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="truncate text-[13px] font-medium">{service}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{client.clientId}</p>
          <p className="truncate text-xs text-muted-foreground">
            {server === undefined ? "Not offered until registered again" : server} ·{" "}
            <OAuthClientOrigin client={client} clients={clients} /> · {audience}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              loading={removing}
              aria-label={`Manage ${service} client ${client.clientId}`}
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem
              disabled={client.source !== "manual"}
              title={
                client.source === "manual"
                  ? undefined
                  : "Automatic clients keep the registration the service issued, and everyone may use them."
              }
              onSelect={() => onEdit(!editing)}
            >
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={async () => {
                setRemoving(true);
                setError(undefined);
                const result = await remove();
                if (Exit.isFailure(result)) {
                  setError(appError(result.cause));
                  setRemoving(false);
                }
              }}
            >
              Remove client
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}
      {editing && (
        <EditOAuthClient
          entry={entry}
          service={service}
          redirectUri={redirectUri}
          onDone={() => onEdit(false)}
        />
      )}
    </li>
  );
}

/** The service is fixed; the saved secret is kept unless a new one is typed over it. */
function EditOAuthClient({
  entry,
  service,
  redirectUri,
  onDone,
}: {
  readonly entry: HostedOAuthClient;
  readonly service: string;
  readonly redirectUri: string;
  readonly onDone: () => void;
}) {
  const organization = useOrganization();
  const { client, access } = entry;
  const update = useAtomSet(
    updateOAuthClientAtom({ organization: organization.organization, client: client.id }),
    { mode: "promiseExit" },
  );
  // The revision belongs to the draft, so a refresh cannot silently permit an overwrite.
  const [revision] = useState(access.revision);
  return (
    <OAuthClientForm
      label="Edit OAuth client"
      className="border-t pt-3"
      service={() => (
        <label className="field-label flex flex-col gap-2 text-[13px] font-medium">
          Service
          <Input value={service} disabled />
        </label>
      )}
      redirectUri={redirectUri}
      initial={{ clientId: client.clientId, audience: access.audience }}
      savedSecret={client.hasSecret}
      allowPrivate={access.creator !== null}
      privateLabel="Only the creator"
      hint="Accounts already connected keep the details they signed in with. Changes apply to new connections."
      submitLabel="Save"
      describeFailure={editConflict}
      save={({ clientId, clientSecret, audience }) =>
        update({
          ...(clientId === client.clientId ? {} : { clientId }),
          ...(clientSecret === undefined ? {} : { clientSecret }),
          audience,
          revision,
        })
      }
      onDone={onDone}
    />
  );
}

/**
 * Every edit is checked against the revision the form opened with, and nothing is saved when it
 * changed. The list reloads on failure, so editing again starts from the client as it is now.
 */
const editConflict = (cause: Cause.Cause<HostedError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: (error) =>
      error._tag === "AccessConflict" && error.reason === "changed"
        ? "This client changed while you were editing, so nothing was saved. Cancel, then edit it again to start from its current details."
        : undefined,
    onNone: () => undefined,
  });

/** Connecting without a client swaps to registering one for that sign-in's server, then returns. */
export function RegisterServiceClient({
  service,
  onDone,
}: {
  readonly service: OAuthClientService;
  readonly onDone: () => void;
}) {
  const organization = useOrganization();
  return (
    <QueryView
      query={oauthClientsAtom(organization.organization)}
      Failure={HostedFailure}
      pending={<DetailSkeleton label="Loading OAuth clients" />}
    >
      {(directory) => (
        <RegisterOAuthClient
          services={[
            directory.services.find((known) => known.issuer === service.issuer) ?? service,
          ]}
          redirectUri={directory.redirectUri}
          className=""
          onDone={onDone}
        />
      )}
    </QueryView>
  );
}

function RegisterOAuthClient({
  services,
  redirectUri,
  className = "mt-4",
  onDone,
}: {
  readonly services: OAuthClientDirectory["services"];
  readonly redirectUri: string;
  readonly className?: string;
  readonly onDone: () => void;
}) {
  const organization = useOrganization();
  const register = useAtomSet(registerOAuthClientAtom(organization.organization), {
    mode: "promiseExit",
  });
  const [issuer, setIssuer] = useState<typeof HttpUrl.Type | undefined>(
    services.length === 1 ? services[0]?.issuer : undefined,
  );
  const chosen = services.find((service) => service.issuer === issuer);
  return (
    <OAuthClientForm
      label="Register OAuth client"
      className={className}
      service={(pending) => (
        <label className="field-label flex flex-col gap-2 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
          Service
          <Select
            value={issuer ?? ""}
            disabled={pending}
            onValueChange={(value) =>
              setIssuer(services.find((option) => option.issuer === value)?.issuer)
            }
          >
            <SelectTrigger aria-label="Service">
              <SelectValue placeholder="Choose a service" />
            </SelectTrigger>
            <SelectContent>
              {services.map((option) => (
                <SelectItem key={option.issuer} value={option.issuer}>
                  {serviceName(option)}
                  <span className="text-muted-foreground"> · {issuerLabel(option.issuer)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {chosen !== undefined && (
            <span className="text-xs font-normal text-muted-foreground">
              Signs in at {issuerLabel(chosen.issuer)}. Every app that signs in there can use it
              {chosen.providers.length > 1 ? `: ${serviceName(chosen)}` : ""}.
            </span>
          )}
        </label>
      )}
      redirectUri={redirectUri}
      initial={{ clientId: "", audience: { kind: "everyone" } }}
      allowPrivate
      privateLabel="Only me"
      submitLabel="Register"
      save={issuer === undefined ? undefined : (values) => register({ issuer, ...values })}
      onDone={onDone}
    />
  );
}

const savedSecretMask = "\u2022".repeat(12);

type OAuthClientValues = {
  readonly clientId: string;
  readonly clientSecret?: Redacted.Redacted<string>;
  readonly audience: typeof AppAudience.Type;
};

/** Registering and editing share the client's details and audience; each supplies its service field. */
function OAuthClientForm({
  label,
  className,
  service,
  redirectUri,
  initial,
  savedSecret = false,
  allowPrivate,
  privateLabel,
  hint,
  submitLabel,
  save,
  describeFailure,
  onDone,
}: {
  readonly label: string;
  readonly className: string;
  readonly service: (pending: boolean) => ReactNode;
  readonly redirectUri: string;
  readonly initial: { readonly clientId: string; readonly audience: typeof AppAudience.Type };
  /** A secret is saved: the field shows it as filled, and sends nothing unless replaced. */
  readonly savedSecret?: boolean | undefined;
  readonly allowPrivate: boolean;
  readonly privateLabel: string;
  readonly hint?: string | undefined;
  readonly submitLabel: string;
  /** Absent until the form has everything its parent needs, such as a chosen service. */
  readonly save:
    | ((values: OAuthClientValues) => Promise<Exit.Exit<unknown, HostedError>>)
    | undefined;
  /** A message for a failure this form explains better than the shared one. */
  readonly describeFailure?: ((cause: Cause.Cause<HostedError>) => string | undefined) | undefined;
  readonly onDone: () => void;
}) {
  const organization = useOrganization();
  const [clientId, setClientId] = useState(initial.clientId);
  // A stand-in the password field masks, so a saved secret never looks blank. It is never sent.
  const [clientSecret, setClientSecret] = useState(savedSecret ? savedSecretMask : "");
  const [secretReplaced, setSecretReplaced] = useState(!savedSecret);
  const [audience, setAudience] = useState(initial.audience);
  const [audienceTouched, setAudienceTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const complete = save !== undefined && clientId.trim() !== "";
  const invalidAudience = audienceError(audience);
  return (
    <form
      aria-label={label}
      className={`flex flex-col gap-3 ${className}`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (save === undefined || !complete || pending) return;
        if (invalidAudience !== undefined) {
          setAudienceTouched(true);
          return;
        }
        setPending(true);
        setError(undefined);
        const result = await save({
          clientId: clientId.trim(),
          ...(secretReplaced && clientSecret.trim()
            ? { clientSecret: Redacted.make(clientSecret.trim()) }
            : {}),
          audience,
        });
        setPending(false);
        if (Exit.isFailure(result))
          setError(describeFailure?.(result.cause) ?? appError(result.cause));
        else {
          setClientSecret("");
          onDone();
        }
      }}
    >
      {service(pending)}
      <div className="flex flex-col gap-2 text-[13px] font-medium">
        <span>Redirect URL</span>
        <div className="flex items-start gap-3">
          <code className="min-w-0 flex-1 py-[3px] font-mono text-[12px] font-normal wrap-anywhere select-all">
            {redirectUri}
          </code>
          <CopyButton code={redirectUri} label="Copy redirect URL" inline />
        </div>
      </div>
      <label className="field-label flex flex-col gap-2 text-[13px] font-medium">
        Client ID
        <Input
          value={clientId}
          autoComplete="off"
          disabled={pending}
          onChange={(event) => setClientId(event.target.value)}
        />
      </label>
      <label className="field-label flex flex-col gap-2 text-[13px] font-medium">
        Client secret (optional)
        <Input
          type="password"
          value={clientSecret}
          autoComplete="off"
          disabled={pending}
          onFocus={(event) => {
            if (!secretReplaced) event.currentTarget.select();
          }}
          onChange={(event) => {
            setSecretReplaced(true);
            setClientSecret(event.target.value);
          }}
        />
      </label>
      <QueryView
        query={groupsAtom(organization.organization)}
        Failure={HostedFailure}
        pending={<DetailSkeleton label="Loading groups" />}
      >
        {(data) => (
          <AudienceInput
            mode="app"
            subject="this client"
            allowPrivate={allowPrivate}
            privateLabel={privateLabel}
            groups={data.groups}
            value={audience}
            disabled={pending}
            error={audienceTouched ? invalidAudience : undefined}
            onBlur={() => setAudienceTouched(true)}
            onChange={setAudience}
          />
        )}
      </QueryView>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={pending} disabled={!complete}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
