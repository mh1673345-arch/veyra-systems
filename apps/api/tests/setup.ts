import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { beforeEach } from "vitest";
import { assertDatabaseEnvironment } from "../src/config/database.js";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// .env first for shared defaults, then .env.test *with override* so the suite
// is pinned to the test database before anything constructs a PrismaClient.
// Importing @prisma/client later re-reads .env, but dotenv does not overwrite
// variables that are already set, so DATABASE_URL stays on the test database.
dotenv.config({ path: path.join(apiRoot, ".env") });
dotenv.config({ path: path.join(apiRoot, ".env.test"), override: true });

process.env.NODE_ENV = "test";

if (!process.env.VEYRA_API_KEY) {
  process.env.VEYRA_API_KEY = "test-key";
}

// Fails the whole run rather than letting a misconfigured suite touch dev data.
assertDatabaseEnvironment();

// Strip every real provider key picked up from a developer's local .env, so
// the suite never depends on — or pays for — a live vendor call. This has to
// be a beforeEach (not a one-off statement here) because importing
// @prisma/client triggers its own dotenv reload of .env at module-import time,
// which runs after this file's top level but before each test body; a plain
// delete() here gets silently undone. Tests that specifically exercise a
// provider path set their own dummy key and mock the SDK.
//
// Speech and telephony keys are included for the same reason, and because a
// test that quietly reached a real vendor would also be non-deterministic:
// the moment a real ElevenLabs key appeared in .env, a Phase 13 voice test
// started failing because it was genuinely calling ElevenLabs.
// The Google OAuth trio is here for a second reason as well as secrecy: a
// suite that inherits real credentials is no longer testing the unconfigured
// server it thinks it is. The calendar tests supply their own dummy values
// around the cases that need Google configured.
const REAL_PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "DEEPGRAM_API_KEY",
  "ELEVENLABS_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  // Without these the suite would build a real Resend provider from the
  // developer's own .env and mail an actual inbox from a unit test.
  "VEYRA_EMAIL_PROVIDER",
  "RESEND_API_KEY",
  "VEYRA_EMAIL_FROM",
  "VEYRA_EMAIL_REPLY_TO",
  "RESEND_API_URL",
  // Without these a test that selects the "meta" provider would build a real
  // one from the developer's own .env and send an actual WhatsApp message.
  "META_WHATSAPP_ACCESS_TOKEN",
  "META_WHATSAPP_PHONE_NUMBER_ID",
  "META_WHATSAPP_BUSINESS_ACCOUNT_ID",
  "META_WHATSAPP_VERIFY_TOKEN",
  "META_GRAPH_URL",
  "META_GRAPH_VERSION"
];

beforeEach(() => {
  for (const key of REAL_PROVIDER_KEYS) delete process.env[key];
});
