import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  ApiKeyHeader,
  RemoteCustomAppInput,
  ImportUrl,
  type ImportAuth,
} from "@executor-js/catalog/contracts";
import type { App } from "@executor-js/sdk";
import { Exit, Option, Schema } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import type { MutationProps } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";

/** Remote protocol choices supported by the custom source form. */
export const CustomAppKind = Schema.Literals(["mcp", "graphql", "openapi"]);
const Auth = Schema.Literals(["auto", "none", "apiKey", "oauth"]);
const fields = {
  mcp: { label: "Server URL", placeholder: "https://example.com/mcp" },
  graphql: { label: "GraphQL endpoint", placeholder: "https://api.example.com/graphql" },
  openapi: { label: "OpenAPI definition URL", placeholder: "https://api.example.com/openapi.json" },
};

/** Remote source form shared by products; the host owns installation and follow-up navigation. */
export function CustomAppForm<E>(
  props: MutationProps<RemoteCustomAppInput, App, E> & {
    readonly kind: typeof CustomAppKind.Type;
    readonly onInstalled: (app: App) => void | Promise<void>;
  },
) {
  return <RemoteAppForm {...props} input={(source) => source} />;
}

/** Editable remote settings shared by catalog and custom imports; callers own the command. */
export function RemoteAppForm<Command, E>({
  kind,
  mutation,
  Failure,
  onInstalled,
  initial,
  input: command,
}: MutationProps<Command, App, E> & {
  readonly kind: typeof CustomAppKind.Type;
  readonly initial?: { readonly name: string; readonly url: string; readonly auth: ImportAuth };
  readonly input: (source: RemoteCustomAppInput) => Command;
  readonly onInstalled: (app: App) => void | Promise<void>;
}) {
  const result = useAtomValue(mutation);
  const add = useAtomSet(mutation, { mode: "promiseExit" });
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [baseUrl, setBaseUrl] = useState("");
  const [auth, setAuth] = useState<typeof Auth.Type>(
    initial?.auth.type ?? (kind === "mcp" ? "auto" : "none"),
  );
  const [header, setHeader] = useState(
    initial?.auth.type === "apiKey" ? initial.auth.header : "Authorization",
  );
  const [prefix, setPrefix] = useState(
    initial?.auth.type === "apiKey" ? initial.auth.prefix : "Bearer ",
  );
  const [authorizationUrl, setAuthorizationUrl] = useState(
    initial?.auth.type === "oauth" ? initial.auth.authorizationUrl : "",
  );
  const [tokenUrl, setTokenUrl] = useState(
    initial?.auth.type === "oauth" ? initial.auth.tokenUrl : "",
  );
  const [scopes, setScopes] = useState(
    initial?.auth.type === "oauth" ? initial.auth.scopes.join(" ") : "",
  );
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <form
      className="setup-form custom-app-form max-w-145 flex flex-col gap-5.75 max-[740px]:gap-5.25 pt-7"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        setError(undefined);
        const urls = [
          url,
          ...(kind === "openapi" && baseUrl.trim() ? [baseUrl] : []),
          ...(kind === "graphql" && auth === "oauth" ? [authorizationUrl, tokenUrl] : []),
        ];
        if (urls.some((value) => !Schema.is(ImportUrl)(value.trim()))) {
          setError(
            "Use HTTP or HTTPS URLs without credentials, query parameters, or fragments. Connect credentials after adding the app.",
          );
          return;
        }
        if (kind !== "openapi" && auth === "apiKey" && !Schema.is(ApiKeyHeader)(header.trim())) {
          setError("Enter a valid authentication header, such as Authorization or X-API-Key.");
          return;
        }
        const input = Schema.decodeUnknownOption(RemoteCustomAppInput)({
          kind,
          name: name.trim(),
          url: url.trim(),
          ...(kind === "openapi"
            ? baseUrl.trim()
              ? { baseUrl: baseUrl.trim() }
              : {}
            : {
                auth:
                  auth === "apiKey"
                    ? { type: "apiKey", header: header.trim(), prefix }
                    : auth === "oauth"
                      ? kind === "mcp"
                        ? { type: "discoverOAuth" }
                        : {
                            type: "oauth",
                            authorizationUrl: authorizationUrl.trim(),
                            tokenUrl: tokenUrl.trim(),
                            scopes: scopes.split(/\s+/).filter(Boolean),
                          }
                      : { type: auth },
              }),
        });
        if (Option.isNone(input)) {
          setError("Check the app name and authentication settings, then try again.");
          return;
        }
        setPending(true);
        setSubmitted(true);
        void add(command(input.value)).then((exit) => {
          setPending(false);
          if (Exit.isSuccess(exit)) {
            void onInstalled(exit.value);
          }
        });
      }}
    >
      <fieldset disabled={pending} className="custom-app-fields flex flex-col gap-5.75 min-w-0">
        <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
          App name
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="My app"
            required
            maxLength={120}
          />
        </label>
        <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
          {fields[kind].label}
          <Input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={fields[kind].placeholder}
            required
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        {kind === "openapi" ? (
          <>
            <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
              API base URL{" "}
              <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
                Optional · uses the definition’s server by default
              </span>
              <Input
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.example.com"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
              Authentication comes from the API definition.
            </span>
          </>
        ) : (
          <>
            <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
              Authentication
              <Select
                value={auth}
                onValueChange={(value) => {
                  const parsed = Schema.decodeUnknownOption(Auth)(value);
                  if (Option.isSome(parsed)) setAuth(parsed.value);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {kind === "mcp" && <SelectItem value="auto">Choose during setup</SelectItem>}
                  <SelectItem value="none">No authentication</SelectItem>
                  <SelectItem value="apiKey">API key</SelectItem>
                  <SelectItem value="oauth">OAuth</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {kind === "mcp" && auth === "auto" && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Add the app first, then choose how to connect. OAuth settings are checked during
                account setup.
              </p>
            )}
            {auth === "apiKey" && (
              <>
                <div className="custom-app-row grid grid-cols-[minmax(0,_2fr)_minmax(0,_1fr)] gap-4">
                  <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
                    Header name
                    <Input
                      value={header}
                      onChange={(event) => setHeader(event.target.value)}
                      required
                      placeholder="Authorization"
                      spellCheck={false}
                    />
                  </label>
                  <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
                    Prefix
                    <Input
                      value={prefix}
                      onChange={(event) => setPrefix(event.target.value)}
                      placeholder="None"
                      spellCheck={false}
                    />
                  </label>
                </div>
                <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
                  You’ll enter the API key when connecting an account.
                </span>
              </>
            )}
            {kind === "graphql" && auth === "oauth" && (
              <>
                <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
                  Authorization URL
                  <Input
                    type="url"
                    value={authorizationUrl}
                    onChange={(event) => setAuthorizationUrl(event.target.value)}
                    required
                    placeholder="https://example.com/oauth/authorize"
                  />
                </label>
                <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
                  Token URL
                  <Input
                    type="url"
                    value={tokenUrl}
                    onChange={(event) => setTokenUrl(event.target.value)}
                    required
                    placeholder="https://example.com/oauth/token"
                  />
                </label>
                <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
                  Scopes
                  <Input
                    value={scopes}
                    onChange={(event) => setScopes(event.target.value)}
                    placeholder="Space-separated scopes"
                  />
                </label>
              </>
            )}
          </>
        )}
      </fieldset>
      {error && (
        <p className="custom-app-error text-destructive text-[13px] leading-[1.5]" role="alert">
          {error}
        </p>
      )}
      {submitted && AsyncResult.isFailure(result) && <Failure cause={result.cause} />}
      <div className="form-actions flex items-center gap-5 pt-1 text-[13px] [&_a]:text-muted-foreground max-[740px]:[&_>_a]:min-h-11 max-[740px]:[&_>_a]:inline-flex max-[740px]:[&_>_a]:items-center max-[740px]:flex-wrap max-[740px]:gap-[12px_20px] max-[480px]:[&_>_button]:basis-full">
        <Button disabled={pending} type="submit">
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden size={14} />
          {pending ? "Creating app…" : "Add app"}
        </Button>
      </div>
    </form>
  );
}
