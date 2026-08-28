---
"@executor-js/react": patch
---

**A click outside a dialog or sheet no longer discards the form inside it**

Radix dismisses an overlay surface on any un-prevented outside interaction, and `DialogContent` and `SheetContent` only prevented that for clicks landing in a portaled combobox or select popup. Every other outside click fell through to dismissal, so a stray click on the page behind a form — after switching windows to copy an ID, for example — closed the surface and destroyed what the user had typed. These surfaces unmount their state on close by design, so nothing was recoverable.

The default is now the opposite: an outside interaction keeps the surface open. Escape and the close button are unchanged and still close it. `DialogContent` and `SheetContent` take a new `dismissOnOutsideClick` prop for surfaces with nothing to lose — confirmations, pickers, and read-only panels — and the portaled-popup guard still applies there, so choosing a combobox option never dismisses.

`CommandDialog` sets `dismissOnOutsideClick` on by default, because a command palette holds only a search string and clicking away is the expected way to leave it.
