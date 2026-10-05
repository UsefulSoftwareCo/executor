/** Every released host protocol. `bun run check` compares each with its committed snapshot. */
import { protocol1 } from "./1.ts";
import { protocol2 } from "./2.ts";
import { protocol3 } from "./3.ts";
import { protocol4 } from "./4.ts";
import { protocol5 } from "./5.ts";
import { protocol6 } from "./6.ts";
import { protocol7 } from "./7.ts";
import { protocol8 } from "./8.ts";

export const releasedProtocols = [
  protocol1,
  protocol2,
  protocol3,
  protocol4,
  protocol5,
  protocol6,
  protocol7,
  protocol8,
] as const;
