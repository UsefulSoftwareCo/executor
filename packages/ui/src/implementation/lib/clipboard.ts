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
