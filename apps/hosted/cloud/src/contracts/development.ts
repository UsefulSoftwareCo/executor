import { Config, Effect, Schema } from "effect";
import { LoopbackOrigin } from "@executor-js/utils/url-policy";

export const cloudDevelopmentOrigin = "https://127.0.0.1:5395";

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
export const cloudDevelopment = Config.all({
  origin: Config.String("BETTER_AUTH_URL"),
  apiPort: Config.Number("CLOUD_DEV_API_PORT").pipe(Config.withDefault(4411)),
  databasePort: Config.Number("CLOUD_DEV_DATABASE_PORT").pipe(Config.withDefault(5441)),
  dashboard: Config.String("CLOUD_DEV_DASHBOARD").pipe(Config.withDefault("source")),
  webPort: Config.Number("CLOUD_DEV_WEB_PORT").pipe(Config.option),
}).pipe(
  Effect.flatMap(
    Schema.decodeUnknownEffect(
      Schema.Struct({
        origin: LoopbackOrigin.check(
          Schema.makeFilter(
            (value) => {
              const url = new URL(value);
              return (
                url.port !== "" &&
                (url.protocol === "https:" ||
                  (url.protocol === "http:" && url.hostname === "localhost"))
              );
            },
            {
              message:
                "Cloud development needs HTTPS or the browser's secure localhost HTTP exception, with an explicit port",
            },
          ),
        ),
        apiPort: Port,
        databasePort: Port,
        dashboard: Schema.Literals(["source", "built"]),
        webPort: Schema.Option(Port),
      }).check(
        Schema.makeFilter(
          (configuration) =>
            configuration.dashboard === "source" ||
            (new URL(configuration.origin).protocol === "http:" &&
              Number(new URL(configuration.origin).port) === configuration.apiPort),
          { message: "Built Cloud previews must use the HTTP Worker listener as their origin" },
        ),
      ),
    ),
  ),
);

export class DevelopmentWebFailed extends Schema.TaggedError<DevelopmentWebFailed>()(
  "DevelopmentWebFailed",
  {
    stage: Schema.Literals(["build", "vite"]),
  },
) {}
