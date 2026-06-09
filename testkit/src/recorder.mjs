// A Run is the recording: a chat transcript (turns) + asserts + outcome.
export class Recorder {
  constructor(task, meta = {}) {
    this.run = {
      task, brain: meta.brain ?? "scripted", meta,
      startedAt: Date.now(), turns: [], asserts: [], ok: true,
    };
    this.run.turns.push({ t: Date.now(), role: "user", text: task });
  }
  turn(t) { this.run.turns.push({ t: Date.now(), ...t }); }
  say(text) { this.turn({ role: "assistant", kind: "reasoning", text }); }
  toolCall(name, args, result, ok, text) {
    this.turn({ role: "tool", call: { name, args }, result, ok, text });
  }
  assert(a) {
    this.run.asserts.push(a);
    this.turn({ role: "assert", ...a });
    if (!a.ok) this.run.ok = false;
  }
  finish(ok, error) {
    if (!ok) this.run.ok = false;
    this.run.endedAt = Date.now();
    this.run.durationMs = this.run.endedAt - this.run.startedAt;
    if (error) {
      this.run.error = String(error?.message ?? error);
      this.turn({ role: "error", text: this.run.error });
    }
    return this.run;
  }
}
