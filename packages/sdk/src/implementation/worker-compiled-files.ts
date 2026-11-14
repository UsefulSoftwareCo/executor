/**
 * Refuse a file too large to compile before esbuild parses it. esbuild-wasm compiles each file in
 * a single synchronous stretch on the thread that serves the host's requests, so this bounds the
 * work esbuild does on any one file. It does not bound a whole build: one of many large files can
 * still hold the thread for several seconds. Only compiling off that thread bounds request delay.
 */
import type { InMemoryFileSystem } from "@cloudflare/worker-bundler";
import type { Plugin } from "esbuild";
import { compiledFileLimit } from "../contracts/source.ts";
import { boundBuildMessage, RuntimeBuildFailed } from "../contracts/runtime.ts";

/**
 * The bytes `TextEncoder` writes for `text`, which esbuild compiles, counted only until the code
 * point that takes the count past `stop`, so a stopped count is at most `stop` plus 4. A high surrogate followed by a low one is one code point of four bytes;
 * any other surrogate is written as U+FFFD, three bytes.
 */
const utf8Bytes = (text: string, stop = Number.POSITIVE_INFINITY) => {
  let bytes = 0;
  for (let at = 0; at < text.length && bytes <= stop; at++) {
    const code = text.charCodeAt(at);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      const next = text.charCodeAt(at + 1);
      if (next >= 0xdc00 && next < 0xe000) {
        bytes += 4;
        at++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
};
/** Whether `text` is more than `limit` UTF-8 bytes. */
const exceeds = (text: string, limit: number) =>
  // Each UTF-16 unit is at least one byte and at most three, so most files need no count.
  text.length > limit || (text.length * 3 > limit && utf8Bytes(text, limit) > limit);

const byteCount = (count: number) => `${count.toLocaleString("en-US")} bytes`;

/**
 * Applies to the server and browser builds, and must be the last of the build's own plugins: it
 * sees only the files no earlier plugin loaded, which the bundler then reads from `filesystem` and
 * compiles as JavaScript or TypeScript. Authored server JSON imports become modules of their own
 * and browser assets are copied, so neither reaches it. Other JSON (in packages and the browser
 * build) and CSS do reach it and are left out on purpose: esbuild loads them with its JSON and CSS
 * loaders, outside this limit. Files of installed packages are not limited: they compile as they
 * always have, however large.
 */
export const compiledFiles = (filesystem: InMemoryFileSystem) => {
  let failure: RuntimeBuildFailed | undefined;
  const plugin: Plugin = {
    name: "executor-compiled-file-size",
    setup(build) {
      build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
        if (args.path.endsWith(".json") || args.path.endsWith(".css")) return undefined;
        // Only the app's own source is limited; installed packages compile as they always have.
        if (args.path.startsWith("node_modules/")) return undefined;
        const text = filesystem.read(args.path);
        if (text === null || !exceeds(text, compiledFileLimit)) return undefined;
        const message = boundBuildMessage(
          `${args.path} is ${byteCount(utf8Bytes(text))}; a JavaScript or TypeScript file the build compiles can be at most ${byteCount(compiledFileLimit)} (2 MB). Split it into smaller modules, or move data it holds into a JSON file, which this limit does not cover.`,
        );
        failure ??= new RuntimeBuildFailed({
          stage: "source",
          // A location names at most 1,024 characters of path.
          ...(args.path.length <= 1024 ? { location: { file: args.path } } : {}),
          message,
        });
        return { errors: [{ text: message }] };
      });
    },
  };
  return { plugin, failure: () => failure };
};
