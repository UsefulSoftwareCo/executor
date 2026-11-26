import * as Cloudflare from "alchemy/Cloudflare";
import type { Formatting } from "../contracts/formatter.ts";

export class Formatter extends Cloudflare.Worker<Formatter, Formatting>()("Formatter") {}
