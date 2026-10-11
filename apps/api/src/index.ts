import "dotenv/config";
import { createApp } from "./app.js";
import { assertDatabaseEnvironment, currentEnvironment } from "./config/database.js";
import { validateStartupConfig } from "./config/startup.js";
import { pruneDeadSessions } from "./services/auth/sessions.js";
import { pruneExpiredResetTokens } from "./services/auth/passwords.js";
import { startNotificationWorker } from "./services/notifications/worker.js";
import { attachMediaBridge, mediaBridgeEnabled } from "./services/voice/media/bridge.js";

// Fail fast rather than starting against the wrong database or with unsafe
// production configuration.
assertDatabaseEnvironment();
const config = validateStartupConfig();
for (const warning of config.warnings) {
  console.warn("[veyra:config] %s", warning);
}

const port = Number(process.env.PORT ?? 4000);
const app = createApp();

// Clear out sessions and reset tokens that are already dead. Doing this at
// startup (and after each login) avoids a background timer that could fail
// silently; active sessions are never touched.
void Promise.all([pruneDeadSessions(), pruneExpiredResetTokens()])
  .then(([sessions, tokens]) => {
    if (sessions || tokens) {
      console.log(`Pruned ${sessions} dead session(s) and ${tokens} spent reset token(s)`);
    }
  })
  .catch((err) => console.error("Startup pruning failed", err));

// The notification worker runs in-process for now. It claims work atomically,
// so running several instances is safe, and a failure inside it can never take
// the API down.
const worker =
  process.env.VEYRA_DISABLE_WORKER === "1" ? null : startNotificationWorker();

const server = app.listen(port, () => {
  console.log(
    `Veyra Reception API listening on http://localhost:${port} ` +
      `(${currentEnvironment()}, responder=${config.anthropic}, email=${config.email})`
  );
});

// Carrier audio arrives over a WebSocket upgrade, not an HTTP request, so the
// media bridge attaches to the server rather than to Express. It accepts one
// path and refuses every other upgrade.
const mediaBridge = mediaBridgeEnabled()
  ? attachMediaBridge(server)
  : (console.warn("[veyra:voice] media bridge disabled: production needs VEYRA_PUBLIC_API_URL on https"), null);

function shutdown(signal: string) {
  console.log("Received %s, shutting down", signal);
  worker?.stop();
  void mediaBridge?.close();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
