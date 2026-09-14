"use client";

/* eslint-disable react/forbid-elements -- blog widgets use bespoke styled
   controls; the product design-system <Button> does not model them. */

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./shared";

/**
 * Adding a new capability mid-session, three ways. Press Play and the lanes
 * advance a step at a time: a CLI is usable immediately, a typical MCP client
 * makes you restart (and lose the session), and a client that implements
 * dynamic loading matches the CLI experience. Deterministic — every reader
 * sees the same run. Under reduced motion all steps render at once.
 */

type Step = { readonly text: string; readonly bad?: boolean; readonly done?: boolean };

type Lane = {
  readonly id: string;
  readonly title: string;
  readonly sub: string;
  readonly steps: ReadonlyArray<Step>;
};

const LANES: ReadonlyArray<Lane> = [
  {
    id: "cli",
    title: "CLI",
    sub: "any harness with bash",
    steps: [{ text: "$ bun add -g @linear/cli" }, { text: "$ linear issue list", done: true }],
  },
  {
    id: "mcp-typical",
    title: "MCP",
    sub: "a typical client today",
    steps: [
      { text: "add server to mcp.json" },
      { text: "restart the client", bad: true },
      { text: "conversation state: gone", bad: true },
      { text: "re-authenticate" },
      { text: "call the tool", done: true },
    ],
  },
  {
    id: "mcp-dynamic",
    title: "MCP",
    sub: "a client with dynamic loading",
    steps: [
      { text: "connect server mid-session" },
      { text: "tool list updates in place" },
      { text: "call the tool", done: true },
    ],
  },
];

const STEP_MS = 800;
const MAX_STEPS = Math.max(...LANES.map((l) => l.steps.length));

export function InstallRaceDemo() {
  const reduced = usePrefersReducedMotion();
  // -1 = not started; otherwise the number of ticks elapsed.
  const [tick, setTick] = useState(-1);
  const timerRef = useRef<number | null>(null);

  const playing = tick >= 0 && tick < MAX_STEPS;
  const finished = tick >= MAX_STEPS;

  useEffect(() => {
    if (!playing) return;
    timerRef.current = window.setTimeout(() => setTick((t) => t + 1), STEP_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [tick, playing]);

  const play = () => setTick(reduced ? MAX_STEPS : 0);
  const visibleSteps = (lane: Lane) => (tick < 0 ? 0 : Math.min(tick + 1, lane.steps.length));

  return (
    <div className="bw">
      <p className="sr-only" aria-live="polite">
        {finished
          ? "Finished: the CLI took 2 steps with no restart. A typical MCP client took 5 steps including a restart that lost the session. A dynamic-loading MCP client took 3 steps with no restart."
          : "Press play to race adding a new capability mid-session across three setups."}
      </p>
      <div className="bw-head">
        <span className="bw-eyebrow">Mid-session: “now also talk to Linear”</span>
        <button type="button" className="bw-btn" onClick={play} disabled={playing}>
          {tick < 0 ? "Play" : playing ? "Running…" : "Replay"}
        </button>
      </div>

      <div className="bw-lanes">
        {LANES.map((lane) => {
          const shown = visibleSteps(lane);
          const laneDone = shown >= lane.steps.length && tick >= 0;
          return (
            <div key={lane.id} className="bw-lane" data-done={laneDone ? "true" : undefined}>
              <div className="bw-lane__head">
                <span className="bw-lane__title">{lane.title}</span>
                <span className="bw-lane__sub">{lane.sub}</span>
              </div>
              <div className="bw-lane__steps">
                {lane.steps.map((s, idx) => (
                  <div
                    key={s.text}
                    className="bw-step"
                    data-state={idx < shown ? (s.bad ? "bad" : s.done ? "done" : "on") : "off"}
                  >
                    <span className="bw-step__dot" aria-hidden="true" />
                    <span className="bw-step__text">{s.text}</span>
                    {s.done && idx < shown ? <span className="bw-step__ok">working</span> : null}
                  </div>
                ))}
              </div>
              <div className="bw-lane__tally">
                {laneDone
                  ? `${lane.steps.length} steps · ${lane.steps.some((s) => s.bad) ? "1 restart, session lost" : "no restart"}`
                  : " "}
              </div>
            </div>
          );
        })}
      </div>

      <div className="bw-foot">
        The restart is not in the protocol. MCP lets a client connect to a new server whenever it
        wants and <span className="bw-mono-inline">notifications/tools/list_changed</span> exists so
        the tool list can update in place. The middle lane is a client implementation choice.
      </div>
    </div>
  );
}
