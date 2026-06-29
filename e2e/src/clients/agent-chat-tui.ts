// The chat renderer half of the chat theater (see chat-theater.ts): a tiny
// agent-chat TUI that runs inside the recorded PTY and paints whatever the
// scenario's REAL MCP calls are doing. It performs no logic of its own — it
// reads base64-encoded JSON events on stdin and renders them with the
// pacing of a chat session (typed user input, streamed agent text, live
// tool spinners that run exactly as long as the real call did).
//
// Run with: bun agent-chat-tui.ts "<session title>" [events-fifo]
//
// Two transports: events arrive base64-encoded one-per-line either on stdin
// (PTY mode — the chat theater types them into the recorded terminal) or on
// a FIFO path (desk mode — the renderer runs inside a visible xterm on the
// virtual desktop, where stdin belongs to the terminal emulator).
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

type TheaterEvent =
  | { readonly type: "user"; readonly text: string }
  | { readonly type: "assistant"; readonly text: string }
  | {
      readonly type: "tool-start";
      readonly name: string;
      /** The call's real input, pre-rendered as preview lines. */
      readonly input?: readonly string[];
    }
  | {
      readonly type: "tool-end";
      readonly ok: boolean;
      /** First line of the call's real result. */
      readonly result?: string;
      readonly seconds?: number;
    }
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "done" };

const out = (text: string) => process.stdout.write(text);

// The PTY would otherwise echo every incoming event line into the recording.
if (process.stdin.isTTY) process.stdin.setRawMode(true);

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const CLEAR_LINE = "\x1b[2K\r";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const sleep = (ms: number) => new Promise<void>((tick) => setTimeout(tick, ms));

const title = process.argv[2] ?? "executor session";
const eventsFifo = process.argv[3];
out(`${BOLD}${MAGENTA}●${RESET} ${BOLD}${title}${RESET}\n`);
out(`${DIM}${"─".repeat(Math.min(96, title.length + 24))}${RESET}\n`);

let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let spinnerName = "";

// A tool call renders the way agent TUIs render them: the tool's name, the
// call's real input as an indented block, a spinner while the real call
// runs, then the real result's first line with the real duration.
//
//   ⚙ execute
//   │ const added = await tools.executor.openapi.addSpec({
//   │   spec: { kind: "url", url: "https://…/openapi.json" },
//   ⠼ running…
//   ✓ 2.3s  {"ok":true,"slug":"resend","toolCount":9}
const startTool = (name: string, input?: readonly string[]) => {
  spinnerName = name;
  out(`\n  ${MAGENTA}⚙${RESET} ${BOLD}${name}${RESET}\n`);
  for (const line of input ?? []) {
    out(`  ${DIM}│ ${line.slice(0, 92)}${RESET}\n`);
  }
  let frame = 0;
  spinnerTimer = setInterval(() => {
    out(`${CLEAR_LINE}  ${CYAN}${SPINNER[frame % SPINNER.length]}${RESET} ${DIM}running…${RESET}`);
    frame += 1;
  }, 80);
};

const endTool = (ok: boolean, result?: string, seconds?: number) => {
  if (spinnerTimer) clearInterval(spinnerTimer);
  spinnerTimer = undefined;
  const mark = ok ? `${GREEN}✓${RESET}` : `${RED}✗ ${spinnerName}${RESET}`;
  const took = seconds !== undefined ? `${DIM}${seconds.toFixed(1)}s${RESET}  ` : "";
  out(`${CLEAR_LINE}  ${mark} ${took}${DIM}${(result ?? "").slice(0, 88)}${RESET}\n`);
};

const handle = async (event: TheaterEvent): Promise<boolean> => {
  switch (event.type) {
    case "user": {
      out(`\n${BOLD}${CYAN}┃ you${RESET}  `);
      for (const ch of event.text) {
        out(ch);
        await sleep(18);
      }
      out("\n");
      return true;
    }
    case "assistant": {
      out(`\n${BOLD}${MAGENTA}● agent${RESET}  `);
      for (const piece of event.text.match(/.{1,3}/gs) ?? []) {
        out(piece);
        await sleep(12);
      }
      out("\n");
      return true;
    }
    case "tool-start": {
      startTool(event.name, event.input);
      return true;
    }
    case "tool-end": {
      endTool(event.ok, event.result, event.seconds);
      return true;
    }
    case "status": {
      out(`\n  ${DIM}· ${event.text}${RESET}\n`);
      return true;
    }
    case "done": {
      out(`\n${DIM}${"─".repeat(40)}${RESET}\n${GREEN}✦ session complete${RESET}\n`);
      if (eventsFifo) {
        // Desk mode: ack completion to the driver, then linger so the
        // closing frame stays on camera before the xterm vanishes.
        writeFileSync(`${eventsFifo}.done`, "");
        await sleep(4_000);
      }
      return false;
    }
  }
};

// Events arrive faster than they render; process strictly in order so the
// animations (not arrival time) set the pacing.
const queue: TheaterEvent[] = [];
let draining = false;
const drain = async () => {
  if (draining) return;
  draining = true;
  while (queue.length > 0) {
    const event = queue.shift();
    if (!event) break;
    const keepGoing = await handle(event);
    if (!keepGoing) {
      process.exit(0);
    }
  }
  draining = false;
};

const input = eventsFifo ? createReadStream(eventsFifo) : process.stdin;
createInterface({ input, terminal: false }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: PTY stdin may echo stray keystrokes that aren't base64 JSON; ignore them
  try {
    queue.push(JSON.parse(Buffer.from(trimmed, "base64").toString("utf8")) as TheaterEvent);
  } catch {
    return;
  }
  void drain();
});
