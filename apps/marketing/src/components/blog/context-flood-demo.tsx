"use client";

/* eslint-disable react/forbid-elements -- blog widgets use bespoke styled
   controls; the product design-system <Button> does not model them. */

import { useState } from "react";
import { fmt, useAnimatedNumber } from "./shared";

/**
 * The centerpiece: context cost is a 2×2, not a protocol property. One axis
 * picks the interface (CLI or MCP), the other picks the loading strategy
 * (on demand or everything up front). Flipping the interface barely moves the
 * number; flipping the loading strategy moves it ~20x.
 *
 * Figures are illustrative but anchored: the arXiv paper everyone cited
 * measured the official GitHub MCP server at 44 tools, eager clients resending
 * the whole catalog every request, and ~22k tokens for 27 built-in tool
 * schemas (~800 tokens per schema).
 */

type Interface_ = "cli" | "mcp";
type Loading = "lazy" | "eager";

const SYSTEM_TOK = 1200;

type Segment = { readonly label: string; readonly tok: number; readonly flood?: boolean };

const CELLS: Record<Interface_, Record<Loading, ReadonlyArray<Segment>>> = {
  cli: {
    lazy: [{ label: "one bash tool definition", tok: 320 }],
    eager: [
      { label: "one bash tool definition", tok: 320 },
      { label: "--help for every gh subcommand, inlined", tok: 29800, flood: true },
    ],
  },
  mcp: {
    lazy: [{ label: "gateway pair: search tools + invoke tool", tok: 640 }],
    eager: [{ label: "44 tool schemas × ~800 tokens", tok: 35200, flood: true }],
  },
};

const cellTotal = (i: Interface_, l: Loading) =>
  SYSTEM_TOK + CELLS[i][l].reduce((s, seg) => s + seg.tok, 0);

const MAX_TOTAL = Math.max(
  cellTotal("cli", "eager"),
  cellTotal("mcp", "eager"),
  cellTotal("cli", "lazy"),
  cellTotal("mcp", "lazy"),
);

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

  const segments: ReadonlyArray<Segment> = [
    { label: "system prompt", tok: SYSTEM_TOK },
    ...CELLS[iface][loading],
  ];
  const total = cellTotal(iface, loading);
  const totalDisplay = useAnimatedNumber(total);
  const flooding = segments.some((s) => s.flood);

  return (
    <div className="bw">
      <p className="sr-only" aria-live="polite">
        {iface === "cli" ? "CLI" : "MCP"} with tools loaded{" "}
        {loading === "lazy" ? "on demand" : "up front"}: about {fmt(total)} tokens spent before your
        first message.
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
        <div className="bw-flood__rows">
          {segments.map((s) => (
            <div key={s.label} className="bw-flood__row">
              <div className="bw-flood__meta">
                <span className="bw-flood__name">{s.label}</span>
                <span className="bw-flood__tok">~{fmt(s.tok)} tok</span>
              </div>
              <div className="bw-flood__track">
                <div
                  className="bw-flood__fill"
                  data-flood={s.flood ? "true" : undefined}
                  style={{ width: `${Math.max(1.5, (s.tok / MAX_TOTAL) * 100)}%` }}
                />
              </div>
            </div>
          ))}
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
              <span className="bw-map__label">
                {i === "cli" ? "CLI" : "MCP"} · {l === "lazy" ? "on demand" : "up front"}
              </span>
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
