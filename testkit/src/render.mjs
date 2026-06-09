import { readFileSync, writeFileSync } from "node:fs";

const C = { dim: "\x1b[2m", grn: "\x1b[32m", red: "\x1b[31m", cyn: "\x1b[36m", yel: "\x1b[33m", b: "\x1b[1m", r: "\x1b[0m" };
const icon = { user: "🧑", assistant: "🤖", tool: "🔧", assert: "  ", error: "💥" };

export function renderTerminal(run) {
  const L = [];
  L.push(`${C.b}${run.ok ? C.grn + "✓" : C.red + "✗"} ${run.task}${C.r}  ${C.dim}(${run.durationMs}ms, brain=${run.brain})${C.r}`);
  for (const t of run.turns) {
    if (t.role === "user") L.push(`\n${icon.user}  ${C.b}${t.text}${C.r}`);
    else if (t.role === "assistant") L.push(`${icon.assistant}  ${C.dim}${t.text}${C.r}`);
    else if (t.role === "auth") L.push(`${t.phase === "connected" ? "🔓" : "🔐"}  ${C.yel}${t.text}${C.r}`);
    else if (t.role === "tool") L.push(`${icon.tool}  ${C.cyn}${t.call.name}${C.r}(${C.dim}${JSON.stringify(t.call.args)}${C.r}) ${t.ok ? C.grn + "✓" : C.red + "✗"}${C.r} ${C.dim}→ ${String(t.text).slice(0, 80)}${C.r}`);
    else if (t.role === "assert") L.push(`${t.ok ? C.grn + "    ✅" : C.red + "    ❌"} expect(${JSON.stringify(t.actual)}).${t.kind}(${JSON.stringify(t.expected)})${C.r}`);
    else if (t.role === "error") L.push(`${icon.error}  ${C.red}${t.text}${C.r}`);
  }
  return L.join("\n");
}

export function renderHtml(run) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const bubble = (t) => {
    if (t.role === "user") return `<div class="u"><b>${esc(t.text)}</b></div>`;
    if (t.role === "auth") return `<div class="au">${t.phase === "connected" ? "🔓" : "🔐"} ${esc(t.text)}</div>`;
    if (t.role === "assistant") return `<div class="a">${esc(t.text)}</div>`;
    if (t.role === "tool") return `<details class="t ${t.ok ? "ok" : "no"}"><summary>🔧 <b>${esc(t.call.name)}</b> ${t.ok ? "✓" : "✗"} <span class="g">→ ${esc(String(t.text).slice(0, 100))}</span></summary><pre>${esc(JSON.stringify({ args: t.call.args, result: t.result }, null, 2))}</pre></details>`;
    if (t.role === "assert") return `<div class="x ${t.ok ? "ok" : "no"}">${t.ok ? "✅" : "❌"} expect(${esc(JSON.stringify(t.actual))}).${t.kind}(${esc(JSON.stringify(t.expected))})</div>`;
    if (t.role === "error") return `<div class="e">💥 ${esc(t.text)}</div>`;
    return "";
  };
  return `<!doctype html><meta charset=utf8><title>${esc(run.task)}</title><style>
  body{font:14px/1.5 ui-sans-serif,system-ui;max-width:760px;margin:2rem auto;color:#111;background:#fafafa}
  h1{font-size:16px}.hdr{color:${run.ok ? "#15803d" : "#b91c1c"};font-weight:700;margin-bottom:1rem}
  .u{background:#111;color:#fff;padding:.5rem .75rem;border-radius:10px;margin:.5rem 0}
  .a{color:#555;padding:.25rem .75rem;margin:.25rem 0;border-left:2px solid #ddd}
  .au{background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:.35rem .6rem;border-radius:8px;margin:.3rem 0;font-size:13px}
  .t{background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:.4rem .6rem;margin:.4rem 0}
  .t.no{border-color:#fca5a5}.t summary{cursor:pointer}.t .g{color:#888;font-weight:400}
  .t pre{background:#f5f5f5;padding:.5rem;border-radius:6px;overflow:auto;font-size:12px}
  .x{padding:.2rem .75rem;font-size:13px}.x.ok{color:#15803d}.x.no{color:#b91c1c;font-weight:700}
  .e{color:#b91c1c;font-weight:700;padding:.5rem .75rem}</style>
  <h1>MCP run · <span class=hdr>${run.ok ? "PASSED" : "FAILED"}</span></h1>
  ${run.turns.map(bubble).join("\n")}
  <p style="color:#999;font-size:12px">brain=${run.brain} · ${run.durationMs}ms · ${esc(run.meta?.server ?? "")}</p>`;
}

if (process.argv[1]?.endsWith("render.mjs")) {
  const file = process.argv[2];
  const run = JSON.parse(readFileSync(file, "utf8"));
  const htmlArg = process.argv.indexOf("--html");
  if (htmlArg > -1) { const out = process.argv[htmlArg + 1]; writeFileSync(out, renderHtml(run)); console.log("wrote", out); }
  else console.log(renderTerminal(run));
}

import { dirname, join as _join } from "node:path";
import { fileURLToPath } from "node:url";
export function renderPlayer(run) {
  const tpl = readFileSync(_join(dirname(fileURLToPath(import.meta.url)), "player.template.html"), "utf8");
  return tpl.replace("__RUN__", JSON.stringify(run));
}
