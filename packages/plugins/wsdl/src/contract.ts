import { Effect } from "effect";
import {
  children,
  key,
  one,
  parseXml,
  qname,
  SOAP,
  WSDL,
  WsdlError,
  XSD,
  type XmlNode,
} from "./xml";

export interface ElementShape {
  readonly name: string;
  readonly ns: string;
  readonly min: number;
  readonly max: number;
  readonly nullable: boolean;
  readonly kind: "string" | "boolean" | "int" | "decimal" | "integer" | "object";
  readonly fields: readonly ElementShape[];
}
export interface WsdlOperation {
  readonly name: string;
  readonly action: string;
  readonly input: ElementShape;
  readonly output: ElementShape;
}
export interface WsdlContract {
  readonly service: string;
  readonly port: string;
  readonly endpoint: string;
  readonly operations: readonly WsdlOperation[];
}
export interface WsdlSelection {
  readonly service?: string;
  readonly port?: string;
  readonly endpoint?: string;
}

export const parseWsdl = (
  xml: string,
  selection: WsdlSelection = {},
): Effect.Effect<WsdlContract, WsdlError> =>
  Effect.gen(function* () {
    const root = yield* parseXml(xml);
    if (root.ns !== WSDL || root.name !== "definitions")
      return yield* new WsdlError({ message: "Expected WSDL 1.1 definitions" });
    const all = (node: XmlNode): XmlNode[] => [node, ...node.children.flatMap(all)];
    for (const node of all(root)) {
      if (
        (node.ns === WSDL && node.name === "import") ||
        (node.ns === XSD && ["import", "include", "redefine"].includes(node.name))
      )
        return yield* new WsdlError({
          message: "External WSDL/XSD imports are not supported; supply a self-contained contract",
        });
      if (node.attrs[key(WSDL, "required")] === "true" || node.attrs[key(WSDL, "required")] === "1")
        return yield* new WsdlError({ message: "Required WSDL extensions are not supported" });
    }
    const namespace = root.attrs.targetNamespace ?? "";
    const symbols = new Map<string, XmlNode>();
    const schemas = new Map<XmlNode, XmlNode>();
    for (const node of root.children) {
      if (node.ns !== WSDL || !node.attrs.name) continue;
      const id = `${node.name}:${key(namespace, node.attrs.name)}`;
      if (symbols.has(id)) return yield* new WsdlError({ message: `Duplicate WSDL symbol ${id}` });
      symbols.set(id, node);
    }
    for (const types of children(root, WSDL, "types"))
      for (const schema of children(types, XSD, "schema")) {
        for (const node of schema.children) {
          if (node.name === "annotation") continue;
          if (
            node.ns !== XSD ||
            !["element", "complexType"].includes(node.name) ||
            !node.attrs.name
          )
            return yield* new WsdlError({ message: `Unsupported schema declaration ${node.name}` });
          const id = `${node.name}:${key(schema.attrs.targetNamespace ?? "", node.attrs.name)}`;
          if (symbols.has(id))
            return yield* new WsdlError({ message: `Duplicate schema symbol ${id}` });
          symbols.set(id, node);
          for (const descendant of all(node)) schemas.set(descendant, schema);
        }
      }
    const resolve = (kind: string, node: XmlNode, attr: string) =>
      Effect.gen(function* () {
        const id = `${kind}:${yield* qname(node, node.attrs[attr])}`;
        const target = symbols.get(id);
        if (!target) return yield* new WsdlError({ message: `Unresolved ${id}` });
        return target;
      });
    let expandedElements = 0;
    const shape = (node: XmlNode, depth = 0): Effect.Effect<ElementShape, WsdlError> =>
      Effect.gen(function* () {
        if (
          (node.attrs.minOccurs !== undefined && !/^\d+$/.test(node.attrs.minOccurs)) ||
          (node.attrs.maxOccurs !== undefined &&
            node.attrs.maxOccurs !== "unbounded" &&
            !/^\d+$/.test(node.attrs.maxOccurs))
        )
          return yield* new WsdlError({ message: "Invalid occurrence bounds" });
        if (++expandedElements > 10_000)
          return yield* new WsdlError({ message: "Expanded schema exceeds 10000 elements" });
        if (depth > 32)
          return yield* new WsdlError({
            message: "Recursive or deeply nested XSD types are not supported",
          });
        if (
          node.children.some(
            (child) => child.ns !== XSD || !["annotation", "complexType"].includes(child.name),
          )
        )
          return yield* new WsdlError({ message: "Unsupported element schema content" });
        if (node.attrs.type && children(node, XSD, "complexType").length)
          return yield* new WsdlError({
            message: "Element cannot declare both type and inline complexType",
          });
        if (node.attrs.ref) {
          const target = yield* resolve("element", node, "ref");
          const resolved = yield* shape(target, depth + 1);
          const min = Number(node.attrs.minOccurs ?? "1");
          const max =
            node.attrs.maxOccurs === "unbounded" ? 10_000 : Number(node.attrs.maxOccurs ?? "1");
          if (
            !Number.isInteger(min) ||
            !Number.isInteger(max) ||
            min < 0 ||
            max < min ||
            max > 10_000
          )
            return yield* new WsdlError({ message: "Unsupported occurrence bounds" });
          return { ...resolved, min, max };
        }
        for (const attr of ["default", "fixed", "substitutionGroup", "abstract"])
          if (node.attrs[attr] !== undefined)
            return yield* new WsdlError({ message: `Unsupported XSD element attribute ${attr}` });
        const schema = schemas.get(node);
        // Global references retain the namespace of their declaration.
        const owningSchema = schema;
        const global = [...symbols.values()].includes(node);
        const ns =
          global || (node.attrs.form ?? owningSchema?.attrs.elementFormDefault) === "qualified"
            ? (owningSchema?.attrs.targetNamespace ?? "")
            : "";
        const min = Number(node.attrs.minOccurs ?? "1");
        const max =
          node.attrs.maxOccurs === "unbounded" ? 10_000 : Number(node.attrs.maxOccurs ?? "1");
        if (
          !Number.isInteger(min) ||
          !Number.isInteger(max) ||
          min < 0 ||
          max < min ||
          max > 10_000
        )
          return yield* new WsdlError({ message: "Unsupported occurrence bounds" });
        if (!node.attrs.name) return yield* new WsdlError({ message: "Element name is required" });
        let kind: ElementShape["kind"] = "object";
        let complex: XmlNode | undefined;
        if (node.attrs.type) {
          const type = yield* qname(node, node.attrs.type);
          const primitive = ["string", "boolean", "int", "decimal", "integer"].find(
            (value) => type === key(XSD, value),
          );
          if (
            primitive === "string" ||
            primitive === "boolean" ||
            primitive === "int" ||
            primitive === "decimal" ||
            primitive === "integer"
          )
            kind = primitive;
          else complex = yield* resolve("complexType", node, "type");
        } else complex = yield* one(node, XSD, "complexType");
        const fields: ElementShape[] = [];
        if (complex) {
          if (complex.attrs.mixed && complex.attrs.mixed !== "false")
            return yield* new WsdlError({ message: "Mixed XSD content is unsupported" });
          if (
            complex.children.some(
              (child) => child.ns !== XSD || !["sequence", "annotation"].includes(child.name),
            )
          )
            return yield* new WsdlError({
              message: "Only XSD sequence complex types are supported",
            });
          const sequences = children(complex, XSD, "sequence");
          if (sequences.length > 1)
            return yield* new WsdlError({ message: "Multiple sequences are unsupported" });
          const sequence = sequences[0];
          if (sequence) {
            if (
              (sequence.attrs.minOccurs ?? "1") !== "1" ||
              (sequence.attrs.maxOccurs ?? "1") !== "1"
            )
              return yield* new WsdlError({
                message: "Repeated/optional sequences are unsupported",
              });
            for (const field of sequence.children) {
              if (field.ns === XSD && field.name === "annotation") continue;
              if (field.ns !== XSD || field.name !== "element")
                return yield* new WsdlError({ message: `Unsupported XSD construct ${field.name}` });
              const parsed = yield* shape(field, depth + 1);
              if (fields.some((existing) => existing.name === parsed.name))
                return yield* new WsdlError({ message: "Duplicate field names are unsupported" });
              fields.push(parsed);
            }
          }
        }
        return {
          name: node.attrs.name,
          ns,
          min,
          max,
          nullable: ["true", "1"].includes(node.attrs.nillable ?? ""),
          kind,
          fields,
        };
      });
    const ports = children(root, WSDL, "service").flatMap((service) =>
      children(service, WSDL, "port").map((port) => ({ service, port })),
    );
    const matches = ports.filter(
      ({ service, port }) =>
        (!selection.service || selection.service === service.attrs.name) &&
        (!selection.port || selection.port === port.attrs.name),
    );
    if (matches.length !== 1)
      return yield* new WsdlError({
        message: `Select exactly one service and port. Available: ${ports.map(({ service, port }) => `${service.attrs.name}/${port.attrs.name}`).join(", ")}`,
      });
    const { service, port } = matches[0]!;
    const binding = yield* resolve("binding", port, "binding");
    const soapBinding = yield* one(binding, SOAP, "binding");
    if (
      (soapBinding.attrs.style ?? "document") !== "document" ||
      soapBinding.attrs.transport !== "http://schemas.xmlsoap.org/soap/http"
    )
      return yield* new WsdlError({
        message: "Only SOAP 1.1 document/literal HTTP bindings are supported",
      });
    const portType = yield* resolve("portType", binding, "type");
    const address = yield* one(port, SOAP, "address");
    const endpoint = selection.endpoint ?? address.attrs.location ?? "";
    const url = yield* Effect.try({
      try: () => new URL(endpoint),
      catch: () => new WsdlError({ message: "Invalid SOAP endpoint URL" }),
    });
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      return yield* new WsdlError({
        message: "SOAP endpoint must be an HTTP(S) URL without credentials or fragment",
      });
    const operations: WsdlOperation[] = [];
    for (const bound of children(binding, WSDL, "operation")) {
      const name = bound.attrs.name ?? "";
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || operations.some((op) => op.name === name))
        return yield* new WsdlError({ message: "Unsupported or duplicate operation name" });
      const abstract = children(portType, WSDL, "operation").filter((op) => op.attrs.name === name);
      if (abstract.length !== 1)
        return yield* new WsdlError({ message: `Ambiguous or missing operation ${name}` });
      const directions = abstract[0]!.children.filter(
        (node) => node.ns === WSDL && ["input", "output"].includes(node.name),
      );
      if (
        directions.length !== 2 ||
        directions[0]!.name !== "input" ||
        directions[1]!.name !== "output"
      )
        return yield* new WsdlError({ message: "Only request/response operations are supported" });
      const soapOperation = yield* one(bound, SOAP, "operation");
      if ((soapOperation.attrs.style ?? soapBinding.attrs.style ?? "document") !== "document")
        return yield* new WsdlError({ message: "RPC operations are unsupported" });
      const action = soapOperation.attrs.soapAction;
      if (action === undefined || /["\r\n]/.test(action))
        return yield* new WsdlError({ message: "Missing or invalid SOAPAction" });
      const messageShape = (direction: string) =>
        Effect.gen(function* () {
          const concrete = yield* one(bound, WSDL, direction);
          if (concrete.children.some((child) => child.ns !== SOAP || child.name !== "body"))
            return yield* new WsdlError({
              message: "SOAP headers and attachments are unsupported",
            });
          const body = yield* one(concrete, SOAP, "body");
          if (body.attrs.use !== "literal" || body.attrs.encodingStyle)
            return yield* new WsdlError({ message: "SOAP encoded bodies are unsupported" });
          const message = yield* resolve(
            "message",
            yield* one(abstract[0]!, WSDL, direction),
            "message",
          );
          if (body.attrs.parts !== undefined && body.attrs.parts.trim().split(/\s+/).length !== 1)
            return yield* new WsdlError({
              message: "SOAP body must select exactly one named part",
            });
          const parts = children(message, WSDL, "part").filter(
            (part) => body.attrs.parts === undefined || body.attrs.parts.trim() === part.attrs.name,
          );
          if (parts.length !== 1 || !parts[0]!.attrs.element)
            return yield* new WsdlError({
              message: "SOAP body must select exactly one element part",
            });
          return yield* shape(yield* resolve("element", parts[0]!, "element"));
        });
      operations.push({
        name,
        action,
        input: yield* messageShape("input"),
        output: yield* messageShape("output"),
      });
    }
    if (!operations.length) return yield* new WsdlError({ message: "No supported operations" });
    return { service: service.attrs.name ?? "", port: port.attrs.name ?? "", endpoint, operations };
  });
