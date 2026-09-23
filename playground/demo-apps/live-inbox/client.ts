/** Client code imports handler types only; no server module executes in the browser. */
import type { listMessages, receiveMessage } from "./index.ts";
import { array } from "apps";
import { liveQueryAtom, queryReference, mutationReference, type QueryTransport } from "apps/client";
import { Message } from "./schema.ts";

export const references = {
  listMessages: queryReference<typeof listMessages>("listMessages"),
  receiveMessage: mutationReference<typeof receiveMessage>("receiveMessage"),
};

/** The embedding host binds transport to this configured app and its authenticated caller. */
export const messagesAtom = (transport: QueryTransport) =>
  liveQueryAtom(
    references.listMessages,
    {},
    {
      output: array(Message),
      transport,
    },
  );
