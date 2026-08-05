const result = { count: 0, startedAtMs: [] };
let database;
try {
  const { DatabaseSync } = await import("node:sqlite");
  database = new DatabaseSync(process.env.PAN_SYNC_DOWNLOAD_START_DATABASE, {
    readOnly: true,
  });
  const rows = database
    .prepare("SELECT started_at_ms FROM download_starts ORDER BY started_at_ms ASC")
    .all();
  result.startedAtMs = rows.map((row) => Number(row.started_at_ms));
  result.count = result.startedAtMs.length;
} catch {
  process.exitCode = 1;
} finally {
  try {
    database?.close();
  } catch {}
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
