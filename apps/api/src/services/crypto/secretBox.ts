import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for secrets held at rest — today, OAuth tokens for
 * business calendar connections.
 *
 * AES-256-GCM with a random 96-bit IV per value. The authentication tag means a
 * tampered ciphertext fails to decrypt rather than silently returning garbage.
 * The key comes from VEYRA_ENCRYPTION_KEY and never appears in the database;
 * plaintext secrets never leave this module's callers, are never logged, and
 * are never sent to a client.
 */

export class EncryptionKeyError extends Error {}
export class DecryptionError extends Error {}

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Reads the key from the environment. base64 or hex, 32 bytes.
 * Generate one with: openssl rand -base64 32
 */
export function encryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.VEYRA_ENCRYPTION_KEY;
  if (!raw) {
    throw new EncryptionKeyError(
      "VEYRA_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`; " +
        "it encrypts stored calendar tokens."
    );
  }
  const decoded = /^[0-9a-fA-F]{64}$/.test(raw.trim())
    ? Buffer.from(raw.trim(), "hex")
    : Buffer.from(raw.trim(), "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new EncryptionKeyError(
      `VEYRA_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${decoded.length}).`
    );
  }
  return decoded;
}

/** True when a usable key is configured. Never reveals the key itself. */
export function encryptionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    encryptionKey(env);
    return true;
  } catch {
    return false;
  }
}

/** Returns "v1.<iv>.<tag>.<ciphertext>", all base64url. */
export function encryptSecret(plaintext: string, env: NodeJS.ProcessEnv = process.env): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new DecryptionError("Stored secret is not in the expected encrypted format.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(env), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch (err) {
    if (err instanceof EncryptionKeyError) throw err;
    // Wrong key, or the value was tampered with. The reason is deliberately
    // vague and carries none of the ciphertext.
    throw new DecryptionError("Stored secret could not be decrypted.");
  }
}

/** Encrypts when a value is present, so optional secrets stay optional. */
export function encryptOptional(value: string | null | undefined, env?: NodeJS.ProcessEnv): string | null {
  return value ? encryptSecret(value, env) : null;
}
