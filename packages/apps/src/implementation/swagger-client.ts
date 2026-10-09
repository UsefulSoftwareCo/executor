/** Swagger is most of the OpenAPI module's code. Discovery from a cached catalog never needs it,
 * so a cold app Worker evaluates it only when it resolves a document or builds a request.
 */
import "../contracts/swagger-client.ts";

export type SwaggerClient = typeof import("swagger-client").default;
// oxlint-disable-next-line executor/authored-code-through-adapter -- dynamic import
export const loadSwaggerClient = () => import("swagger-client").then((module) => module.default);
