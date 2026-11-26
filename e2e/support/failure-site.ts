const site = / Phase: (?:evaluate|discover|call)\. Reference: [0-9a-f]{32}\.$/u;

export const siteless = (message: string): string => {
  if (!site.test(message)) throw new Error(`The failure names no phase and reference: ${message}`);
  return message.replace(site, "");
};
