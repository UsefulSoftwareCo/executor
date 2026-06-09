import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../vendor/mcporter/dist/index.js";

class AssertionError extends Error {}
const textOf = (res) =>
  Array.isArray(res?.content)
    ? res.content.filter((p) => p.type === "text").map((p) => p.text).join("\n")
    : typeof res === "string" ? res : JSON.stringify(res);

// `mcp` handle passed to a scripted test. Every call is recorded as a chat turn;
// connect + headless OAuth (the target's consentStrategy) happen lazily on first use.
export class McpDriver {
  constructor(target, recorder) {
    this.target = target;
    this.rec = recorder;
    // Wrap the target's consent so the OAuth handshake is recorded as turns.
    const consent = target.consent;
    this._opts = {
      autoAuthorize: true,
      oauthSessionOptions: {
        consentStrategy: async (req) => {
          this.rec.turn({ role: "auth", phase: "authorize", text: "OAuth required → client registered (DCR), authorizing", detail: { authorizationUrl: req.authorizationUrl } });
          const out = await consent(req);
          this.rec.turn({ role: "auth", phase: "code", text: "Signed in & consented → authorization code received", ok: true });
          return out;
        },
      },
    };
  }
  async _runtime() {
    if (this._rt) return this._rt;
    const dir = mkdtempSync(join(tmpdir(), "mcp-testkit-"));
    const cfg = { mcpServers: { [this.target.name]: { url: this.target.server } } };
    writeFileSync(join(dir, "mcporter.json"), JSON.stringify(cfg));
    this._rt = await createRuntime({ configPath: join(dir, "mcporter.json") });
    return this._rt;
  }
  // Connect once, recording the OAuth lifecycle: connect → (authorize → code) → connected.
  // The tools/list call triggers mcporter's auth flow; the consent wrap records the middle.
  async _connect() {
    if (this._connected) return;
    this.rec.turn({ role: "auth", phase: "connect", text: `Connecting to ${this.target.server}` });
    this._toolDefs = await (await this._runtime()).listTools(this.target.name, this._opts);
    this.rec.turn({ role: "auth", phase: "connected", text: "Connected — access token acquired & cached for reuse", ok: true });
    this._connected = true;
  }
  say(text) { this.rec.say(text); }
  async listTools() {
    await this._connect();
    const names = this._toolDefs.map((t) => t.name);
    this.rec.turn({ role: "tool", call: { name: "tools/list", args: {} }, result: names, ok: true, text: names.join(", ") });
    return names;
  }
  async call(name, args = {}) {
    await this._connect();
    const rt = await this._runtime();
    const res = await rt.callTool(this.target.name, name, { args, ...this._opts });
    const text = textOf(res);
    this.rec.toolCall(name, args, res?.content ?? res, !res?.isError, text);
    return { raw: res, text, ok: !res?.isError };
  }
  async approvePaused(text, content = {}) {
    const match = /\bexecutionId:\s*(\S+)/.exec(text);
    if (!match) throw new AssertionError("approvePaused: executionId not found");
    return await this.call("resume", {
      executionId: match[1],
      action: "accept",
      content: JSON.stringify(content),
    });
  }
  // assertions record a turn (pass or fail) and throw on failure to fail the test
  expect(actual) {
    const rec = this.rec;
    const check = (kind, ok, expected) => {
      rec.assert({ kind, actual, expected, ok });
      if (!ok) throw new AssertionError(`expect(${JSON.stringify(actual)}).${kind}(${JSON.stringify(expected)})`);
    };
    return {
      toBe: (e) => check("toBe", actual === e, e),
      toContain: (e) => check("toContain", (Array.isArray(actual) ? actual.includes(e) : String(actual).includes(e)), e),
      toMatch: (re) => check("toMatch", re.test(String(actual)), String(re)),
      toBeGreaterThan: (e) => check("toBeGreaterThan", actual > e, e),
    };
  }
}
