/**
 * Copy text from a click or key handler, and reject when the browser refuses.
 *
 * Browsers expose `navigator.clipboard` only in secure contexts. A self-hosted dashboard may be
 * served over plain HTTP on a LAN address, where it is missing, so there the text is selected in a
 * hidden field and copied with the document's copy command, which needs only the user's gesture.
 * The field sits beside the focused control so a dialog's focus trap keeps the selection.
 */
export const copyText = async (text: string): Promise<void> => {
  if (window.isSecureContext) return navigator.clipboard.writeText(text);
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
  (previous?.parentElement ?? document.body).append(field);
  field.select();
  try {
    if (!document.execCommand("copy")) throw new Error("The browser refused to copy.");
  } finally {
    field.remove();
    previous?.focus();
  }
};
