import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { array } from "apps";
import { createAppClient, mutationReference, queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type { listMessages, receiveMessage } from "../index.ts";
import { Message } from "../schema.ts";
import "./style.css";

const client = createAppClient();
const listRef = queryReference<typeof listMessages>("listMessages");
const inbox = client.queryAtom(listRef, {}, array(Message));
const receive = client
  .mutation(mutationReference<typeof receiveMessage>("receiveMessage"), Message)
  .withOptimisticUpdate((store, input) => {
    const rows = store.getQuery(listRef, {});
    if (rows !== undefined && input.clientId !== undefined) {
      store.setQuery(
        listRef,
        {},
        [{ id: input.clientId, subject: input.subject }, ...rows].slice(0, 100),
      );
    }
  });

function Inbox() {
  const { data, pending, error } = useAppQuery(inbox);
  const [subject, setSubject] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  return (
    <main className="max-w-225 min-h-dvh py-0 px-[32px] m-auto flex flex-col max-[540px]:py-0 max-[540px]:px-[20px]">
      <header className="h-20 flex items-center justify-between [border-bottom:1px_solid_#e8e8e2] max-[540px]:h-16.5">
        <div className="identity flex items-center gap-2.5 font-semibold text-[15px]">
          <span
            className="mark w-7.25 h-7.25 [border:1px_solid_#deded7] bg-white grid [place-items:center] rounded-[8px]"
            aria-hidden="true"
          >
            ↗
          </span>
          <span>Inbox</span>
        </div>
        <span className="status text-[#55645b] text-[12px] flex items-center gap-1.5 before:[content:''] before:w-1.5 before:h-1.5 before:bg-[#659674] before:rounded-[50%]">
          {pending ? "Connecting…" : error ? "Disconnected" : "Live"}
        </span>
      </header>
      <section className="intro [padding:64px_0_36px] [&_p]:text-[14px] [&_p]:text-[#85857d] [&_p]:m-0 max-[540px]:pt-10">
        <span className="eyebrow text-[10px] tracking-[0.12em] font-semibold text-[#888880]">
          YOUR SPACE
        </span>
        <h1 className="text-[clamp(26px,_5vw,_36px)] tracking-[-0.04em] font-medium [margin:14px_0_10px]">
          A little room for ideas.
        </h1>
        <p>Leave a thought. It’s here when you return.</p>
      </section>
      <form
        className="bg-white [border:1px_solid_#e2e2db] rounded-[12px] p-[20px] max-[540px]:p-[16px]"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!subject.trim() || saving) return;
          setSaving(true);
          setFailure(undefined);
          try {
            await receive({ subject: subject.trim(), clientId: crypto.randomUUID() });
            setSubject("");
          } catch {
            setFailure("Could not save your message. Try again.");
          } finally {
            setSaving(false);
          }
        }}
      >
        <label className="block text-[12px] [font-weight:550] mb-3" htmlFor="subject">
          New message
        </label>
        <div className="compose flex gap-3 max-[540px]:flex-col">
          <input
            className="min-w-0 flex-1 [border:1px_solid_#e3e3dd] rounded-[7px] py-[11px] px-[12px] bg-[#fafaf8] text-[14px] focus-visible:[outline:2px_solid_#adbdad] focus-visible:outline-offset-[2px]"
            id="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What’s on your mind?"
            autoComplete="off"
            required
          />
          <button
            className="border-0 rounded-[7px] bg-[#303d34] text-white py-0 px-[17px] text-[12px] [font-weight:550] cursor-pointer max-[540px]:min-h-10.5 disabled:opacity-50 disabled:cursor-default"
            disabled={saving || !subject.trim()}
          >
            {saving ? "Saving…" : "Add message"}
          </button>
        </div>
        {failure && (
          <p className=" text-[#a74636] text-[13px]" role="alert">
            {failure}
          </p>
        )}
      </form>
      <section className="messages flex-1 pt-9.5" aria-labelledby="messages-title">
        <div className="section-heading flex items-center justify-between pb-3.75 [border-bottom:1px_solid_#e6e6df] [&_h2]:text-[13px] [&_h2]:[font-weight:550] [&_h2]:m-0 [&_span]:text-[11px] [&_span]:text-[#8c8c83]">
          <h2 id="messages-title">Messages</h2>
          <span>{data?.length ?? 0}</span>
        </div>
        {error && (
          <p className=" text-[#a74636] text-[13px]" role="alert">
            {error}
          </p>
        )}
        {pending ? (
          <p className="empty py-[64px] px-0 text-center text-[#97978e] [&_>_span]:text-[30px] [&_>_span]:text-[#bdc4b8] [&_h3]:text-[#77776f] [&_h3]:text-[14px] [&_h3]:font-medium [&_h3]:[margin:18px_0_7px] [&_p]:text-[12px] [&_p]:m-0 ">
            Loading your inbox…
          </p>
        ) : data?.length === 0 ? (
          <div className="empty py-[64px] px-0 text-center text-[#97978e] [&_>_span]:text-[30px] [&_>_span]:text-[#bdc4b8] [&_h3]:text-[#77776f] [&_h3]:text-[14px] [&_h3]:font-medium [&_h3]:[margin:18px_0_7px] [&_p]:text-[12px] [&_p]:m-0">
            <span aria-hidden="true">✳</span>
            <h3>A clean slate.</h3>
            <p>Your first message goes here.</p>
          </div>
        ) : (
          <ul className="p-0 m-0 [list-style:none]">
            {data?.map((message) => (
              <li
                className="[border-bottom:1px_solid_#e8e8e2] flex gap-3.75 items-start py-[21px] px-[2px]"
                key={message.id}
              >
                <span className="message-icon text-[#80917e]" aria-hidden="true">
                  ↗
                </span>
                <p>{message.subject}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <footer className="flex justify-between text-[#a1a197] text-[11px] py-[30px] px-0 mt-10">
        Live inbox <span>Made with Executor</span>
      </footer>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing app root");
createRoot(root).render(
  <StrictMode>
    <Inbox />
  </StrictMode>,
);
