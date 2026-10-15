/**
 * Vercel serverless entrypoint.
 *
 * The Express app is exported as the default export, which Vercel's Node
 * runtime invokes as the request handler. `vercel.json` rewrites every path to
 * this function, and Vercel rewrites run only at the proxy layer — the function
 * still receives the *original* path, so Express's own router matches normally
 * (`/`, `/.well-known/agent-card.json`, `/api/admin/*`, `/api/whop/webhook`, …).
 *
 * Vercel functions are ephemeral, so the 24/7 background workers are NOT
 * started here. Deploy the always-on discovery/acquisition loops on a
 * long-running host (Railway, Render or Docker); see README "Deployment".
 */
import { createApp } from "../artifacts/api-server/src/app";

const app = createApp();

export default app;
