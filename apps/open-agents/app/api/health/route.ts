export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("db") === "1") {
    const { getDbConnectionSnapshot } = await import("../../../lib/db/client");

    return Response.json({
      ok: true,
      dbConnections: await getDbConnectionSnapshot(),
    });
  }

  return Response.json({ ok: true });
}
