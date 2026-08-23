"use client";

/* eslint-disable react/forbid-elements -- blog widgets use bespoke styled
   controls; the product design-system <Button> does not model them. */

import { useState } from "react";
import { fmt } from "./shared";

/**
 * What the paper actually measured. Stage one shows Table 2 — median input
 * tokens per completed run for seven harnesses on the same GitHub task — and
 * asks the reader which runs had an MCP server attached. The reveal: none of
 * them; the 28x spread is pure harness overhead. Stage two shows Table 3 —
 * what happened when the MCP server *was* attached — where four of five
 * harnesses got cheaper.
 *
 * Data: arXiv 2608.08654, Tables 2 and 3 (median input tokens, completed runs).
 */

type Row = { readonly name: string; readonly tokens: number };

const TABLE2: ReadonlyArray<Row> = [
  { name: "pi", tokens: 14660 },
  { name: "Tau", tokens: 16459 },
  { name: "Codex", tokens: 82378 },
  { name: "Hermes", tokens: 83954 },
  { name: "opencode", tokens: 137800 },
  { name: "qwen-code", tokens: 297649 },
  { name: "Claude Code", tokens: 410797 },
];
const MAX2 = 410797;

type Paired = { readonly name: string; readonly ratio: number; readonly note?: string };

// Table 3: cost with MCP attached ÷ cost without, per harness.
const TABLE3: ReadonlyArray<Paired> = [
  { name: "Claude Code", ratio: 0.57 },
  { name: "qwen-code", ratio: 0.74 },
  { name: "Hermes", ratio: 0.84 },
  { name: "opencode", ratio: 0.95 },
  { name: "Codex", ratio: 16.09, note: "n=2" },
];

// Position on a log scale from 0.4x to 20x, so 1.0x sits at a fixed line and
// the Codex outlier stays on the chart without flattening everything else.
const logPos = (r: number) => {
  const min = Math.log(0.4);
  const max = Math.log(20);
  return ((Math.log(r) - min) / (max - min)) * 100;
};

type Stage = "guess" | "revealed" | "paired";

export function HarnessSpreadDemo() {
  const [stage, setStage] = useState<Stage>("guess");

  return (
    <div className="bw">
      <p className="sr-only" aria-live="polite">
        {stage === "guess"
          ? "Seven harnesses ran the same GitHub task. Median input tokens range from 14,660 to 410,797."
          : stage === "revealed"
            ? "Reveal: none of these runs had an MCP server attached. The 28x spread is harness overhead."
            : "With the MCP server attached, four of five harnesses got cheaper. Median paired ratio 0.93."}
      </p>

      {stage !== "paired" ? (
        <>
          <div className="bw-head">
            <span className="bw-eyebrow">Seven harnesses, one task, median input tokens</span>
          </div>
          <div className="bw-bars">
            {TABLE2.map((r) => (
              <div key={r.name} className="bw-bars__row">
                <span className="bw-bars__name">{r.name}</span>
                <div className="bw-bars__track">
                  <div
                    className="bw-bars__fill"
                    style={{ width: `${Math.max(2, (r.tokens / MAX2) * 100)}%` }}
                  />
                </div>
                <span className="bw-bars__val">{fmt(r.tokens)}</span>
              </div>
            ))}
          </div>
          {stage === "guess" ? (
            <div className="bw-quiz">
              <span>Which of these runs had an MCP server attached?</span>
              <button type="button" className="bw-btn" onClick={() => setStage("revealed")}>
                Reveal
              </button>
            </div>
          ) : (
            <div className="bw-quiz bw-quiz--answer">
              <span>
                <strong>None of them.</strong> No MCP server was attached to any run in this chart —
                the 28x spread between the cheapest and most expensive harness is pure harness
                overhead.
              </span>
              <button type="button" className="bw-btn" onClick={() => setStage("paired")}>
                So what happened when they attached it?
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="bw-head">
            <span className="bw-eyebrow">Cost with MCP attached ÷ cost without, per harness</span>
          </div>
          <div className="bw-ratio" style={{ "--one-x": `${logPos(1)}%` } as React.CSSProperties}>
            <div className="bw-ratio__row bw-ratio__row--axis" aria-hidden="true">
              <span className="bw-ratio__name" />
              <div className="bw-ratio__axis">
                <span style={{ left: `${logPos(0.5)}%` }}>0.5×</span>
                <span style={{ left: `${logPos(1)}%` }}>1×</span>
                <span style={{ left: `${logPos(2)}%` }}>2×</span>
                <span style={{ left: `${logPos(5)}%` }}>5×</span>
                <span style={{ left: `${logPos(16)}%` }}>16×</span>
              </div>
            </div>
            {TABLE3.map((p) => (
              <div key={p.name} className="bw-ratio__row">
                <span className="bw-ratio__name">
                  {p.name}{" "}
                  <span className="bw-ratio__val">
                    {p.ratio}×{p.note ? ` (${p.note})` : ""}
                  </span>
                </span>
                <div className="bw-ratio__track">
                  <span
                    className="bw-ratio__marker"
                    data-cheaper={p.ratio < 1 ? "true" : undefined}
                    style={{ left: `${logPos(p.ratio)}%` }}
                  />
                </div>
              </div>
            ))}
            <div className="bw-ratio__legend">
              <span>← cheaper with MCP</span>
              <span>more expensive with MCP →</span>
            </div>
          </div>
          <div className="bw-quiz bw-quiz--answer">
            <span>
              Four of five harnesses got <strong>cheaper</strong> with the MCP server attached.
              Across the thirteen strictly paired runs the median ratio is <strong>0.93</strong> —
              the authors call the comparison inconclusive.
            </span>
            <button type="button" className="bw-btn" onClick={() => setStage("guess")}>
              Back to the spread
            </button>
          </div>
        </>
      )}
    </div>
  );
}
