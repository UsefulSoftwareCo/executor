/**
 * Every released host protocol that the framework no longer speaks. Each is frozen: `bun run check`
 * compares it with its snapshot in `packages/apps/protocols/`. The protocol the framework speaks is
 * `current.ts`, recorded under its own number.
 */
import { protocol1 } from "./1.ts";
import { protocol2 } from "./2.ts";
import { protocol3 } from "./3.ts";
import { protocol4 } from "./4.ts";
import { protocol5 } from "./5.ts";
import { protocol6 } from "./6.ts";
import { protocol7 } from "./7.ts";
import { protocol8 } from "./8.ts";
import { protocol9 } from "./9.ts";
import { protocol10 } from "./10.ts";
import { protocol11 } from "./11.ts";

export const releasedProtocols = [
  protocol1,
  protocol2,
  protocol3,
  protocol4,
  protocol5,
  protocol6,
  protocol7,
  protocol8,
  protocol9,
  protocol10,
  protocol11,
] as const;
