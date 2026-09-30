import { Effect } from "effect";
import { SaxesParser } from "saxes";

import { WsdlError } from "./errors";
export { WsdlError } from "./errors";

export interface XmlNode {
  readonly name: string;
  readonly ns: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly namespaces: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
}

export const WSDL = "http://schemas.xmlsoap.org/wsdl/";
export const XSD = "http://www.w3.org/2001/XMLSchema";
export const SOAP = "http://schemas.xmlsoap.org/wsdl/soap/";
export const ENVELOPE = "http://schemas.xmlsoap.org/soap/envelope/";
export const XSI = "http://www.w3.org/2001/XMLSchema-instance";
export const key = (ns: string, name: string) => `{${ns}}${name}`;
export const children = (node: XmlNode, ns: string, name: string) =>
  node.children.filter((child) => child.ns === ns && child.name === name);

export const parseXml = (xml: string) =>
  Effect.try({
    try: () => {
      // The SAX parser is a synchronous throwing boundary. Reject DTDs before parsing.
      if (
        xml.length > 2_000_000 ||
        new TextEncoder().encode(xml).byteLength > 2_000_000 ||
        /<!DOCTYPE|<!ENTITY/i.test(xml)
      ) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous SAX adapter translated by Effect.try
        throw new WsdlError({
          message: "XML exceeds 2 MB or contains a forbidden DTD/entity declaration",
        });
      }
      const stack: XmlNode[] = [];
      let root: XmlNode | undefined;
      let count = 0;
      const parser = new SaxesParser({ xmlns: true });
      parser.on("opentag", (tag) => {
        if (stack.length >= 64 || ++count > 50_000) {
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: stop the synchronous SAX parser before further allocation
          throw new WsdlError({ message: "XML complexity limit exceeded" });
        }
        const attrs: Record<string, string> = Object.create(null);
        for (const attr of Object.values(tag.attributes)) {
          attrs[attr.uri ? key(attr.uri, attr.local) : attr.local] = attr.value;
        }
        const node: XmlNode = {
          name: tag.local,
          ns: tag.uri,
          attrs,
          namespaces: { ...stack.at(-1)?.namespaces, ...tag.ns },
          children: [],
          text: "",
        };
        const parent = stack.at(-1);
        if (parent) parent.children.push(node);
        else root = node;
        stack.push(node);
      });
      parser.on("text", (text) => {
        const node = stack.at(-1);
        if (node) node.text += text;
      });
      parser.on("cdata", (text) => {
        const node = stack.at(-1);
        if (node) node.text += text;
      });
      parser.on("closetag", () => {
        stack.pop();
      });
      parser.write(xml).close();
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: parser result translated by Effect.try
      if (!root) throw new WsdlError({ message: "XML has no root element" });
      return root;
    },
    catch: () =>
      new WsdlError({
        message: "Invalid XML, forbidden DTD/entity declaration, or XML size/depth limit exceeded",
      }),
  });

export const qname = (node: XmlNode, value: string | undefined) =>
  Effect.gen(function* () {
    if (!value || !/^(?:[\w.-]+:)?[\w.-]+$/.test(value))
      return yield* new WsdlError({ message: "Missing or invalid qualified name" });
    const parts = value.split(":");
    const prefix = parts.length === 2 ? parts[0]! : "";
    const ns = node.namespaces[prefix];
    if (prefix && ns === undefined)
      return yield* new WsdlError({ message: `Unbound namespace prefix ${prefix}` });
    return key(ns ?? "", parts.at(-1)!);
  });

export const one = (node: XmlNode, ns: string, name: string) =>
  Effect.gen(function* () {
    const found = children(node, ns, name);
    if (found.length !== 1)
      return yield* new WsdlError({ message: `Expected exactly one ${name} in ${node.name}` });
    return found[0]!;
  });

export const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
