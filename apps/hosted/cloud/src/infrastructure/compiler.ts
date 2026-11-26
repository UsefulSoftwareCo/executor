import * as Cloudflare from "alchemy/Cloudflare";
import type { CloudCompiler } from "../contracts/builds.ts";

export class AppCompiler extends Cloudflare.Worker<AppCompiler, CloudCompiler>()("AppCompiler") {}
