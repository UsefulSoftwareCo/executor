import { AsyncResult } from "effect/reactivity";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { CustomAppInput, ImportUrl } from "@executor-js/catalog/contracts";
import type { DeployedApp } from "@executor-js/sdk";
import { Exit, Option, Schema } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import type { MutationProps } from "../../contracts/dashboard.ts";
import { AgentSetupPrompt, agentSetupPrompt } from "./agent-setup.tsx";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";

/**
 * Import public protocol configuration; credentials stay in the account connection flow.
 */
export function CustomAppForm<E>({
  mutation,
  Failure,
  onInstalled,
  endpoint,
}: MutationProps<CustomAppInput, DeployedApp, E> & {
  readonly onInstalled: (app: DeployedApp) => void | Promise<void>;
  /** This installation's MCP URL, included so an unconnected agent can connect first. */
  readonly endpoint?: string;
}) {
  const result = useAtomValue(mutation);
  const add = useAtomSet(mutation, { mode: "promiseExit" });
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<CustomAppInput["kind"]>("mcp");
  const [baseUrl, setBaseUrl] = useState("");
  const [auth, setAuth] = useState("none");
  const [header, setHeader] = useState("X-API-Key");
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div className="flex flex-col gap-10 pt-7">
      <form
        className="setup-form custom-app-form max-w-145 flex flex-col gap-5.75 max-[740px]:gap-5.25"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          setError(undefined);
          if (!Schema.is(ImportUrl)(url.trim())) {
            setError(
              "Use an HTTP or HTTPS URL without credentials, query parameters, or fragments.",
            );
            return;
          }
          const input = Schema.decodeUnknownOption(CustomAppInput)({
            kind,
            name: name.trim(),
            url: url.trim(),
            ...(kind === "openapi" && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
            ...(kind === "graphql" && auth !== "none"
              ? {
                  auth:
                    auth === "bearer"
                      ? { kind: "bearer" }
                      : { kind: "apiKey", header: header.trim() },
                }
              : {}),
          });
          if (Option.isNone(input)) {
            setError("Check the app name, URL, and API settings, then try again.");
            return;
          }
          setPending(true);
          setSubmitted(true);
          void add(input.value).then((exit) => {
            setPending(false);
            if (Exit.isSuccess(exit)) void onInstalled(exit.value);
          });
        }}
      >
        <fieldset disabled={pending} className="custom-app-fields flex flex-col gap-5.75 min-w-0">
          <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium">
            Service type
            <Select
              value={kind}
              disabled={pending}
              onValueChange={(value) => {
                if (value === "mcp" || value === "openapi" || value === "graphql") {
                  setKind(value);
                  setError(undefined);
                  setSubmitted(false);
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mcp">MCP server</SelectItem>
                <SelectItem value="openapi">OpenAPI</SelectItem>
                <SelectItem value="graphql">GraphQL</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium">
            App name
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="My app"
              required
              maxLength={120}
            />
          </label>
          <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium">
            {kind === "mcp"
              ? "MCP server URL"
              : kind === "openapi"
                ? "OpenAPI definition URL"
                : "GraphQL endpoint URL"}
            <Input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={
                kind === "mcp"
                  ? "https://example.com/mcp"
                  : kind === "openapi"
                    ? "https://example.com/openapi.json"
                    : "https://example.com/graphql"
              }
              required
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          {kind === "openapi" && (
            <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium">
              API base URL (optional)
              <Input
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="Use the definition's server"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
          )}
          {kind === "graphql" && (
            <>
              <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium">
                Authentication
                <Select value={auth} disabled={pending} onValueChange={setAuth}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No authentication</SelectItem>
                    <SelectItem value="bearer">Bearer token</SelectItem>
                    <SelectItem value="apiKey">API key header</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              {auth === "apiKey" && (
                <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium">
                  API key header name
                  <Input
                    value={header}
                    onChange={(event) => setHeader(event.target.value)}
                    required
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </label>
              )}
            </>
          )}
          <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5]">
            {kind === "mcp"
              ? "Executor checks whether this server needs no sign-in or supports OAuth."
              : kind === "openapi"
                ? "Use a public JSON or YAML definition. Authentication comes from the definition; connect an account after adding the app."
                : "Connect credentials after adding the app. Protected schemas are read after an account is connected."}
          </span>
        </fieldset>
        {error && (
          <p className="custom-app-error text-destructive text-[13px] leading-[1.5]" role="alert">
            {error}
          </p>
        )}
        {submitted && AsyncResult.isFailure(result) && <Failure cause={result.cause} />}
        <div className="form-actions flex items-center gap-5 pt-1 text-[13px] max-[480px]:[&_>_button]:basis-full">
          <Button disabled={pending} type="submit">
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden size={14} />
            {pending ? "Adding app…" : "Add app"}
          </Button>
        </div>
      </form>
      <AgentSetupPrompt
        title="Any other service"
        description="For private definitions, custom authentication, local tools, or anything else, send this prompt to your agent. It reads the service’s documentation and asks how you sign in."
        prompt={agentSetupPrompt(endpoint)}
      />
    </div>
  );
}
