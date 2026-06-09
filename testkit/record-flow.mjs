// Records the full "OAuth → MCP → call" flow as one dark-themed mp4:
//   1) client title card (mcp add + pick OAuth)
//   2) REAL browser consent UI (login → connected), forced dark via colorScheme
//   3) chat replay of the real tool call
// Run from testkit/ (playwright resolves here): node record-flow.mjs
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { createRuntime, cookieConsentStrategy } from "../vendor/mcporter/dist/index.js";
import { renderPlayer } from "./src/render.mjs";
import { mkdtempSync, writeFileSync, readdirSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os"; import { join } from "node:path";

// fresh OAuth so phase 2 records the real browser consent (not a cached token)
rmSync(join(homedir(), ".mcporter"), { recursive: true, force: true });

const W = 1000, H = 720, APP = process.env.MCP_APP ?? "http://localhost:5173";
const EMAIL = process.env.MCP_EMAIL ?? "admin@demo.test", PW = process.env.MCP_PASSWORD ?? "demo-password-12345";
const TMP = "/tmp/rec-flow"; rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true });
const newRt = () => { const d = mkdtempSync(join(tmpdir(), "rf-")); writeFileSync(join(d, "mcporter.json"), JSON.stringify({ mcpServers: { selfhost: { url: APP + "/mcp" } } })); return createRuntime({ configPath: join(d, "mcporter.json") }); };
const recCtx = (b, dir) => b.newContext({ viewport: { width: W, height: H }, colorScheme: "dark", recordVideo: { dir, size: { width: W, height: H } } });
const grab = (dir, name) => { const f = readdirSync(dir).find(x => x.endsWith(".webm")); renameSync(join(dir, f), `${TMP}/${name}.webm`); };

{ const html = `<!doctype html><meta charset=utf8><style>body{margin:0;background:#0b0f17;color:#d7dce5;font:18px ui-monospace,Menlo,monospace;height:100vh;display:flex;flex-direction:column;justify-content:center;padding:0 60px;box-sizing:border-box}.p{color:#7ee787}.c{color:#79c0ff}.dim{color:#6b7785}div{white-space:pre;margin:6px 0;opacity:0}.cur{background:#d7dce5;animation:b .8s steps(1) infinite}@keyframes b{50%{opacity:0}}</style><div id=l1></div><div id=l2></div><div id=l3></div><div id=l4></div><script>const s=ms=>new Promise(r=>setTimeout(r,ms));async function type(el,txt){el.style.opacity=1;for(let i=0;i<=txt.length;i++){el.innerHTML=txt.slice(0,i)+'<span class=cur> </span>';await s(38)}el.innerHTML=txt}(async()=>{await s(400);await type(l1,'<span class=p>$</span> mcp add <span class=c>'+${JSON.stringify(APP)}+'/mcp</span>');await s(500);l2.style.opacity=1;l2.innerHTML='<span class=dim>? Authentication method:</span>';await s(700);l3.style.opacity=1;l3.innerHTML='  None   Bearer   <span class=p>❯ OAuth</span>';await s(900);l4.style.opacity=1;l4.innerHTML='<span class=dim>→ opening browser for consent…</span>';await s(1200);window.__done=true})();</script>`;
  writeFileSync(`${TMP}/title.html`, html);
  const b = await chromium.launch(); const ctx = await recCtx(b, `${TMP}/v1`); const p = await ctx.newPage();
  await p.goto(`file://${TMP}/title.html`); await p.waitForFunction("window.__done===true", { timeout: 15000 }).catch(()=>{}); await p.waitForTimeout(600);
  await ctx.close(); await b.close(); grab(`${TMP}/v1`, "1"); console.log("phase1 ✓"); }

{ let req; const rt = await newRt();
  try { await rt.listTools("selfhost", { autoAuthorize: true, oauthSessionOptions: { consentStrategy: async r => { req = r; throw new Error("x"); } } }); } catch {}
  const b = await chromium.launch(); const ctx = await recCtx(b, `${TMP}/v2`); const p = await ctx.newPage();
  await p.goto(req.authorizationUrl, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("input[type=email]", { timeout: 10000 }); await p.waitForTimeout(700);
  await p.type("input[type=email]", EMAIL, { delay: 45 }); await p.waitForTimeout(250);
  await p.type("input[type=password]", PW, { delay: 28 }); await p.waitForTimeout(450);
  await p.click("button[type=submit]"); await p.waitForTimeout(2600);
  await p.setContent('<html><body style="font:600 34px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0b0f17;color:#7ee787">🔓 Connected to MCP server</body></html>');
  await p.waitForTimeout(1700); await ctx.close(); await b.close(); grab(`${TMP}/v2`, "2"); console.log("phase2 ✓ (dark login)"); }

{ const rt = await newRt();
  const opts = { autoAuthorize: true, oauthSessionOptions: { consentStrategy: cookieConsentStrategy({ appBaseUrl: APP, email: EMAIL, password: PW }) } };
  const tools = await rt.listTools("selfhost", opts);
  const res = await rt.callTool("selfhost", "execute", { args: { code: "return 6 * 7;" }, ...opts });
  const text = res.content.filter(c=>c.type==="text").map(c=>c.text).join("");
  const run = { task: "Run 6 × 7 in the sandbox using the execute tool", brain: "scripted", meta: { server: APP + "/mcp" }, ok: text==="42", turns: [
    { role: "user", text: "Run 6 × 7 in the sandbox using the execute tool" },
    { role: "assistant", kind: "reasoning", text: "Connected to the MCP server. I'll call execute with a tiny program." },
    { role: "tool", call: { name: "tools/list", args: {} }, result: tools.map(t=>t.name), ok: true, text: tools.map(t=>t.name).join(", ") },
    { role: "tool", call: { name: "execute", args: { code: "return 6 * 7;" } }, result: res.content, ok: true, text },
    { role: "assert", kind: "toBe", actual: text, expected: "42", ok: text === "42" } ]};
  writeFileSync(`${TMP}/chat.html`, renderPlayer(run));
  const b = await chromium.launch(); const ctx = await recCtx(b, `${TMP}/v3`); const p = await ctx.newPage();
  await p.goto(`file://${TMP}/chat.html`); await p.waitForFunction("window.__done===true", { timeout: 30000 }).catch(()=>{}); await p.waitForTimeout(1000);
  await ctx.close(); await b.close(); grab(`${TMP}/v3`, "3"); console.log("phase3 ✓ →", text); }

for (const n of ["1", "2", "3"]) execSync(`ffmpeg -y -i ${TMP}/${n}.webm -vf "scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0b0f17,fps=30" -pix_fmt yuv420p -c:v libx264 -preset veryfast ${TMP}/${n}.mp4 2>/dev/null`);
writeFileSync(`${TMP}/list.txt`, ["1","2","3"].map(n=>`file '${TMP}/${n}.mp4'`).join("\n"));
execSync(`ffmpeg -y -f concat -safe 0 -i ${TMP}/list.txt -c copy ${import.meta.dirname}/runs/oauth-flow.mp4 2>/dev/null`);
console.log("✓ runs/oauth-flow.mp4");
