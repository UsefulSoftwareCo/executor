import { useMemo, useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import {
  AuthTemplateSlug,
  IntegrationSlug,
  type AuthTemplateSlug as AuthTemplateSlugType,
  type Connection,
  type Owner,
} from "@executor-js/sdk/shared";
import {
  decodeGraphqlIntegrationConfigOption,
  type AuthTemplate,
  type GraphqlIntegrationConfig,
} from "@executor-js/plugin-graphql";
import { connectionsAllAtom, createConnection } from "@executor-js/react/api/atoms";
import { connectionWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  ConnectionOwnerDropdown,
  useConnectionOwner,
} from "@executor-js/react/plugins/connection-owner";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryField,
  CardStackEntryTitle,
} from "@executor-js/react/components/card-stack";
import { Input } from "@executor-js/react/components/input";

import { graphqlIntegrationConfigAtom } from "./atoms";
import { graphqlConnectionName } from "./defaults";
import GraphqlSignInButton from "./GraphqlSignInButton";

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);

const errorMessageFromExit = (exit: Exit.Exit<unknown, unknown>, fallback: string): string =>
  Option.match(Option.flatMap(Exit.findErrorOption(exit), decodeErrorMessage), {
    onNone: () => fallback,
    onSome: ({ message }) => message,
  });

const decodeIntegrationConfig = (value: unknown): GraphqlIntegrationConfig | null =>
  Option.getOrNull(decodeGraphqlIntegrationConfigOption(value));

const apiKeyTemplates = (config: GraphqlIntegrationConfig): readonly AuthTemplate[] =>
  config.authenticationTemplate.filter((t: AuthTemplate) => t.kind === "apiKey");

const oauthTemplates = (config: GraphqlIntegrationConfig): readonly AuthTemplate[] =>
  config.authenticationTemplate.filter((t: AuthTemplate) => t.kind === "oauth2");

// ---------------------------------------------------------------------------
// API-key connection creator — paste a value, pick an owner, save a connection.
// ---------------------------------------------------------------------------

function ApiKeyConnectionForm(props: {
  readonly slug: IntegrationSlug;
  readonly template: AuthTemplateSlugType;
  readonly displayName: string;
  readonly existing: readonly Connection[];
}) {
  const { connectionOwner, setConnectionOwner, connectionOwnerOptions } = useConnectionOwner();
  const doCreate = useAtomSet(createConnection, { mode: "promiseExit" });
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const existingForOwner = props.existing.find(
    (connection) => connection.owner === connectionOwner && connection.template === props.template,
  );

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);
    const exit = await doCreate({
      payload: {
        owner: connectionOwner,
        name: graphqlConnectionName(String(props.slug), connectionOwner),
        integration: props.slug,
        template: props.template,
        identityLabel: props.displayName,
        value: value.trim(),
      },
      reactivityKeys: connectionWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setError(errorMessageFromExit(exit, "Failed to save credential"));
      setSaving(false);
      return;
    }
    setValue("");
    setSaved(true);
    setSaving(false);
  };

  return (
    <CardStackEntryField label="API key">
      <div className="space-y-2">
        {existingForOwner && (
          <p className="text-xs text-muted-foreground">
            Connected as {existingForOwner.identityLabel ?? String(existingForOwner.name)}. Saving a
            new key replaces it.
          </p>
        )}
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue((e.target as HTMLInputElement).value)}
          placeholder="Bearer ghp_…"
          autoComplete="new-password"
          className="font-mono text-sm"
          data-ph-block
        />
        <ConnectionOwnerDropdown
          value={connectionOwner}
          options={connectionOwnerOptions}
          onChange={(owner: Owner) => {
            setConnectionOwner(owner);
            setSaved(false);
          }}
          label="Saved to"
          help="Choose who can use this credential."
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        {saved && <p className="text-xs text-emerald-600 dark:text-emerald-400">Saved</p>}
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void handleSave()} disabled={saving || !value.trim()}>
            {saving ? "Saving…" : "Save credential"}
          </Button>
        </div>
      </div>
    </CardStackEntryField>
  );
}

// ---------------------------------------------------------------------------
// Edit form — v2: `sourceId` is the integration slug. The integration's
// endpoint + auth templates come from its stored config (read-only here); the
// form lets the user create owner-scoped connections for each template.
// ---------------------------------------------------------------------------

function EditForm(props: {
  readonly slug: IntegrationSlug;
  readonly config: GraphqlIntegrationConfig;
}) {
  // Connections across BOTH owners (omit-owner read); the form lists each
  // account regardless of owner. Creating one is an explicit owner choice via
  // the credential-scope dropdown below.
  const connectionsResult = useAtomValue(connectionsAllAtom);

  const connections = useMemo<readonly Connection[]>(() => {
    const all = AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : [];
    return all.filter((connection: Connection) => connection.integration === props.slug);
  }, [connectionsResult, props.slug]);

  const apiKey = apiKeyTemplates(props.config);
  const oauth = oauthTemplates(props.config);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">GraphQL Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage credentials for this GraphQL integration.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">{props.config.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {props.config.endpoint}
          </p>
        </div>
        <Badge variant="secondary" className="text-xs">
          GraphQL
        </Badge>
      </div>

      {props.config.authenticationTemplate.length === 0 ? (
        <CardStack>
          <CardStackContent className="border-t-0">
            <CardStackEntry>
              <CardStackEntryContent>
                <CardStackEntryDescription>
                  This integration does not require authentication.
                </CardStackEntryDescription>
              </CardStackEntryContent>
            </CardStackEntry>
          </CardStackContent>
        </CardStack>
      ) : (
        <CardStack>
          <CardStackContent className="border-t-0">
            <CardStackEntry>
              <CardStackEntryContent>
                <CardStackEntryTitle>Credentials</CardStackEntryTitle>
                <CardStackEntryDescription>
                  A connection is the credential. Save one per owner (Personal or Workspace).
                </CardStackEntryDescription>
              </CardStackEntryContent>
            </CardStackEntry>

            {apiKey.map((template: AuthTemplate) => (
              <ApiKeyConnectionForm
                key={template.slug}
                slug={props.slug}
                template={AuthTemplateSlug.make(template.slug)}
                displayName={props.config.name}
                existing={connections}
              />
            ))}

            {oauth.map((template: AuthTemplate) => (
              <CardStackEntryField key={template.slug} label="OAuth sign-in">
                <GraphqlSignInButton
                  slug={props.slug}
                  template={AuthTemplateSlug.make(template.slug)}
                  displayName={props.config.name}
                  existing={connections}
                />
              </CardStackEntryField>
            ))}
          </CardStackContent>
        </CardStack>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export default function EditGraphqlSource(props: {
  readonly sourceId: string;
  readonly onSave: () => void;
}) {
  const slug = IntegrationSlug.make(props.sourceId);
  const configResult = useAtomValue(graphqlIntegrationConfigAtom(slug));
  const config = AsyncResult.isSuccess(configResult)
    ? decodeIntegrationConfig(configResult.value)
    : null;

  if (!AsyncResult.isSuccess(configResult) || !config) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold text-foreground">GraphQL Source</h1>
        <p className="text-sm text-muted-foreground">Loading configuration…</p>
      </div>
    );
  }

  return <EditForm slug={slug} config={config} />;
}
