/** Lightweight service contract. Importing this binding never imports esbuild or its WASM. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { CloudCompiler } from "../contracts/builds.ts";

/** The compiler has no public URL; API and app hosts use a private service binding. */
export class AppCompiler extends Cloudflare.Worker<AppCompiler, CloudCompiler>()("AppCompiler") {}
