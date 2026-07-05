import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export type EncryptedSecret = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
};

function getCredentialKey() {
  const raw = process.env.LLM_CRED_ENC_KEY;
  if (!raw) {
    throw new Error("LLM_CRED_ENC_KEY is required for LLM credential encryption");
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("LLM_CRED_ENC_KEY must be a base64-encoded 32-byte key");
  }

  return key;
}

/**
 * Check encryption config WITHOUT encrypting anything. Credential routes must
 * call this BEFORE any side-effecting upstream call (e.g. the paste route's
 * validation refresh rotates the user's refresh token at OpenAI) so a server
 * misconfiguration can never consume a credential and then fail to store it.
 */
export function credentialEncryptionReady(): { ok: true } | { ok: false; error: string } {
  try {
    getCredentialKey();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Credential encryption key is not configured."
    };
  }
}

export function encryptSecret(secret: string): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getCredentialKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return { ciphertext, iv, authTag };
}

export function decryptSecret(encrypted: EncryptedSecret): string {
  const decipher = createDecipheriv(ALGORITHM, getCredentialKey(), encrypted.iv);
  decipher.setAuthTag(encrypted.authTag);

  return Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final()
  ]).toString("utf8");
}
