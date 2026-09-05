"use client";

/* eslint-disable react/forbid-elements -- blog widgets use bespoke styled
   controls; the product design-system <Button> does not model them. */

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./shared";

/**
 * Compile an MCP server's tool catalog into a CLI. The left pane is the
 * GitHub MCP server's catalog (44 tools, per the official server); pressing
 * "Compile to CLI" builds the right pane subcommand-by-subcommand from the
 * same rows. Nothing about the tools changes — count, names, schemas, and
 * annotations all survive — which is the whole point.
 */

type Tool = {
  readonly slug: string;
  readonly cli: string;
  readonly help: string;
  readonly destructive?: boolean;
};

// A representative slice of the official GitHub MCP server's catalog.
const TOOLS: ReadonlyArray<Tool> = [
  { slug: "issues_create", cli: "issues create", help: "Create an issue" },
  { slug: "issues_list", cli: "issues list", help: "List issues" },
  { slug: "pulls_create", cli: "pulls create", help: "Open a pull request" },
  { slug: "pulls_merge", cli: "pulls merge", help: "Merge a pull request", destructive: true },
  { slug: "branches_create", cli: "branches create", help: "Create a branch" },
  { slug: "repos_get", cli: "repos get", help: "Get a repository" },
];
const REST = 38; // the rest of the 44-tool catalog

export function McpToCliDemo() {
  const [compiled, setCompiled] = useState(false);
  // How many rows of the CLI pane are visible; staggers up after compiling.
  const [built, setBuilt] = useState(0);
  const reduced = usePrefersReducedMotion();
  const timerRef = useRef<number | null>(null);

  const totalRows = TOOLS.length + 1; // + the "… 38 more" row

  useEffect(() => {
    if (!compiled) {
      setBuilt(0);
      return;
    }
    if (reduced) {
      setBuilt(totalRows);
      return;
    }
    let n = 0;
    timerRef.current = window.setInterval(() => {
      n += 1;
      setBuilt(n);
      if (n >= totalRows && timerRef.current) clearInterval(timerRef.current);
    }, 140);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [compiled, reduced, totalRows]);

  const done = built >= totalRows;

  return (
    <div className="bw">
      <p className="sr-only" aria-live="polite">
        {compiled
          ? "Compiled the 44-tool MCP server into a CLI with 44 subcommands. The tools are unchanged."
          : "An MCP server with 44 tools, not yet compiled to a CLI."}
      </p>
      <div className="bw-head">
        <span className="bw-eyebrow">The same catalog, twice</span>
        <button
          type="button"
          className="bw-btn"
          onClick={() => setCompiled((c) => !c)}
          aria-pressed={compiled}
        >
          {compiled ? "Reset" : "Compile to CLI"}
        </button>
      </div>

      <div className="bw-pair">
        <div className="bw-pane" data-dim={compiled && done ? "true" : undefined}>
          <div className="bw-pane__title">
            MCP server <span className="bw-mono-note">github · 44 tools</span>
          </div>
          <div className="bw-rows">
            {TOOLS.map((t) => (
              <div key={t.slug} className="bw-row">
                <span className="bw-row__name">{t.slug}</span>
                <span className="bw-row__desc">{t.help}</span>
                {t.destructive ? <span className="bw-tag">destructive</span> : null}
              </div>
            ))}
            <div className="bw-row bw-row--rest">… {REST} more</div>
          </div>
        </div>

        <div className="bw-pane__arrow" aria-hidden="true">
          →
        </div>

        <div className="bw-pane">
          <div className="bw-pane__title">
            Generated CLI{" "}
            <span className="bw-mono-note">{done ? "github · 44 commands" : "—"}</span>
          </div>
          <div className="code-window bw-window bw-window--fill">
            <div className="code-window__bar">
              <span className="code-window__dots">
                <i />
                <i />
                <i />
              </span>
            </div>
            <pre className="code-window__body bw-code bw-code--term">
              <code>
                <span className="bw-dim">{"$ "}</span>
                {"github --help\n"}
                {compiled ? (
                  <>
                    {"Commands:\n"}
                    {TOOLS.slice(0, Math.min(built, TOOLS.length)).map((t) => (
                      <span key={t.slug} className="bw-fade-in">
                        {"  "}
                        {t.cli.padEnd(17)}
                        <span className="bw-dim">{t.help}</span>
                        {t.destructive ? <span className="bw-dim"> [destructive]</span> : null}
                        {"\n"}
                      </span>
                    ))}
                    {built >= totalRows ? (
                      <span className="bw-fade-in bw-dim">{`  … ${REST} more\n`}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="bw-dim">{"\n(nothing here yet — press Compile to CLI)"}</span>
                )}
              </code>
            </pre>
          </div>
        </div>
      </div>

      <div className="bw-foot" aria-hidden={!done}>
        {done
          ? "44 tools in, 44 commands out. Names, schemas, descriptions, and the destructive flag all survived. The only thing that changed is how you invoke them."
          : " "}
      </div>
    </div>
  );
}
