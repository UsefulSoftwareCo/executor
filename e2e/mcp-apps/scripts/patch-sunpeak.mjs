// Patch sunpeak's inspector so it advertises the MCP-Apps UI *client* capability
// to the upstream MCP server.
//
// sunpeak builds its server connection with `new Client({ name, version })` and
// never declares `capabilities.extensions["io.modelcontextprotocol/ui"]`. A
// server that gates inline UI rendering on that advertisement (executor's
// `render-ui` does, per the MCP-Apps spec: server mounts inline only when the
// host advertises it can render `text/html;profile=mcp-app`) will return its
// fallback URL instead of the widget, so nothing renders in the inspector.
//
// This adds the capability. Idempotent. Runs as a postinstall.
// Upstream-worthy: sunpeak should advertise this itself (filed/PR pending).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../node_modules/sunpeak/bin/commands/inspect.mjs");

if (!existsSync(target)) {
  console.warn(`[patch-sunpeak] ${target} not found; skipping (sunpeak not installed yet?)`);
  process.exit(0);
}

const NEEDLE = `new Client({ name: 'sunpeak-inspector', version: '1.0.0' })`;
const CAPS =
  `{ capabilities: { extensions: { 'io.modelcontextprotocol/ui': ` +
  `{ mimeTypes: ['text/html;profile=mcp-app'] } } } }`;
const REPLACEMENT = `new Client({ name: 'sunpeak-inspector', version: '1.0.0' }, ${CAPS})`;

const src = readFileSync(target, "utf8");
if (src.includes(CAPS)) {
  console.log("[patch-sunpeak] already patched");
  process.exit(0);
}
if (!src.includes(NEEDLE)) {
  console.warn("[patch-sunpeak] anchor not found (sunpeak version changed?); leaving file untouched");
  process.exit(0);
}
writeFileSync(target, src.replace(NEEDLE, REPLACEMENT));
console.log("[patch-sunpeak] advertised MCP-Apps UI client capability");
