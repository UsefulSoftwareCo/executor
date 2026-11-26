import type { InMemoryFileSystem } from "@cloudflare/worker-bundler";
import type { Plugin } from "esbuild";
import { compiledFileLimit } from "../contracts/source.ts";
import { boundBuildMessage, RuntimeBuildFailed } from "../contracts/runtime.ts";

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
const exceeds = (text: string, limit: number) =>
  text.length > limit || (text.length * 3 > limit && utf8Bytes(text, limit) > limit);

const byteCount = (count: number) => `${count.toLocaleString("en-US")} bytes`;

export const compiledFiles = (filesystem: InMemoryFileSystem) => {
  let failure: RuntimeBuildFailed | undefined;
  const plugin: Plugin = {
    name: "executor-compiled-file-size",
    setup(build) {
      build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
        if (args.path.endsWith(".json") || args.path.endsWith(".css")) return undefined;
        if (args.path.startsWith("node_modules/")) return undefined;
        const text = filesystem.read(args.path);
        if (text === null || !exceeds(text, compiledFileLimit)) return undefined;
        const message = boundBuildMessage(
          `${args.path} is ${byteCount(utf8Bytes(text))}; a JavaScript or TypeScript file the build compiles can be at most ${byteCount(compiledFileLimit)} (2 MB). Split it into smaller modules, or move data it holds into a JSON file, which this limit does not cover.`,
        );
        failure ??= new RuntimeBuildFailed({
          stage: "source",
          ...(args.path.length <= 1024 ? { location: { file: args.path } } : {}),
          message,
        });
        return { errors: [{ text: message }] };
      });
    },
  };
  return { plugin, failure: () => failure };
};
