// Verify sunpeak's inspector advertises the MCP-Apps UI *client* capability to
// the upstream MCP server.
//
// executor gates inline UI rendering on that advertisement (per the MCP-Apps
// spec: a server mounts inline only when the host says it can render
// `text/html;profile=mcp-app`). A host that doesn't advertise it gets the
// deep-link fallback instead of the widget — which would make this whole suite
// pass while testing the wrong delivery path.
//
// sunpeak used to construct its Client with no capabilities at all and we
// patched the shipped file. As of 0.20.69 it declares the capability itself, so
// this is now a CHECK rather than a patch. It stays fatal: if a future sunpeak
// drops the capability, the harness must fail loudly at install time rather
// than silently degrade.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../node_modules/sunpeak/bin/commands/inspect.mjs");

if (!existsSync(target)) {
  console.error(`[check-sunpeak] ${target} not found. Is sunpeak installed?`);
  process.exit(1);
}

const src = readFileSync(target, "utf8");
const EXTENSION_ID = "io.modelcontextprotocol/ui";
const MIME_TYPE = "text/html;profile=mcp-app";

if (!src.includes(EXTENSION_ID) || !src.includes(MIME_TYPE)) {
  console.error(
    [
      "[check-sunpeak] the inspector no longer advertises MCP-Apps client support.",
      `  expected both ${EXTENSION_ID} and ${MIME_TYPE}`,
      `  in: ${target}`,
      "Without it executor returns its deep-link fallback and these tests would pass",
      "while testing nothing. Pin a sunpeak version that advertises the capability,",
      "or restore a patch here that injects it into the Client constructor.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("[check-sunpeak] inspector advertises MCP-Apps UI client capability");
