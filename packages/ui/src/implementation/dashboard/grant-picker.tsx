import { EmptyState } from "./empty-state.tsx";
import { useId, useState, type ReactNode } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { AppId, Tool } from "@executor-js/sdk";
import type { GrantPolicy } from "@executor-js/mcp-auth/grants";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import { RadioGroup } from "radix-ui";
import { Checkbox } from "../components/checkbox.tsx";
import { Button } from "../components/button.tsx";
import { SearchInput } from "./common.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";

/** A consent form needs at least one usable selection, or explicit all-app access. */
export const hasGrantSelection = (policy: GrantPolicy) =>
  policy.kind === "all" ||
  policy.apps.some(({ tools }) => tools.kind === "all" || tools.names.length > 0);

/** Both hosts display the same permissions; each host supplies its authorized catalog and navigation. */
export function GrantPicker<E>({
  policy,
  onChange,
  apps,
  tools,
  disabled = false,
  emptyAction,
}: {
  policy: GrantPolicy;
  onChange: (policy: GrantPolicy) => void;
  apps: readonly { id: AppId; name: string }[];
  tools: (app: AppId) => Atom.Atom<AsyncResult.AsyncResult<readonly Tool[], E>>;
  disabled?: boolean;
  emptyAction?: ReactNode;
}) {
  const approvalsId = useId();
  return (
    <div className="grant-picker flex flex-col gap-4">
      <div className="grant-section-heading [&_h2]:text-[14px] [&_h2]:font-semibold [&_h2]:[margin:0_0_4px] [&_p]:text-muted-foreground [&_p]:text-[12px] [&_p]:leading-[1.6] [&_p]:m-0">
        <h2>Access</h2>
        <p>Choose what this connection can do.</p>
      </div>
      <RadioGroup.Root
        className="grant-access-options grid grid-cols-2 gap-2.5 max-[480px]:grid-cols-[1fr]"
        aria-label="Connection access"
        value={policy.kind}
        disabled={disabled}
        onValueChange={(kind) => {
          if (kind === "all") onChange({ kind: "all" });
          else if (kind === "tools") onChange({ kind: "tools", apps: [], approval: "browser" });
        }}
      >
        <RadioGroup.Item
          value="tools"
          className="grant-access-option flex items-start gap-2.5 border border-border rounded-[9px] p-[14px] text-left cursor-pointer [transition:background_0.15s,_border-color_0.15s] hover:bg-muted [&[data-state='checked']]:border-foreground [&[data-state='checked']]:[background:color-mix(in_srgb,_var(--foreground)_4%,_transparent)] focus-visible:[outline:2px_solid_var(--ring)] focus-visible:outline-offset-[3px] disabled:opacity-50 disabled:cursor-default [&_strong]:block [&_strong]:text-[13px] [&_strong]:leading-[18px] [&_strong]:[font-weight:550] [&_small]:block [&_small]:mt-1 [&_small]:text-[11px] [&_small]:leading-[16px] [&_small]:text-muted-foreground max-[480px]:p-[12px]"
        >
          <span className="grant-radio flex-none w-3.5 h-3.5 border border-muted-foreground rounded-[50%] grid [place-items:center] mt-0.5">
            <RadioGroup.Indicator className="grant-radio-dot w-1.5 h-1.5 rounded-[50%] bg-foreground" />
          </span>
          <span>
            <strong>Use selected apps</strong>
            <small>Choose apps and tools below.</small>
          </span>
        </RadioGroup.Item>
        <RadioGroup.Item
          value="all"
          className="grant-access-option flex items-start gap-2.5 border border-border rounded-[9px] p-[14px] text-left cursor-pointer [transition:background_0.15s,_border-color_0.15s] hover:bg-muted [&[data-state='checked']]:border-foreground [&[data-state='checked']]:[background:color-mix(in_srgb,_var(--foreground)_4%,_transparent)] focus-visible:[outline:2px_solid_var(--ring)] focus-visible:outline-offset-[3px] disabled:opacity-50 disabled:cursor-default [&_strong]:block [&_strong]:text-[13px] [&_strong]:leading-[18px] [&_strong]:[font-weight:550] [&_small]:block [&_small]:mt-1 [&_small]:text-[11px] [&_small]:leading-[16px] [&_small]:text-muted-foreground max-[480px]:p-[12px]"
        >
          <span className="grant-radio flex-none w-3.5 h-3.5 border border-muted-foreground rounded-[50%] grid [place-items:center] mt-0.5">
            <RadioGroup.Indicator className="grant-radio-dot w-1.5 h-1.5 rounded-[50%] bg-foreground" />
          </span>
          <span>
            <strong>Use all apps</strong>
            <small>All apps available to your account.</small>
          </span>
        </RadioGroup.Item>
      </RadioGroup.Root>
      {policy.kind === "all" ? (
        <p className="grant-admin-note text-muted-foreground text-[12px] leading-[1.6] m-0">
          This connection can use all apps available to your account.
        </p>
      ) : (
        <>
          {apps.length === 0 ? (
            <EmptyState size="compact" title="No apps to connect yet" action={emptyAction}>
              Install an app to choose its tools, or select Use all apps to let this client set up
              apps.
            </EmptyState>
          ) : (
            <>
              <div className="grant-apps flex flex-col gap-3">
                {apps.map((app) => {
                  const selected = policy.apps.find((item) => item.app === app.id);
                  const change = (selection: typeof selected) =>
                    onChange({
                      ...policy,
                      apps: [
                        ...policy.apps.filter((item) => item.app !== app.id),
                        ...(selection === undefined ? [] : [selection]),
                      ],
                    });
                  return (
                    <section
                      key={app.id}
                      className="grant-app border border-border rounded-[10px] overflow-hidden min-w-0"
                      aria-label={app.name}
                    >
                      <div className="grant-app-heading flex items-center justify-between gap-4 p-[16px] max-[480px]:p-[12px] max-[480px]:gap-2">
                        <div className="grant-app-title flex flex-col gap-1 min-w-0 [&_strong]:text-[14px] [&_strong]:font-semibold [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_>_span]:text-[11px] [&_>_span]:text-muted-foreground">
                          <strong>{app.name}</strong>
                          <span>
                            {selected?.tools.kind === "all"
                              ? "All current and future tools"
                              : selected?.tools.kind === "selected"
                                ? `${selected.tools.names.length} tools selected`
                                : "Not connected"}
                          </span>
                        </div>
                        <Select
                          disabled={disabled}
                          value={selected?.tools.kind ?? "none"}
                          onValueChange={(value) => {
                            if (value === "none") change(undefined);
                            else if (value === "all")
                              change({ app: app.id, tools: { kind: "all" } });
                            else if (value === "selected")
                              change({ app: app.id, tools: { kind: "selected", names: [] } });
                          }}
                        >
                          <SelectTrigger
                            aria-label={`Access to ${app.name}`}
                            className="grant-app-select min-w-35 flex-none text-[12px] max-[740px]:text-[12px] max-[480px]:min-w-30"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No access</SelectItem>
                            <SelectItem value="all">All tools</SelectItem>
                            <SelectItem value="selected">Choose tools</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {selected?.tools.kind === "selected" && (
                        <ToolSelection
                          appName={app.name}
                          tools={tools(app.id)}
                          names={selected.tools.names}
                          disabled={disabled}
                          onChange={(names) =>
                            change({ app: app.id, tools: { kind: "selected", names } })
                          }
                        />
                      )}
                    </section>
                  );
                })}
              </div>
              <p className="grant-footnote text-muted-foreground text-[12px] leading-[1.6] m-0">
                Tools use the app’s connected accounts. All tools includes tools added later.
              </p>
              <div className="grant-approval-setting [&_p]:text-muted-foreground [&_p]:text-[12px] [&_p]:leading-[1.6] [&_p]:m-0 grid gap-2 pt-2 [&_>_label]:text-[13px] [&_>_label]:[font-weight:550] [&_[data-slot='select-trigger']]:w-full">
                <label htmlFor={approvalsId}>Approval permissions</label>
                <Select
                  disabled={disabled}
                  value={policy.approval}
                  onValueChange={(value) => {
                    if (value === "browser" || value === "client")
                      onChange({ ...policy, approval: value });
                  }}
                >
                  <SelectTrigger id={approvalsId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="browser">Require approval in Executor</SelectItem>
                    <SelectItem value="client">Allow this client to approve</SelectItem>
                  </SelectContent>
                </Select>
                <p>
                  {policy.approval === "browser"
                    ? "Calls that need approval wait for you in the Executor browser."
                    : "This client can answer approval requests, including through native prompts."}
                </p>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ToolSelection<E>({
  appName,
  tools,
  names,
  onChange,
  disabled,
}: {
  appName: string;
  tools: Atom.Atom<AsyncResult.AsyncResult<readonly Tool[], E>>;
  names: readonly Tool["name"][];
  onChange: (names: readonly Tool["name"][]) => void;
  disabled: boolean;
}) {
  const groupId = useId();
  const state = useAtomValue(tools);
  const refresh = useAtomRefresh(tools);
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(60);
  if (AsyncResult.isFailure(state))
    return (
      <EmptyState
        size="compact"
        icon={null}
        role="alert"
        title="Tools could not be loaded"
        action={
          <Button type="button" variant="outline" size="sm" onClick={refresh}>
            Try again
          </Button>
        }
      >
        Check the app’s connected accounts.
      </EmptyState>
    );
  if (!AsyncResult.isSuccess(state))
    return (
      <div
        className="grant-empty py-[24px] px-[16px] text-muted-foreground text-center text-[13px] leading-[1.6] [&_strong]:text-foreground [&_strong]:[font-weight:550] [&_p]:[margin:6px_0_12px]"
        role="status"
      >
        Loading tools…
      </div>
    );
  const selected = new Set(names);
  const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = state.value.filter((tool) =>
    terms.every((term) => `${tool.name} ${tool.description}`.toLowerCase().includes(term)),
  );
  const visible = filtered.slice(0, shown);
  return (
    <div className="grant-tool-picker border-t border-t-border">
      <div className="grant-tool-search [padding:12px_12px_0] [&_.search-input]:w-full [&_.search-input]:max-w-none [&_.search-input_input]:text-[12px] [&_.search-input_input]:h-8.5">
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value);
            setShown(60);
          }}
          placeholder={`Search ${appName} tools…`}
        />
      </div>
      <div className="grant-tool-toolbar flex items-center justify-between gap-2 py-[8px] px-[12px] text-[11px] text-muted-foreground [&_>_div]:flex [&_>_div]:gap-0.5 [&_button]:text-[11px] [&_button]:h-6.5 [&_button]:py-0 [&_button]:px-[7px] max-[480px]:flex-wrap">
        <span aria-live="polite">
          {names.length} selected <span aria-hidden>·</span>{" "}
          {terms.length ? `${filtered.length} matches` : `${state.value.length} tools`}
        </span>
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || names.length === 0}
            onClick={() => onChange([])}
          >
            Clear
          </Button>
        </div>
      </div>
      <div
        className="grant-tool-list max-h-74 overflow-y-auto [overscroll-behavior:contain] [scrollbar-gutter:stable] border-t border-t-border"
        role="group"
        aria-label={`${appName} tools`}
      >
        {state.value.length === 0 ? (
          <EmptyState size="compact" icon={null} title="No tools yet">
            This app has no tools yet.
          </EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState size="compact" icon={null} title="No matching tools">
            No tools match “{search}”.
          </EmptyState>
        ) : (
          visible.map((tool) => (
            <div
              key={tool.name}
              className="grant-tool-row flex items-center gap-2.75 py-0 px-[14px] min-h-12 [border-bottom:1px_solid_color-mix(in_srgb,_var(--border)_65%,_transparent)] last:border-b-0 hover:[background:color-mix(in_srgb,_var(--foreground)_4%,_transparent)] [&[data-selected='true']]:[background:color-mix(in_srgb,_var(--foreground)_4%,_transparent)] focus-within:bg-muted [&_label]:flex-1 [&_label]:min-w-0 [&_label]:flex [&_label]:flex-col [&_label]:justify-center [&_label]:py-[9px] [&_label]:px-0 [&_label]:cursor-pointer [&_code]:block [&_code]:text-[11px] [&_code]:leading-[17px] [&_code]:overflow-hidden [&_code]:text-ellipsis [&_code]:whitespace-nowrap [&_label_>_span]:block [&_label_>_span]:text-[11px] [&_label_>_span]:leading-[16px] [&_label_>_span]:text-muted-foreground [&_label_>_span]:overflow-hidden [&_label_>_span]:text-ellipsis [&_label_>_span]:whitespace-nowrap"
              data-selected={selected.has(tool.name)}
            >
              <Checkbox
                id={`${groupId}-${encodeURIComponent(tool.name)}`}
                aria-label={tool.name}
                disabled={disabled}
                checked={selected.has(tool.name)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...names, tool.name]
                      : names.filter((name) => name !== tool.name),
                  )
                }
              />
              <label htmlFor={`${groupId}-${encodeURIComponent(tool.name)}`}>
                <code>{tool.name}</code>
                {tool.description && (
                  <span title={tool.description}>{tool.description.split("\n")[0]}</span>
                )}
              </label>
            </div>
          ))
        )}
        {filtered.length > shown && (
          <div className="grant-tool-more flex justify-center p-[8px]">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShown(shown + 60)}>
              Show {Math.min(60, filtered.length - shown)} more tools
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
