// Copy text to the clipboard, working in BOTH secure and non-secure origins.
//
// `navigator.clipboard` only exists in a secure context (HTTPS, or localhost).
// A self-hosted console is commonly served over plain HTTP on a LAN host/IP —
// a non-secure origin — where `navigator.clipboard` is `undefined`, so a bare
// `navigator.clipboard.writeText(...)` throws and the copy silently does
// nothing. Fall back to a legacy `document.execCommand("copy")` path so the
// copy buttons work everywhere.
//
// Returns whether the copy succeeded, so callers only show their "copied"
// confirmation when the value actually reached the clipboard.
export async function copyToClipboard(text: string): Promise<boolean> {
  // Preferred path: the async Clipboard API (secure contexts).
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the Clipboard API rejects (permission denied, blur) and we recover via the legacy path
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied / document not focused — fall through to the legacy
      // path rather than failing the copy.
    }
  }

  return legacyCopy(text);
}

// Legacy fallback for non-secure origins (plain-HTTP self-host). Select the text
// via a document Range on a hidden node, then `execCommand("copy")`.
//
// Crucially this selects a Range WITHOUT moving focus. A throwaway <textarea>
// that we `.focus()` would be yanked straight back by a focus trap (e.g. the
// Radix dialog that shows a freshly created API key), leaving nothing selected
// when the copy fires. A document selection survives the focus trap, so the
// copy works wherever the button lives.
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const selection = document.getSelection();
  if (!selection) return false;

  const node = document.createElement("span");
  node.textContent = text;
  node.style.whiteSpace = "pre"; // preserve spaces/newlines exactly
  node.style.userSelect = "text";
  node.style.position = "fixed";
  node.style.top = "0";
  node.style.left = "0";
  node.style.opacity = "0";
  node.style.pointerEvents = "none";
  document.body.appendChild(node);

  const previousRange = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: execCommand can throw in restricted DOM contexts; selection + node must be restored regardless
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    selection.removeAllRanges();
    if (previousRange) selection.addRange(previousRange);
    document.body.removeChild(node);
  }
}
