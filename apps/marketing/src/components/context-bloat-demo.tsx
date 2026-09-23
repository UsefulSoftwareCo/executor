"use client";

/* eslint-disable react/forbid-elements -- this marketing demo's service toggles
   are bespoke styled controls (icon + name + tool count + checkbox); the product
   design-system <Button> does not model that layout. */

import React, { useEffect, useRef, useState } from "react";

// Brand logos are imported so Vite emits them as hashed build assets (served
// from /_astro/...) instead of relying on /public, which the deploy pipeline
// does not pick up for newly added files.
import githubLogo from "../assets/logos/github.svg?url";
import stripeLogo from "../assets/logos/stripe.svg?url";
import jiraLogo from "../assets/logos/jira.svg?url";
import sentryLogo from "../assets/logos/sentry.svg?url";
import linearLogo from "../assets/logos/linear.svg?url";
import gmailLogo from "../assets/logos/gmail.svg?url";
import notionLogo from "../assets/logos/notion.svg?url";
import slackLogo from "../assets/logos/slack.svg?url";

const LOGOS: Record<string, string> = {
  github: githubLogo,
  stripe: stripeLogo,
  jira: jiraLogo,
  sentry: sentryLogo,
  linear: linearLogo,
  gmail: gmailLogo,
  notion: notionLogo,
  slack: slackLogo,
};

/**
 * Interactive "no context bloat" demo, laid out like Effect's "Production-grade
 * TypeScript" section: a complexity gauge + service checklist on top, then two
 * code windows below. Check services to connect them. The naive side grows a
 * system prompt that lists every tool name, ballooning into the thousands (tall
 * + scrollable); the Executor side stays at one `execute` tool with a short,
 * fixed description. Figures are illustrative; the shape is accurate.
 */

type Integration = {
  readonly slug: string;
  readonly name: string;
  readonly tools: number;
  readonly naiveTok: number;
  readonly toolNames: ReadonlyArray<string>;
  readonly summary: string;
};

// Each integration imports its whole API surface as tools (OpenAPI ops, MCP
// tools, GraphQL fields), so a handful already stacks into the thousands.
// naiveTok ~= tools * 170 (one tool definition with its JSON schema).
const INTEGRATIONS: ReadonlyArray<Integration> = [
  {
    slug: "github",
    name: "GitHub",
    tools: 720,
    naiveTok: 122400,
    toolNames: [
      "createIssue",
      "listPullRequests",
      "mergePullRequest",
      "createRelease",
      "addLabels",
      "createBranch",
      "getCommit",
    ],
    summary: "Production GitHub",
  },
  {
    slug: "stripe",
    name: "Stripe",
    tools: 510,
    naiveTok: 86700,
    toolNames: [
      "createCharge",
      "createCustomer",
      "createRefund",
      "listInvoices",
      "createSubscription",
      "capturePaymentIntent",
      "listPayouts",
    ],
    summary: "Live Stripe account",
  },
  {
    slug: "jira",
    name: "Jira",
    tools: 240,
    naiveTok: 40800,
    toolNames: [
      "createIssue",
      "transitionIssue",
      "addComment",
      "assignIssue",
      "listSprints",
      "createProject",
      "searchIssues",
    ],
    summary: "Team Jira",
  },
  {
    slug: "sentry",
    name: "Sentry",
    tools: 170,
    naiveTok: 28900,
    toolNames: [
      "listIssues",
      "resolveIssue",
      "listEvents",
      "getProject",
      "muteIssue",
      "createRelease",
      "listAlerts",
    ],
    summary: "Production Sentry",
  },
  {
    slug: "linear",
    name: "Linear",
    tools: 130,
    naiveTok: 22100,
    toolNames: [
      "createIssue",
      "updateIssue",
      "listProjects",
      "createComment",
      "archiveIssue",
      "listTeams",
      "createLabel",
    ],
    summary: "Linear workspace",
  },
  {
    slug: "gmail",
    name: "Gmail",
    tools: 95,
    naiveTok: 16150,
    toolNames: [
      "sendMessage",
      "listThreads",
      "createDraft",
      "addLabel",
      "trashMessage",
      "listMessages",
      "modifyMessage",
    ],
    summary: "Support inbox",
  },
  {
    slug: "notion",
    name: "Notion",
    tools: 80,
    naiveTok: 13600,
    toolNames: [
      "queryDatabase",
      "createPage",
      "updateBlock",
      "appendChildren",
      "search",
      "retrievePage",
      "listUsers",
    ],
    summary: "Internal Notion",
  },
  {
    slug: "slack",
    name: "Slack",
    tools: 70,
    naiveTok: 11900,
    toolNames: [
      "postMessage",
      "listChannels",
      "createChannel",
      "inviteToChannel",
      "uploadFile",
      "listUsers",
      "setTopic",
    ],
    summary: "Team Slack",
  },
];

// The execute tool's description is a fixed preamble (workflow + rules) plus one
// short prefix line per connected integration. It stays flat as you add
// integrations, no matter how many tools each one carries.
const EXECUTOR_BASE = 980; // fixed workflow + rules preamble, served once
const EXECUTOR_PER = 16; // one connection-prefix line per integration
const NAIVE_MAX = INTEGRATIONS.reduce((s, i) => s + i.naiveTok, 0); // bar scale

const fmt = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

/** Eases a displayed integer toward `target` with requestAnimationFrame. */
function useAnimatedNumber(target: number): number {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced) {
      // oxlint-disable-next-line react/set-state-in-effect -- skip the animation when motion is reduced
      setDisplay(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    const start = performance.now();
    const dur = 450;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (target - from) * eased));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      fromRef.current = target;
    };
  }, [target, reduced]);

  return display;
}

// Full-color svgl.app brand marks, rendered as <img> so each keeps its own
// colors. svgl has no Jira icon, so jira.svg is the Jira mark in Jira blue.
function IntegrationIcon({ slug }: { readonly slug: string }) {
  const src = LOGOS[slug];
  if (!src) return null;
  return <img src={src} alt="" width={15} height={15} loading="lazy" className="object-contain" />;
}

function CheckMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      width="11"
      height="11"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function TokenBar({
  pct,
  variant,
}: {
  readonly pct: number;
  readonly variant: "naive" | "executor";
}) {
  return (
    <div
      className={`cbloat-bar cbloat-bar-- h-1.5 w-full bg-rule rounded-[3px] overflow-hidden${variant}`}
      aria-hidden="true"
    >
      <div
        className="cbloat-bar__fill h-full min-w-0.75 rounded-[3px] [transition:width_0.45s_cubic-bezier(0.22,_1,_0.36,_1)] [.cbloat-bar--naive_&]:[background:rgba(13,_13,_16,_0.4)] [.cbloat-bar--executor_&]:bg-accent [@media(prefers-reduced-motion:_reduce)]:[transition:none]"
        style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
      />
    </div>
  );
}

export function ContextBloatDemo() {
  const [active, setActive] = useState<ReadonlyArray<string>>([
    "github",
    "stripe",
    "jira",
    "sentry",
  ]);
  const isOn = (slug: string) => active.includes(slug);
  const toggle = (slug: string) =>
    setActive((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));

  const activeIntegrations = INTEGRATIONS.filter((i) => isOn(i.slug));
  const naiveTok = activeIntegrations.reduce((s, i) => s + i.naiveTok, 0);
  const naiveTools = activeIntegrations.reduce((s, i) => s + i.tools, 0);
  const executorTok = EXECUTOR_BASE + active.length * EXECUTOR_PER;

  const naiveDisplay = useAnimatedNumber(naiveTok);
  const executorDisplay = useAnimatedNumber(executorTok);
  const naiveToolsDisplay = useAnimatedNumber(naiveTools);

  const naivePct = (naiveTok / NAIVE_MAX) * 100;
  const executorPct = (executorTok / NAIVE_MAX) * 100;

  return (
    <div className="cbloat flex flex-col gap-[2rem]">
      <p className="sr-only" aria-live="polite">
        Without Executor: {fmt(naiveTools)} tools, about {fmt(naiveTok)} tokens. With Executor: 1
        tool, about {fmt(executorTok)} tokens.
      </p>

      <div className="cbloat-top grid grid-cols-[1fr] gap-[2rem] min-[880px]:grid-cols-[0.82fr_1fr] min-[880px]:gap-[3rem] min-[880px]:items-start">
        {/* Complexity gauge */}
        <div className="cbloat-gauge">
          <div className="cbloat-gauge__title text-[13px] font-semibold text-ink">
            Context window
          </div>
          <div className="cbloat-gauge__sub text-[12px] [color:var(--color-ink-3)] mb-[1.4rem]">
            Lower is better
          </div>
          <div className="cbloat-gauge__row mb-[1.1rem]">
            <div className="cbloat-gauge__line flex items-center gap-[0.5rem] text-[12.5px] mb-[0.45rem]">
              <span className="cbloat-dot cbloat-dot--naive w-2 h-2 rounded-[2px] shrink-0 [background:rgba(13,_13,_16,_0.4)]" />
              <span className="cbloat-gauge__name [color:var(--color-ink-2)] font-medium">
                Without Executor
              </span>
              <span className="cbloat-gauge__val ml-auto font-mono text-[11px] [color:var(--color-ink-3)] whitespace-nowrap">
                {fmt(naiveToolsDisplay)} tools &middot; ~{fmt(naiveDisplay)} tok
              </span>
            </div>
            <TokenBar pct={naivePct} variant="naive" />
          </div>
          <div className="cbloat-gauge__row mb-[1.1rem]">
            <div className="cbloat-gauge__line flex items-center gap-[0.5rem] text-[12.5px] mb-[0.45rem]">
              <span className="cbloat-dot cbloat-dot--exec w-2 h-2 rounded-[2px] shrink-0 bg-accent" />
              <span className="cbloat-gauge__name [color:var(--color-ink-2)] font-medium">
                With Executor
              </span>
              <span className="cbloat-gauge__val ml-auto font-mono text-[11px] [color:var(--color-ink-3)] whitespace-nowrap">
                1 tool &middot; ~{fmt(executorDisplay)} tok
              </span>
            </div>
            <TokenBar pct={executorPct} variant="executor" />
          </div>
        </div>

        {/* Service checklist */}
        <div
          className="cbloat-checklist grid grid-cols-2 gap-[0.5rem]"
          role="group"
          aria-label="Connect services"
        >
          {INTEGRATIONS.map((i) => (
            <button
              key={i.slug}
              type="button"
              className="cbloat-check flex items-center gap-[0.6rem] py-[0.58rem] px-[0.72rem] border border-rule rounded-[10px] bg-white cursor-pointer text-left [transition:border-color_0.15s_ease,_background_0.15s_ease] hover:border-rule-strong hover:bg-surface [&[data-on='true']]:[border-color:rgba(99,_91,_255,_0.4)] [&[data-on='true']]:[background:color-mix(in_srgb,_var(--color-accent)_5%,_white)] focus-visible:[outline:2px_solid_var(--color-accent)] focus-visible:outline-offset-[2px]"
              data-on={isOn(i.slug) ? "true" : undefined}
              aria-pressed={isOn(i.slug)}
              onClick={() => toggle(i.slug)}
            >
              <span
                className="cbloat-check__box w-4.5 h-4.5 rounded-[6px] shrink-0 [border:1.5px_solid_var(--color-rule-strong)] inline-flex items-center justify-center text-white [transition:background_0.15s_ease,_border-color_0.15s_ease] [.cbloat-check[data-on='true']_&]:bg-accent [.cbloat-check[data-on='true']_&]:border-accent"
                aria-hidden="true"
              >
                {isOn(i.slug) ? <CheckMark /> : null}
              </span>
              <span className="cbloat-check__icon inline-flex w-3.75 h-3.75 shrink-0 [color:var(--color-ink-2)]">
                <IntegrationIcon slug={i.slug} />
              </span>
              <span className="cbloat-check__name flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-medium text-ink">
                {i.name}
              </span>
              <span className="cbloat-check__count font-mono text-[10.5px] [color:var(--color-ink-3)] whitespace-nowrap">
                {fmt(i.tools)} tools
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="cbloat-grid grid grid-cols-[1fr] gap-[1.25rem] min-[880px]:grid-cols-[1fr_1fr]">
        {/* Without Executor: a system prompt that lists every tool, scrollable */}
        <div className="cbloat-col flex flex-col min-w-0">
          <div className="cbloat-col__title text-center text-[15px] font-semibold tracking-[-0.01em] text-ink mb-[0.75rem]">
            Without Executor
          </div>
          <div className="code-window cbloat-panel cbloat-panel--naive bg-white border border-rule rounded-[14px] overflow-hidden [box-shadow:0_1px_2px_rgba(13,_13,_16,_0.03),_0_18px_40px_-28px_rgba(13,_13,_16,_0.14)] flex flex-col min-w-0">
            <div className="code-window__bar flex items-center gap-[0.7rem] py-[0.7rem] px-[1rem] border-b border-b-rule [background:color-mix(in_srgb,_var(--color-surface-2)_55%,_white)]">
              <span className="code-window__dots inline-flex gap-1.5 [&_i]:w-2.5 [&_i]:h-2.5 [&_i]:rounded-[999px] [&_i]:bg-rule-strong">
                <i />
                <i />
                <i />
              </span>
              <span className="cbloat-panel__count ml-auto font-mono text-[11.5px] [color:var(--color-ink-3)] whitespace-nowrap">
                <span className="cbloat-num [.cbloat-panel--naive_&]:text-ink [.cbloat-panel--naive_&]:font-semibold [.cbloat-panel--executor_&]:text-accent [.cbloat-panel--executor_&]:font-semibold">
                  {fmt(naiveToolsDisplay)}
                </span>{" "}
                tools &middot; ~{fmt(naiveDisplay)} tok
              </span>
            </div>
            <pre className="code-window__body cbloat-body cbloat-body--scroll m-0 py-[1.25rem] px-[1.4rem] font-mono text-ink overflow-x-auto [tab-size:2] [&_code]:[font-family:inherit] text-[12.5px] leading-[1.7] whitespace-pre-wrap [word-break:break-word] h-110 overflow-y-auto">
              <code>
                <span className="tok-s text-[#2f7d52]">{'"You are a helpful assistant.'}</span>
                {"\n\n"}
                {"Your tools are:"}
                {"\n\n"}
                {activeIntegrations.length === 0 ? (
                  <span className="tok-c [color:var(--color-ink-3)]">
                    {"(none yet, check a service)"}
                  </span>
                ) : null}
                {activeIntegrations.map((i) => (
                  <React.Fragment key={i.slug}>
                    {i.toolNames.map((n) => (
                      <React.Fragment key={n}>
                        <span className="tok-a text-accent font-semibold">{n}</span>
                        <span className="tok-p [color:var(--color-ink-3)]">()</span>
                        {"\n"}
                      </React.Fragment>
                    ))}
                    <span className="tok-c [color:var(--color-ink-3)]">{`// + ${fmt(i.tools - i.toolNames.length)} more ${i.name} tools`}</span>
                    {"\n"}
                  </React.Fragment>
                ))}
                {activeIntegrations.length > 0 ? (
                  <span className="tok-s text-[#2f7d52]">{'..."'}</span>
                ) : null}
              </code>
            </pre>
          </div>
        </div>

        {/* With Executor: one tool, the same trimmed description */}
        <div className="cbloat-col flex flex-col min-w-0">
          <div className="cbloat-col__title text-center text-[15px] font-semibold tracking-[-0.01em] text-ink mb-[0.75rem]">
            With Executor
          </div>
          <div className="code-window cbloat-panel cbloat-panel--executor bg-white border border-rule rounded-[14px] overflow-hidden [box-shadow:0_1px_2px_rgba(13,_13,_16,_0.03),_0_18px_40px_-28px_rgba(13,_13,_16,_0.14)] flex flex-col min-w-0">
            <div className="code-window__bar flex items-center gap-[0.7rem] py-[0.7rem] px-[1rem] border-b border-b-rule [background:color-mix(in_srgb,_var(--color-surface-2)_55%,_white)]">
              <span className="code-window__dots inline-flex gap-1.5 [&_i]:w-2.5 [&_i]:h-2.5 [&_i]:rounded-[999px] [&_i]:bg-rule-strong">
                <i />
                <i />
                <i />
              </span>
              <span className="cbloat-panel__count ml-auto font-mono text-[11.5px] [color:var(--color-ink-3)] whitespace-nowrap">
                1 tool &middot; ~
                <span className="cbloat-num [.cbloat-panel--naive_&]:text-ink [.cbloat-panel--naive_&]:font-semibold [.cbloat-panel--executor_&]:text-accent [.cbloat-panel--executor_&]:font-semibold">
                  {fmt(executorDisplay)}
                </span>{" "}
                tok
              </span>
            </div>
            <pre className="code-window__body cbloat-body cbloat-body--scroll m-0 py-[1.25rem] px-[1.4rem] font-mono text-ink overflow-x-auto [tab-size:2] [&_code]:[font-family:inherit] text-[12.5px] leading-[1.7] whitespace-pre-wrap [word-break:break-word] h-110 overflow-y-auto">
              <code>
                <span className="tok-c [color:var(--color-ink-3)]">
                  {'// the only tool your client sees: "execute"'}
                </span>
                {"\n\n"}
                {
                  "Execute TypeScript in a sandboxed runtime with access to\nconfigured API tools.\n\n"
                }
                <span className="tok-f text-ink font-semibold">{"## Workflow"}</span>
                {"\n\n"}
                {"1. const { items } = await tools.search({ query });\n"}
                {"2. const path = items[0]?.path;\n"}
                {"3. const details = await tools.describe.tool({ path });\n"}
                {"4. const result = await tools[path](input);\n\n"}
                <span className="tok-f text-ink font-semibold">
                  {"## Available connection prefixes"}
                </span>
                {"\n\n"}
                {activeIntegrations.length === 0 ? (
                  <span className="tok-c [color:var(--color-ink-3)]">
                    {"(connect a service to add a prefix)"}
                  </span>
                ) : null}
                {activeIntegrations.map((i) => (
                  <span key={i.slug} className="cbloat-line block">
                    <span className="tok-p [color:var(--color-ink-3)]">{"- "}</span>
                    <span className="tok-a text-accent font-semibold">{`${i.slug}.org.main`}</span>
                    <span className="tok-p [color:var(--color-ink-3)]">{": "}</span>
                    <span className="tok-c [color:var(--color-ink-3)]">{i.summary}</span>
                    {"\n"}
                  </span>
                ))}
              </code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
