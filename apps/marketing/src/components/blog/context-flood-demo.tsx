"use client";

/* eslint-disable react/forbid-elements -- blog widgets use bespoke styled
   controls; the product design-system <Button> does not model them. */

import React, { useState } from "react";
import { fmt, useAnimatedNumber } from "./shared";

/**
 * The centerpiece: context cost is a 2×2, not a protocol property. One axis
 * picks the interface (CLI or MCP), the other picks the loading strategy
 * (on demand or everything up front). The code window shows what the model
 * actually receives in each cell — the eager cells physically overflow with
 * definitions. Flipping the interface barely moves the number; flipping the
 * loading strategy moves it ~20x.
 *
 * Figures are illustrative: the official GitHub MCP server's 44-tool catalog
 * at roughly 800 tokens per tool schema, resent every request by eager
 * clients.
 */

type Interface_ = "cli" | "mcp";
type Loading = "lazy" | "eager";

const SYSTEM_TOK = 1200;

// The 44-tool catalog rendered in the "MCP · everything up front" cell.
const GH_TOOLS: ReadonlyArray<{ readonly name: string; readonly args: string }> = [
  { name: "create_issue", args: '"owner", "repo", "title", "body", "labels"' },
  { name: "get_issue", args: '"owner", "repo", "issue_number"' },
  { name: "list_issues", args: '"owner", "repo", "state", "labels", "since"' },
  { name: "update_issue", args: '"owner", "repo", "issue_number", "title", "state"' },
  { name: "add_issue_comment", args: '"owner", "repo", "issue_number", "body"' },
  { name: "get_issue_comments", args: '"owner", "repo", "issue_number"' },
  { name: "create_pull_request", args: '"owner", "repo", "title", "head", "base"' },
  { name: "get_pull_request", args: '"owner", "repo", "pull_number"' },
  { name: "list_pull_requests", args: '"owner", "repo", "state", "base"' },
  { name: "merge_pull_request", args: '"owner", "repo", "pull_number", "merge_method"' },
  { name: "get_pull_request_diff", args: '"owner", "repo", "pull_number"' },
  { name: "get_pull_request_files", args: '"owner", "repo", "pull_number"' },
  { name: "create_pull_request_review", args: '"owner", "repo", "pull_number", "event"' },
  { name: "get_pull_request_reviews", args: '"owner", "repo", "pull_number"' },
  { name: "update_pull_request_branch", args: '"owner", "repo", "pull_number"' },
  { name: "create_branch", args: '"owner", "repo", "branch", "from_branch"' },
  { name: "list_branches", args: '"owner", "repo"' },
  { name: "list_commits", args: '"owner", "repo", "sha", "path"' },
  { name: "get_commit", args: '"owner", "repo", "sha"' },
  { name: "get_file_contents", args: '"owner", "repo", "path", "ref"' },
  { name: "create_or_update_file", args: '"owner", "repo", "path", "content", "message"' },
  { name: "delete_file", args: '"owner", "repo", "path", "message"' },
  { name: "push_files", args: '"owner", "repo", "branch", "files", "message"' },
  { name: "create_repository", args: '"name", "description", "private"' },
  { name: "fork_repository", args: '"owner", "repo", "organization"' },
  { name: "search_repositories", args: '"query", "sort", "order"' },
  { name: "search_code", args: '"query", "sort", "order"' },
  { name: "search_issues", args: '"query", "sort", "order"' },
  { name: "search_pull_requests", args: '"query", "sort", "order"' },
  { name: "search_users", args: '"query", "sort", "order"' },
  { name: "list_tags", args: '"owner", "repo"' },
  { name: "get_tag", args: '"owner", "repo", "tag"' },
  { name: "list_releases", args: '"owner", "repo"' },
  { name: "get_latest_release", args: '"owner", "repo"' },
  { name: "list_workflows", args: '"owner", "repo"' },
  { name: "run_workflow", args: '"owner", "repo", "workflow_id", "ref", "inputs"' },
  { name: "get_workflow_run", args: '"owner", "repo", "run_id"' },
  { name: "list_workflow_runs", args: '"owner", "repo", "workflow_id", "status"' },
  { name: "cancel_workflow_run", args: '"owner", "repo", "run_id"' },
  { name: "get_workflow_run_logs", args: '"owner", "repo", "run_id"' },
  { name: "list_notifications", args: '"filter", "since", "before"' },
  { name: "dismiss_notification", args: '"thread_id"' },
  { name: "get_me", args: "" },
  { name: "list_gists", args: '"username", "since"' },
];

// Help pages inlined in the "CLI · everything up front" cell.
const GH_HELP: ReadonlyArray<{ readonly cmd: string; readonly flags: string }> = [
  { cmd: "gh issue create", flags: "--assignee, --body, --label, --milestone, --project, --title" },
  { cmd: "gh issue list", flags: "--assignee, --author, --label, --limit, --state, --web" },
  { cmd: "gh issue view", flags: "--comments, --json, --web" },
  { cmd: "gh issue close", flags: "--comment, --reason" },
  { cmd: "gh pr create", flags: "--base, --draft, --fill, --head, --reviewer, --title" },
  { cmd: "gh pr list", flags: "--author, --base, --draft, --label, --limit, --state" },
  { cmd: "gh pr view", flags: "--comments, --json, --web" },
  { cmd: "gh pr merge", flags: "--auto, --delete-branch, --merge, --rebase, --squash" },
  { cmd: "gh pr checkout", flags: "--branch, --detach, --force" },
  { cmd: "gh pr diff", flags: "--color, --name-only, --patch" },
  { cmd: "gh repo create", flags: "--clone, --description, --private, --public, --template" },
  { cmd: "gh repo clone", flags: "--upstream-remote-name" },
  { cmd: "gh repo fork", flags: "--clone, --org, --remote" },
  { cmd: "gh repo view", flags: "--branch, --json, --web" },
  { cmd: "gh release create", flags: "--draft, --generate-notes, --notes, --prerelease, --title" },
  { cmd: "gh release list", flags: "--exclude-drafts, --limit" },
  { cmd: "gh run list", flags: "--branch, --json, --limit, --status, --workflow" },
  { cmd: "gh run view", flags: "--job, --log, --verbose, --web" },
  { cmd: "gh run cancel", flags: "" },
  { cmd: "gh workflow run", flags: "--field, --json, --ref" },
  { cmd: "gh search repos", flags: "--language, --limit, --owner, --sort, --stars" },
  { cmd: "gh search code", flags: "--extension, --filename, --language, --limit, --repo" },
  { cmd: "gh api", flags: "--field, --header, --jq, --method, --paginate" },
];

const CELL_TOK: Record<Interface_, Record<Loading, number>> = {
  cli: { lazy: 320, eager: 30100 },
  mcp: { lazy: 640, eager: 35200 },
};

const cellTotal = (i: Interface_, l: Loading) => SYSTEM_TOK + CELL_TOK[i][l];

function Dim({ children }: { readonly children: React.ReactNode }) {
  return <span className="bw-dim">{children}</span>;
}

function CliLazyBody() {
  return (
    <>
      {"{\n"}
      {'  "name": "bash",\n'}
      {'  "description": "Run a command in the shell",\n'}
      {'  "input_schema": { "command": "string" }\n'}
      {"}\n\n"}
      <Dim>
        {"// that's the entire catalog. gh's surface area\n"}
        {"// stays on disk — the model runs `gh --help`\n"}
        {"// for the two commands it needs, when it needs them.\n"}
      </Dim>
    </>
  );
}

function CliEagerBody() {
  return (
    <>
      {"{\n"}
      {'  "name": "bash",\n'}
      {'  "description": "Run a command in the shell",\n'}
      {'  "input_schema": { "command": "string" }\n'}
      {"}\n\n"}
      <Dim>{"// plus the help for every subcommand, inlined:\n\n"}</Dim>
      {GH_HELP.map((h) => (
        <React.Fragment key={h.cmd}>
          <Dim>{"$ "}</Dim>
          {h.cmd}
          {" --help\n"}
          <Dim>{`    ${h.flags}\n`}</Dim>
        </React.Fragment>
      ))}
      <Dim>{"\n… help for ~100 more subcommands, every request\n"}</Dim>
    </>
  );
}

function McpLazyBody() {
  return (
    <>
      {"{\n"}
      {'  "name": "search_tools",\n'}
      {'  "description": "Find tools across the connected catalogs",\n'}
      {'  "input_schema": { "query": "string" }\n'}
      {"}\n"}
      {"{\n"}
      {'  "name": "invoke_tool",\n'}
      {'  "description": "Call a tool by name with arguments",\n'}
      {'  "input_schema": { "name": "string", "arguments": "object" }\n'}
      {"}\n\n"}
      <Dim>
        {"// the other 42 GitHub tool descriptions stay on the\n"}
        {"// server — fetched only when the model asks for them.\n"}
      </Dim>
    </>
  );
}

function McpEagerBody() {
  return (
    <>
      {GH_TOOLS.map((t) => (
        <React.Fragment key={t.name}>
          {'{ "name": "'}
          {t.name}
          {'",\n'}
          <Dim>{'  "description": "…",\n'}</Dim>
          {'  "input_schema": { '}
          <Dim>{t.args}</Dim>
          {" } }\n"}
        </React.Fragment>
      ))}
      <Dim>{"\n// all 44 schemas, resent with every single request\n"}</Dim>
    </>
  );
}

const CELL_BODY: Record<Interface_, Record<Loading, () => React.ReactNode>> = {
  cli: { lazy: CliLazyBody, eager: CliEagerBody },
  mcp: { lazy: McpLazyBody, eager: McpEagerBody },
};

const cellName = (i: Interface_, l: Loading) =>
  `${i === "cli" ? "CLI" : "MCP"} · ${l === "lazy" ? "on demand" : "up front"}`;

function Seg({
  value,
  onPick,
  options,
  label,
}: {
  readonly value: string;
  readonly onPick: (v: string) => void;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly label: string;
}) {
  return (
    <div className="bw-axis">
      <span className="bw-axis__label">{label}</span>
      <div className="bw-seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className="bw-seg__btn"
            data-on={value === o.id ? "true" : undefined}
            aria-pressed={value === o.id}
            onClick={() => onPick(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ContextFloodDemo() {
  const [iface, setIface] = useState<Interface_>("mcp");
  const [loading, setLoading] = useState<Loading>("eager");

  const toolTok = CELL_TOK[iface][loading];
  const total = cellTotal(iface, loading);
  const totalDisplay = useAnimatedNumber(total);
  const flooding = loading === "eager";
  const Body = CELL_BODY[iface][loading];

  return (
    <div className="bw">
      <p className="sr-only" aria-live="polite">
        {cellName(iface, loading)}: about {fmt(total)} tokens spent before your first message.
      </p>

      <div className="bw-head bw-head--stack">
        <Seg
          label="Interface"
          value={iface}
          onPick={(v) => setIface(v as Interface_)}
          options={[
            { id: "cli", label: "CLI" },
            { id: "mcp", label: "MCP server" },
          ]}
        />
        <Seg
          label="Tool loading"
          value={loading}
          onPick={(v) => setLoading(v as Loading)}
          options={[
            { id: "lazy", label: "On demand" },
            { id: "eager", label: "Everything up front" },
          ]}
        />
      </div>

      <div className="bw-flood">
        <div className="code-window bw-window bw-flood__win">
          <div className="code-window__bar">
            <span className="code-window__dots">
              <i />
              <i />
              <i />
            </span>
            <span className="bw-mono-note">{cellName(iface, loading)} · what the model sees</span>
          </div>
          <pre className="code-window__body bw-code bw-flood__scroll">
            <code>
              <Dim>
                {"// system prompt — ~"}
                {fmt(SYSTEM_TOK)}
                {" tok\n"}
                {"You are a helpful assistant. Rules, tone, safety —\n"}
                {"the fixed part of every request.\n\n"}
                {"// tool definitions — ~"}
                {fmt(toolTok)}
                {" tok\n"}
              </Dim>
              <Body />
            </code>
          </pre>
        </div>
        <div className="bw-flood__total">
          <div className="bw-flood__num">~{fmt(totalDisplay)}</div>
          <div className="bw-flood__cap">tokens before your first message</div>
          <div className="bw-badge" data-show={flooding ? "true" : undefined}>
            resent with every request
          </div>
        </div>
      </div>

      <div className="bw-map" role="group" aria-label="All four combinations">
        {(["cli", "mcp"] as const).flatMap((i) =>
          (["lazy", "eager"] as const).map((l) => (
            <button
              key={`${i}-${l}`}
              type="button"
              className="bw-map__cell"
              data-on={i === iface && l === loading ? "true" : undefined}
              onClick={() => {
                setIface(i);
                setLoading(l);
              }}
            >
              <span className="bw-map__label">{cellName(i, l)}</span>
              <span className="bw-map__val">~{fmt(cellTotal(i, l))}</span>
            </button>
          )),
        )}
      </div>

      <div className="bw-foot">
        Flip the interface: the number barely moves. Flip the loading strategy: ~20x. The bloat
        lives on one axis, and it is not the protocol axis.
      </div>
    </div>
  );
}
