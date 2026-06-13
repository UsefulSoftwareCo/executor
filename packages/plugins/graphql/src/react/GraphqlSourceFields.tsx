import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { Input } from "@executor-js/react/components/input";
import { Textarea } from "@executor-js/react/components/textarea";
import {
  IntegrationIdentityFieldRows,
  type IntegrationIdentity,
} from "@executor-js/react/plugins/integration-identity";

export function GraphqlSourceFields(props: {
  readonly endpoint: string;
  readonly onEndpointChange: (endpoint: string) => void;
  readonly identity: IntegrationIdentity;
  /** The integration's agent-visible description. Blank = the backend falls
   *  back to the introspected schema's own description, then the name. */
  readonly description?: string;
  readonly onDescriptionChange?: (value: string) => void;
  readonly endpointDisabled?: boolean;
  readonly namespaceReadOnly?: boolean;
}) {
  return (
    <CardStack>
      <CardStackContent className="border-t-0">
        <CardStackEntryField
          label="Endpoint"
          hint="The endpoint will be introspected to discover available queries and mutations."
        >
          <Input
            value={props.endpoint}
            onChange={(e) => props.onEndpointChange((e.target as HTMLInputElement).value)}
            placeholder="https://api.example.com/graphql"
            className="font-mono text-sm"
            disabled={props.endpointDisabled}
          />
        </CardStackEntryField>
        <IntegrationIdentityFieldRows
          identity={props.identity}
          namePlaceholder="e.g. Shopify API"
          namespaceReadOnly={props.namespaceReadOnly}
        />
        {props.onDescriptionChange && (
          <CardStackEntryField label="Description">
            <Textarea
              value={props.description ?? ""}
              onChange={(e) => props.onDescriptionChange?.((e.target as HTMLTextAreaElement).value)}
              placeholder="What this API is and when to reach for it"
              rows={2}
              maxRows={6}
              className="text-sm"
            />
            <p className="text-[11px] text-muted-foreground">
              Agent-visible. Leave blank to use the schema's own description when it has one.
            </p>
          </CardStackEntryField>
        )}
      </CardStackContent>
    </CardStack>
  );
}
