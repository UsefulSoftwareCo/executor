import { AsyncResult } from "effect/unstable/reactivity";
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

/**
 * Add a remote MCP server by URL. Executor confirms whether it needs no sign-in or supports
 * OAuth; anything else, and every other kind of service, is set up with the user's agent.
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
            kind: "mcp",
            name: name.trim(),
            url: url.trim(),
          });
          if (Option.isNone(input)) {
            setError("Check the app name and server URL, then try again.");
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
            MCP server URL
            <Input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/mcp"
              required
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5]">
            Executor checks whether this server needs no sign-in or supports OAuth.
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
            {pending ? "Checking server…" : "Add app"}
          </Button>
        </div>
      </form>
      <AgentSetupPrompt
        title="Any other service"
        description="For OpenAPI, GraphQL, API keys, local tools, or anything else, send this prompt to your agent. It reads the service’s documentation and asks how you sign in."
        prompt={agentSetupPrompt(undefined, endpoint)}
      />
    </div>
  );
}
