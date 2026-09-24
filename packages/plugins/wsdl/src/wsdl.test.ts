import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { parseWsdl, wsdlPlugin } from "./index";
import { decodeEnvelope, encodeElement, jsonSchema } from "./codec";
import { ordersWsdl } from "./fixture";

const envelope = (body: string) =>
  `<e:Envelope xmlns:e="http://schemas.xmlsoap.org/soap/envelope/"><e:Body>${body}</e:Body></e:Envelope>`;
describe("WSDL support", () => {
  it.effect("resolves namespace-aware operations and escapes XML input", () =>
    Effect.gen(function* () {
      const contract = yield* parseWsdl(ordersWsdl);
      expect(contract.service).toBe("Orders");
      const op = contract.operations[0]!;
      expect(op.action).toBe("urn:getOrder");
      expect(yield* encodeElement(op.input, { id: '<&"' })).toBe(
        '<GetOrder xmlns="urn:orders"><id xmlns="urn:orders">&lt;&amp;&quot;</id></GetOrder>',
      );
      expect(jsonSchema(op.input)).toMatchObject({
        type: "object",
        required: ["id"],
        additionalProperties: false,
      });
    }),
  );
  it.effect("decodes arbitrary prefixes and preserves decimal precision", () =>
    Effect.gen(function* () {
      const contract = yield* parseWsdl(ordersWsdl);
      const decoded = yield* decodeEnvelope(
        contract.operations[0]!.output,
        envelope(
          '<o:GetOrderResponse xmlns:o="urn:orders"><o:total>9007199254740993.12</o:total><o:paid>1</o:paid></o:GetOrderResponse>',
        ),
      );
      expect(decoded).toEqual({ ok: true, value: { total: "9007199254740993.12", paid: true } });
    }),
  );
  it.effect("classifies SOAP faults", () =>
    Effect.gen(function* () {
      const contract = yield* parseWsdl(ordersWsdl);
      expect(
        yield* decodeEnvelope(
          contract.operations[0]!.output,
          envelope(
            "<e:Fault><faultcode>e:Server</faultcode><faultstring>Order unavailable</faultstring></e:Fault>",
          ),
        ),
      ).toEqual({ ok: false, fault: { code: "e:Server", message: "Order unavailable" } });
    }),
  );
  it.effect("rejects missing inputs and unexpected response namespaces/order", () =>
    Effect.gen(function* () {
      const {
        operations: [op],
      } = yield* parseWsdl(ordersWsdl);
      expect(Exit.isFailure(yield* Effect.exit(encodeElement(op!.input, {})))).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            decodeEnvelope(
              op!.output,
              envelope(
                '<GetOrderResponse xmlns="urn:wrong"><total>1</total><paid>true</paid></GetOrderResponse>',
              ),
            ),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            decodeEnvelope(
              op!.output,
              envelope(
                '<GetOrderResponse xmlns="urn:orders"><paid>true</paid><total>1</total></GetOrderResponse>',
              ),
            ),
          ),
        ),
      ).toBe(true);
    }),
  );
  for (const [name, document] of [
    ["DTD", '<!DOCTYPE x [<!ENTITY a "boom">]>' + ordersWsdl],
    ["RPC", ordersWsdl.replace('style="document"', 'style="rpc"')],
    ["encoding", ordersWsdl.replace('use="literal"', 'use="encoded"')],
    [
      "imports",
      ordersWsdl.replace(
        "<w:types>",
        '<w:import namespace="urn:other" location="https://example.com/other"/><w:types>',
      ),
    ],
    ["choice", ordersWsdl.replaceAll("x:sequence", "x:choice")],
    ["unknown type", ordersWsdl.replace('type="x:string"', 'type="x:anyType"')],
    ["unknown prefix", ordersWsdl.replace('element="t:GetOrder"', 'element="missing:GetOrder"')],
  ])
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        expect(Exit.isFailure(yield* Effect.exit(parseWsdl(document!)))).toBe(true);
      }),
    );
  it.effect("requires selection when multiple ports exist", () =>
    Effect.gen(function* () {
      const document = ordersWsdl.replace(
        "</w:service>",
        '<w:port name="Other" binding="t:OrdersBinding"><s:address location="https://example.com/other"/></w:port></w:service>',
      );
      expect(Exit.isFailure(yield* Effect.exit(parseWsdl(document)))).toBe(true);
      expect((yield* parseWsdl(document, { port: "Other" })).endpoint).toBe(
        "https://example.com/other",
      );
    }),
  );
  it.effect("registers an integration and materializes connection tools", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), wsdlPlugin()] as const }),
      );
      const added = yield* executor.wsdl.addIntegration({
        slug: IntegrationSlug.make("orders"),
        name: "Orders",
        wsdl: ordersWsdl,
      });
      expect(added.toolCount).toBe(1);
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("orders"),
        template: AuthTemplateSlug.make("none"),
        values: {},
      });
      const tools = yield* executor.tools.list({ integration: IntegrationSlug.make("orders") });
      expect(tools.map((tool) => String(tool.name))).toEqual(["GetOrder"]);
    }),
  );
  it.effect("preserves references, repetition, absence, and nil", () =>
    Effect.gen(function* () {
      const document = ordersWsdl
        .replace(
          '<x:element name="GetOrder">',
          '<x:element name="item" type="x:string" nillable="true"/><x:element name="GetOrder">',
        )
        .replace(
          '<x:element name="id" type="x:string"/>',
          '<x:element ref="t:item" minOccurs="0" maxOccurs="3"/>',
        );
      const contract = yield* parseWsdl(document);
      const input = contract.operations[0]!.input;
      expect(yield* encodeElement(input, {})).toBe('<GetOrder xmlns="urn:orders"></GetOrder>');
      expect(yield* encodeElement(input, { item: ["one", null] })).toContain(
        '<item xmlns="urn:orders" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true"/>',
      );
      expect(
        yield* decodeEnvelope(
          input,
          envelope(
            '<GetOrder xmlns="urn:orders"><item>one</item><item xmlns:i="http://www.w3.org/2001/XMLSchema-instance" i:nil="1"/></GetOrder>',
          ),
        ),
      ).toEqual({ ok: true, value: { item: ["one", null] } });
      expect(
        Exit.isFailure(yield* Effect.exit(encodeElement(input, { item: ["1", "2", "3", "4"] }))),
      ).toBe(true);
    }),
  );
  it.effect("rejects malformed XML, excessive nesting, and unsupported inline restrictions", () =>
    Effect.gen(function* () {
      expect(
        Exit.isFailure(yield* Effect.exit(parseWsdl(ordersWsdl.replace("</w:definitions>", "")))),
      ).toBe(true);
      expect(
        Exit.isFailure(yield* Effect.exit(parseWsdl("<a>".repeat(65) + "</a>".repeat(65)))),
      ).toBe(true);
      const restricted = ordersWsdl.replace(
        '<x:element name="id" type="x:string"/>',
        '<x:element name="id"><x:simpleType><x:restriction base="x:string"><x:pattern value="a+"/></x:restriction></x:simpleType></x:element>',
      );
      expect(Exit.isFailure(yield* Effect.exit(parseWsdl(restricted)))).toBe(true);
    }),
  );
  it.effect("does not replace an existing integration on duplicate registration", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [wsdlPlugin()] as const }));
      const input = { slug: IntegrationSlug.make("orders"), name: "Orders", wsdl: ordersWsdl };
      yield* executor.wsdl.addIntegration(input);
      expect(
        Exit.isFailure(
          yield* Effect.exit(executor.wsdl.addIntegration({ ...input, name: "Replacement" })),
        ),
      ).toBe(true);
      expect((yield* executor.integrations.get(input.slug))?.name).toBe("Orders");
    }),
  );
});
