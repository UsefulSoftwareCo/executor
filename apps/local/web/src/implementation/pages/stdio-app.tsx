import type { DashboardError } from "../../contracts/errors.ts";
import { useAtomSet } from "@effect/atom-react";
import { StdioAppInput } from "@executor-js/catalog/contracts";
import { Exit, Option, Schema, type Cause } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { importCustomAppAtom } from "../../contracts/onboarding.ts";
import { Failure } from "../components/common.tsx";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { Textarea } from "@executor-js/ui/components/textarea";
import { useNavigate } from "@tanstack/react-router";

/** Generate a local MCP app; environment values are collected later through account setup. */
export function StdioAppForm() {
  const navigate = useNavigate();
  const add = useAtomSet(importCustomAppAtom, { mode: "promiseExit" });
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [environment, setEnvironment] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [failure, setFailure] = useState<Cause.Cause<DashboardError>>();
  return (
    <form
      className="setup-form custom-app-form max-w-145 flex flex-col gap-5.75 max-[740px]:gap-5.25 pt-7"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        setError(undefined);
        setFailure(undefined);
        const source = Schema.decodeUnknownOption(StdioAppInput)({
          kind: "mcp-stdio",
          name: name.trim(),
          command: command.trim(),
          args: args.split(/\r?\n/).filter((line) => line.length > 0),
          ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
          environment: environment
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        });
        if (Option.isNone(source)) {
          setError(
            "Enter a name and executable. Use unique environment variable names, one per line, without values.",
          );
          return;
        }
        setPending(true);
        void add({ payload: { source: source.value } }).then((exit) => {
          setPending(false);
          if (Exit.isFailure(exit)) {
            setFailure(exit.cause);
            return;
          }

          void navigate({
            to: Object.keys(exit.value.requirements.accounts).length
              ? "/apps/$appId/setup"
              : "/apps/$appId",
            params: { appId: exit.value.id },
          });
        });
      }}
    >
      <fieldset disabled={pending} className="custom-app-fields flex flex-col gap-5.75 min-w-0">
        <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
          App name
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="My local MCP"
            required
            maxLength={120}
          />
        </label>
        <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
          Command
          <Input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="npx"
            required
            autoCapitalize="none"
            spellCheck={false}
          />
          <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
            An executable on this computer, such as npx, uvx, or an absolute path.
          </span>
        </label>
        <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
          Arguments{" "}
          <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
            One per line
          </span>
          <Textarea
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path/to/folder"}
            rows={4}
            autoCapitalize="none"
            spellCheck={false}
          />
          <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
            Arguments are passed directly. Paths with spaces need no quotes.
          </span>
        </label>
        <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
          Working directory{" "}
          <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
            Optional
          </span>
          <Input
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="/path/to/project"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
          Environment variables{" "}
          <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
            Optional · names only, one per line
          </span>
          <Textarea
            value={environment}
            onChange={(event) => setEnvironment(event.target.value)}
            placeholder={"API_KEY\nREGION"}
            rows={2}
            autoCapitalize="none"
            spellCheck={false}
          />
          <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
            You’ll save the values as an account after adding the app.
          </span>
        </label>
      </fieldset>
      {error && (
        <p className="custom-app-error text-destructive text-[13px] leading-[1.5]" role="alert">
          {error}
        </p>
      )}
      {failure && <Failure cause={failure} />}
      <div className="form-actions flex items-center gap-5 pt-1 text-[13px] [&_a]:text-muted-foreground max-[740px]:[&_>_a]:min-h-11 max-[740px]:[&_>_a]:inline-flex max-[740px]:[&_>_a]:items-center max-[740px]:flex-wrap max-[740px]:gap-[12px_20px]">
        <Button type="submit" loading={pending}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden size={14} />
          Add app
        </Button>
      </div>
    </form>
  );
}
