import { createHash } from "node:crypto";
import type { NoteProduct } from "@executor-js/utils/release-notes";

export const noteHash = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

export const noteAudiences: ReadonlyArray<{
  readonly hash: string;
  readonly audience: readonly [NoteProduct, ...ReadonlyArray<NoteProduct>];
}> = [
  { hash: "d0bed9f33b9ab745", audience: ["cloud", "local", "self-host"] },
  { hash: "515bd50755e1224c", audience: ["cloud", "self-host"] },
  { hash: "8cd64056d38f192d", audience: ["cloud", "local", "self-host"] },
  { hash: "c3f687aa706af026", audience: ["cloud", "local", "self-host"] },
  { hash: "b1351d33fd9236de", audience: ["local"] },
  { hash: "e393b4780407fa27", audience: ["local"] },
  { hash: "075671771080f073", audience: ["local"] },
  { hash: "478e3aa2454aff5b", audience: ["local"] },
  { hash: "42d1d579cab1bc54", audience: ["local"] },
  { hash: "eb4a5f03db0aaee7", audience: ["self-host"] },
  { hash: "52c46d6a68e1b6f0", audience: ["self-host"] },
  { hash: "61b05eb27750dc2b", audience: ["self-host"] },
];

export const noteAudience = (text: string): ReadonlyArray<NoteProduct> | undefined => {
  const hash = noteHash(text);
  return noteAudiences.find((entry) => entry.hash === hash)?.audience;
};
