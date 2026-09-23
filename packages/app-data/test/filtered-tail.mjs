let buffer = "",
  depth = 0,
  quoted = false,
  escape = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const c of chunk) {
    if (depth === 0 && c !== "{") continue;
    buffer += c;
    if (quoted) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          const event = JSON.parse(buffer);
          if (
            (event.outcome !== "ok" &&
              event.outcome !== "canceled" &&
              event.outcome !== "responseStreamDisconnected") ||
            event.exceptions?.length ||
            event.logs?.some((log) => log.level === "error")
          )
            console.log(
              JSON.stringify({
                outcome: event.outcome,
                exceptions: event.exceptions?.map((x) => ({ name: x.name, message: x.message })),
                errors: event.logs
                  ?.filter((log) => log.level === "error")
                  .map((log) => log.message),
              }),
            );
        } catch {}
        buffer = "";
      }
    }
  }
});
