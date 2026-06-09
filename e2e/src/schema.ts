// The run record: one scenario execution on one target, as a chat-style
// transcript. This file is the contract between the recorder (writers), the
// surfaces (turn emitters), and the viewer (renderers) — every artifact the
// suite produces is a `Run` plus the files its evidence points at.
//
// Evidence is per-medium: the transcript is the spine, media are attachments.
// Paths are RELATIVE to the run's own directory (runs/<target>/<slug>/), so a
// run folder is self-contained and serveable from anywhere.

export type Evidence =
  | { readonly kind: "screenshot"; readonly path: string; readonly label?: string }
  | {
      readonly kind: "video";
      readonly path: string;
      readonly startMs?: number;
      readonly endMs?: number;
    }
  | {
      readonly kind: "termFrames";
      readonly frames: ReadonlyArray<{ readonly t: number; readonly text: string }>;
    }
  | { readonly kind: "json"; readonly label?: string; readonly data: unknown }
  | {
      readonly kind: "ledger";
      readonly service: string;
      readonly entries: ReadonlyArray<unknown>;
    };

export type AuthPhase = "connect" | "authorize" | "code" | "connected";

export type Surface = "api" | "mcp" | "browser" | "cli";

export interface Assertion {
  readonly kind: string;
  readonly actual: unknown;
  readonly expected: unknown;
  readonly ok: boolean;
  readonly label?: string;
}

export type Turn =
  | { readonly t: number; readonly role: "user"; readonly text: string }
  | {
      readonly t: number;
      readonly role: "assistant";
      readonly kind: "reasoning";
      readonly text: string;
    }
  | {
      readonly t: number;
      readonly role: "auth";
      readonly phase: AuthPhase;
      readonly text: string;
      readonly ok?: boolean;
      readonly detail?: unknown;
    }
  | {
      readonly t: number;
      readonly role: "tool";
      readonly surface: Surface;
      readonly call: { readonly name: string; readonly args: unknown };
      readonly result: unknown;
      readonly ok: boolean;
      readonly text: string;
      readonly durationMs?: number;
      readonly evidence?: ReadonlyArray<Evidence>;
    }
  | {
      readonly t: number;
      readonly role: "step";
      readonly surface: Surface;
      readonly text: string;
      readonly evidence?: ReadonlyArray<Evidence>;
    }
  | { readonly t: number; readonly role: "assert"; readonly assertion: Assertion }
  | {
      readonly t: number;
      readonly role: "error";
      readonly text: string;
      readonly evidence?: ReadonlyArray<Evidence>;
    };

export interface Run {
  readonly schema: 2;
  readonly scenario: string;
  readonly target: string;
  readonly brain: "scripted";
  ok: boolean;
  readonly startedAt: number;
  endedAt?: number;
  durationMs?: number;
  error?: string;
  readonly meta: Record<string, unknown>;
  readonly turns: Turn[];
  readonly asserts: Assertion[];
}

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
