import { describe, expect, it } from "vitest";
import { isGoogleDiscovery, convertGoogleDiscoveryToOpenApi } from "./discovery";

describe("Google Discovery Converter", () => {
  it("identifies Google Discovery docs", () => {
    expect(isGoogleDiscovery({ discoveryVersion: "v1", rootUrl: "https://example.com" })).toBe(true);
    expect(isGoogleDiscovery({ openapi: "3.0.0" })).toBe(false);
  });

  it("converts a basic Google Discovery document to OpenAPI", () => {
    const discoveryDoc = {
      discoveryVersion: "v1",
      name: "calendar",
      version: "v3",
      title: "Calendar API",
      description: "Lets you manipulate events and other calendar data.",
      rootUrl: "https://www.googleapis.com/",
      servicePath: "calendar/v3/",
      auth: {
        oauth2: {
          scopes: {
            "https://www.googleapis.com/auth/calendar": {
              description: "See, edit, share, and permanently delete all the calendars you can access using Google Calendar",
            },
          },
        },
      },
      schemas: {
        Event: {
          type: "object",
          properties: {
            id: { type: "string", description: "Opaque identifier of the event" },
            status: { type: "string", description: "Status of the event", enum: ["confirmed", "tentative", "cancelled"] },
          },
        },
      },
      resources: {
        events: {
          methods: {
            get: {
              id: "calendar.events.get",
              path: "calendars/{calendarId}/events/{eventId}",
              httpMethod: "GET",
              description: "Returns an event based on its Google Calendar ID.",
              parameters: {
                calendarId: {
                  type: "string",
                  description: "Calendar identifier.",
                  required: true,
                  location: "path",
                },
                eventId: {
                  type: "string",
                  description: "Event identifier.",
                  required: true,
                  location: "path",
                },
              },
              response: {
                $ref: "Event",
              },
              scopes: ["https://www.googleapis.com/auth/calendar"],
            },
            insert: {
              id: "calendar.events.insert",
              path: "calendars/{calendarId}/events",
              httpMethod: "POST",
              description: "Creates an event.",
              parameters: {
                calendarId: {
                  type: "string",
                  description: "Calendar identifier.",
                  required: true,
                  location: "path",
                },
              },
              request: {
                $ref: "Event",
              },
              response: {
                $ref: "Event",
              },
              scopes: ["https://www.googleapis.com/auth/calendar"],
            },
          },
        },
      },
    };

    const openapi = convertGoogleDiscoveryToOpenApi(discoveryDoc);

    expect(openapi.openapi).toBe("3.0.3");
    expect(openapi.info.title).toBe("Calendar API");
    expect(openapi.servers![0].url).toBe("https://www.googleapis.com/calendar/v3/");

    // Check schemas
    const eventSchema = openapi.components!.schemas!.Event as any;
    expect(eventSchema.type).toBe("object");
    expect(eventSchema.properties.id.type).toBe("string");

    // Check paths
    const getOp = openapi.paths["/calendars/{calendarId}/events/{eventId}"]!.get!;
    expect(getOp.operationId).toBe("calendar.events.get");
    expect(getOp.parameters).toHaveLength(2);
    expect(getOp.parameters![0]).toMatchObject({
      name: "calendarId",
      in: "path",
      required: true,
    });
    
    // Check request body for POST
    const postOp = openapi.paths["/calendars/{calendarId}/events"]!.post!;
    expect(postOp.requestBody).toBeDefined();
    
    // Check security
    expect(openapi.components!.securitySchemes!.oauth2).toBeDefined();
    expect(openapi.security).toEqual([{ oauth2: ["https://www.googleapis.com/auth/calendar"] }]);
  });
});
