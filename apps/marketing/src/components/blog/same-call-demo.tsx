"use client";

/* eslint-disable react/forbid-elements -- blog widgets use bespoke styled
   controls (segmented toggles, mono labels); the product design-system
   <Button> does not model them. */

import { useEffect, useRef, useState } from "react";
import { useInView, usePrefersReducedMotion } from "./shared";

/**
 * The hero widget: one operation (create a GitHub issue) rendered as an MCP
 * tool call, a CLI invocation, and a raw HTTP request. The facts that never
 * change (which operation, which repo, which title, which label) carry a
 * highlight so the eye can track them across envelopes. Cycles on its own
 * until the reader touches it.
 */

type Surface = "mcp" | "cli" | "http";

const SURFACES: ReadonlyArray<{ readonly id: Surface; readonly label: string }> = [
  { id: "mcp", label: "MCP tool call" },
  { id: "cli", label: "CLI command" },
  { id: "http", label: "HTTP request" },
];

// The invariant facts, highlighted identically on every surface.
function Hl({ children }: { readonly children: React.ReactNode }) {
  return <mark className="bw-hl">{children}</mark>;
}

function McpBody() {
  return (
    <>
      <span className="bw-dim">{"→ tools/call\n"}</span>
      {"{\n"}
      {'  "name": '}
      <Hl>{'"issues_create"'}</Hl>
      {",\n"}
      {'  "arguments": {\n'}
      {'    "repo": '}
      <Hl>{'"acme/api"'}</Hl>
      {",\n"}
      {'    "title": '}
      <Hl>{'"Exports time out after 30s"'}</Hl>
      {",\n"}
      {'    "labels": ['}
      <Hl>{'"bug"'}</Hl>
      {"]\n"}
      {"  }\n"}
      {"}"}
    </>
  );
}

function CliBody() {
  return (
    <>
      <span className="bw-dim">{"$ "}</span>
      {"gh "}
      <Hl>issue create</Hl>
      {" \\\n"}
      {"    --repo "}
      <Hl>acme/api</Hl>
      {" \\\n"}
      {"    --title "}
      <Hl>{'"Exports time out after 30s"'}</Hl>
      {" \\\n"}
      {"    --label "}
      <Hl>bug</Hl>
    </>
  );
}

function HttpBody() {
  return (
    <>
      <Hl>POST</Hl>
      {" /repos/"}
      <Hl>acme/api</Hl>
      {"/"}
      <Hl>issues</Hl>
      {" HTTP/1.1\n"}
      <span className="bw-dim">
        {"authorization: Bearer •••\ncontent-type: application/json\n\n"}
      </span>
      {'{ "title": '}
      <Hl>{'"Exports time out after 30s"'}</Hl>
      {', "labels": ['}
      <Hl>{'"bug"'}</Hl>
      {"] }"}
    </>
  );
}

const BODIES: Record<Surface, () => React.ReactNode> = {
  mcp: McpBody,
  cli: CliBody,
  http: HttpBody,
};

export function SameCallDemo() {
  const [surface, setSurface] = useState<Surface>("mcp");
  const [touched, setTouched] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rootRef);
  const reduced = usePrefersReducedMotion();

  // Cycle surfaces until the reader takes over; never offscreen, never under
  // reduced motion.
  useEffect(() => {
    if (touched || reduced || !inView) return;
    const t = setInterval(() => {
      setSurface((s) => {
        const i = SURFACES.findIndex((x) => x.id === s);
        const next = SURFACES[(i + 1) % SURFACES.length];
        return next ? next.id : s;
      });
    }, 3200);
    return () => clearInterval(t);
  }, [touched, reduced, inView]);

  const pick = (s: Surface) => {
    setTouched(true);
    setSurface(s);
  };

  const Body = BODIES[surface];

  return (
    <div className="bw" ref={rootRef}>
      <p className="sr-only" aria-live="polite">
        Showing the create-issue operation as {SURFACES.find((s) => s.id === surface)?.label}. The
        operation, repository, title, and label are identical on every surface.
      </p>
      <div className="bw-head">
        <span className="bw-eyebrow">One operation, three envelopes</span>
        <div className="bw-seg" role="group" aria-label="Choose a surface">
          {SURFACES.map((s) => (
            <button
              key={s.id}
              type="button"
              className="bw-seg__btn"
              data-on={surface === s.id ? "true" : undefined}
              aria-pressed={surface === s.id}
              onClick={() => pick(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="code-window bw-window">
        <div className="code-window__bar">
          <span className="code-window__dots">
            <i />
            <i />
            <i />
          </span>
          <span className="bw-mono-note">create an issue on acme/api</span>
        </div>
        <pre className="code-window__body bw-code" aria-hidden={false}>
          <code>
            <Body />
          </code>
        </pre>
      </div>
      <div className="bw-foot">
        The <mark className="bw-hl">highlighted parts</mark> are the operation. Everything else is
        the envelope.
      </div>
    </div>
  );
}
