/** Narrow declarations for the untyped public swagger-client APIs used by our adapters.
 * Returned data remains unknown and is decoded before it enters Executor.
 */
declare module "swagger-client" {
  const SwaggerClient: {
    buildRequest(options: {
      spec: unknown;
      operationId?: string;
      pathName?: string;
      method?: string;
      parameters?: Readonly<Record<string, unknown>>;
      requestBody?: unknown;
      requestContentType?: string;
      securities?: { authorized: Readonly<Record<string, unknown>> };
    }): unknown;
    resolve(options: {
      spec: unknown;
      skipNormalization: boolean;
      useCircularStructures: boolean;
      requestInterceptor: () => never;
    }): Promise<{ spec: unknown; errors: readonly unknown[] }>;
  };
  export default SwaggerClient;
}
