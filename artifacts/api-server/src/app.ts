import express, { type Request, type Response, type NextFunction } from "express";
import { createLogger } from "hyperagent-lib";
import { a2aRouter } from "./routes/a2a";
import { adminRouter } from "./routes/admin";
import { cronRouter } from "./routes/cron";
import { whopRouter } from "./routes/whop";

const log = createLogger("api");

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  // The Whop webhook needs the raw bytes for HMAC verification, so mount a
  // raw parser for that path *before* the global JSON parser.
  app.use("/api/whop/webhook", express.raw({ type: "*/*", limit: "1mb" }));

  // Everywhere else, parse JSON with a generous limit.
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req: Request, res: Response) => {
    res.json({
      service: "HyperAgent",
      status: "/api/admin/status",
      agentCard: "/.well-known/agent-card.json",
      a2a: "POST /a2a",
      webhook: "POST /api/whop/webhook",
      cron: "GET /api/cron/tick",
    });
  });

  app.use("/", a2aRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/whop", whopRouter);
  app.use("/api/cron", cronRouter);

  // 404 handler.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: "not found" });
  });

  // Central error handler: never leak internals, never crash the server.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error("unhandled request error", { error: err.message });
    res.status(500).json({ ok: false, error: "internal error" });
  });

  return app;
}
