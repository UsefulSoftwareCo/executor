import { useState } from "react";
import { Exit, Option, Predicate } from "effect";
import { defineClientPlugin, createPluginAtomClient, useAtomSet } from "@executor-js/sdk/client";
import { IntegrationSlug } from "@executor-js/sdk/shared";
import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { Textarea } from "@executor-js/react/components/textarea";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  getExecutorApiBaseUrl,
  getExecutorOrganizationHeaders,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";
import { WsdlGroup } from "./group";

const Client = createPluginAtomClient(WsdlGroup, {
  baseUrl: getExecutorApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
  headers: getExecutorOrganizationHeaders,
});
const addAtom = Client.mutation("wsdl", "addIntegration");
function AddWsdl(props: { onComplete: (slug?: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [wsdl, setWsdl] = useState("");
  const [service, setService] = useState("");
  const [port, setPort] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const add = useAtomSet(addAtom, { mode: "promiseExit" });
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    const result = await add({
      payload: {
        name,
        slug: IntegrationSlug.make(slug),
        wsdl,
        service: service || undefined,
        port: port || undefined,
        endpoint: endpoint || undefined,
      },
      reactivityKeys: integrationWriteKeys,
    });
    setBusy(false);
    if (Exit.isFailure(result)) {
      const failure = Exit.findErrorOption(result);
      setError(
        Option.isSome(failure) && Predicate.isTagged(failure.value, "WsdlError")
          ? failure.value.message
          : "Could not add WSDL integration",
      );
      return;
    }
    props.onComplete(result.value.slug);
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Import a self-contained WSDL 1.1 contract using SOAP 1.1 document/literal. External imports,
        SOAP headers, and RPC bindings are not supported.
      </p>
      <Input
        aria-label="Integration name"
        placeholder="Integration name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
      />
      <Input
        aria-label="Namespace"
        placeholder="Namespace (e.g. orders)"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        disabled={busy}
      />
      <Textarea
        aria-label="WSDL contract"
        placeholder="Paste WSDL XML"
        value={wsdl}
        onChange={(e) => setWsdl(e.target.value)}
        rows={12}
        disabled={busy}
      />
      <Input
        aria-label="Service"
        placeholder="Service (required if ambiguous)"
        value={service}
        onChange={(e) => setService(e.target.value)}
        disabled={busy}
      />
      <Input
        aria-label="Port"
        placeholder="Port (required if ambiguous)"
        value={port}
        onChange={(e) => setPort(e.target.value)}
        disabled={busy}
      />
      <Input
        aria-label="Endpoint override"
        placeholder="Endpoint override (optional)"
        value={endpoint}
        onChange={(e) => setEndpoint(e.target.value)}
        disabled={busy}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          disabled={busy || !name.trim() || !/^[a-z][a-z0-9_-]*$/.test(slug) || !wsdl.trim()}
          onClick={submit}
        >
          {busy ? "Importing…" : "Add WSDL integration"}
        </Button>
        <Button variant="outline" disabled={busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
export default defineClientPlugin({
  id: "wsdl" as const,
  integrationPlugin: { key: "wsdl", label: "WSDL / SOAP", add: AddWsdl },
});
