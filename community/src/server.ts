import { serve } from "@hono/node-server";
import { join } from "node:path";
import { readConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { createApp } from "./app.js";
const config = readConfig();
const db = openDb(join(config.dataDir, "community.sqlite"));
const server = serve(
  {
    fetch: createApp(config, db).fetch,
    port: config.port,
    hostname: "127.0.0.1",
  },
  () =>
    console.log(
      JSON.stringify({ level: "info", event: "listening", port: config.port }),
    ),
);
process.on("SIGTERM", () =>
  server.close(() => {
    db.close();
    process.exit(0);
  }),
);
process.on("SIGINT", () =>
  server.close(() => {
    db.close();
    process.exit(0);
  }),
);
