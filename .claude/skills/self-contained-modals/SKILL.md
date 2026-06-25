---
name: self-contained-modals
description: "Build modals/dialogs self-contained: form and in-flight state lives inside, closing unmounts it. Use when writing or reviewing a modal/dialog, especially one that owns async work (OAuth popups, timers, subscriptions, AbortControllers). Catches the stuck-on-Connecting class of lifecycle-leak bugs."
---

# Self-contained modals

A modal's **form state and in-flight work live INSIDE the modal**, and **closing
the modal UNMOUNTS that state** so it is destroyed, not hand-reset. Only the
**open/route intent** belongs to the parent (deep links, programmatic open,
reconnect handoffs need it).

## Why

A hand-written `reset()` has to enumerate every field, and it silently drifts out
of sync with state owned by **child hooks the parent can't see**. Unmounting
resets everything for free, including child-hook cleanup effects (cancelling a
dangling server session, clearing a timer, aborting a fetch).

Concrete bug this prevents (executor, add-account-modal): the modal was mounted
unconditionally, so `useOAuthPopupFlow`'s `busy` survived close. `reset()` zeroed
its own booleans but never called `oauthPopup.cancel()`. Abandon the OAuth popup,
close, reopen, and `oauthBusy = false || busy(true) = true`, so the footer is
wedged on "Connecting…" with Close disabled. Unmounting would have cleared `busy`
AND run the hook's cleanup that cancels the server OAuth session.

## How to apply

Default to **genuine conditional unmount**, state inside. When closed the
component returns `null`, so React destroys all of it and runs every child
hook's cleanup. This is the cleanest fix and the one to reach for first:

```tsx
function Parent() {
  const [open, setOpen] = useState(false);
  return open ? <Modal onClose={() => setOpen(false)} /> : null;
}
```

A key bump (`<Body key={openCount} />`) is **still a manual reset**, just
spelled as a remount. Prefer real unmount; only reach for keyed remount in the
one case below.

That case: **Radix Dialog** (this repo's `components/dialog.tsx`) Content/Overlay
use `data-[state=closed]:animate-out` exit animations, so unmounting the whole
`Dialog` drops the close animation. If you must keep that animation, keep the
`Dialog` + `DialogContent` shell mounted and remount only the state-bearing
**body** per open:

```tsx
function Parent() {
  const [open, setOpen] = useState(false);
  const [openCount, setOpenCount] = useState(0);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>{open ? <ModalBody key={openCount} /> : null}</DialogContent>
    </Dialog>
  );
}
```

This only works when `DialogContent` is **independent of body state**. If the
shell depends on the body (e.g. a width className driven by the body's current
sub-view), the body must own `DialogContent`, so there is no stable shell to
keep, and genuine unmount (losing the exit animation) is the right call. That is
exactly the executor add-account-modal: it genuinely unmounts and accepts the
lost animation rather than plumbing body state up to a shell.

## Reviewing: flag these smells

1. A hand-written `reset()` exists. Its presence means state outlives the modal;
   ask why the modal isn't just unmounted.
2. An always-mounted dialog (rendered unconditionally with an `open` prop) that
   owns async/in-flight state: popups, timers, subscriptions, AbortControllers,
   server sessions.
3. A busy/loading flag composed from a child hook (e.g. `ccBusy || someHook.busy`)
   where `reset()` clears only part of it.
