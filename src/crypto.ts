// AES-256-GCM encryption for the full snapshot, mirroring the github-stats technique.
//
// The full snapshot holds every raw person + event. Even though most of it is
// public on the source platforms, we keep the *aggregated whole* private and only
// publish the curated graph. Only the GitHub Action (which holds ENCRYPTION_KEY)
// can read or write the snapshot.
//
// File layout (binary):  [ 12-byte IV ][ 16-byte auth tag ][ ciphertext ]
// On disk we base64-encode that blob so it diffs/commits cleanly.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY?.trim();
  if (!hex) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
        "then add it as a repository secret (and export it locally to run the collector).",
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be 32 bytes (64 hex chars); got ${key.length} bytes.`);
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(payload: string): string {
  const key = getKey();
  const blob = Buffer.from(payload, "base64");
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/** True when a usable key is present — lets us run aggregation without one. */
export function hasKey(): boolean {
  const hex = process.env.ENCRYPTION_KEY?.trim();
  return !!hex && Buffer.from(hex, "hex").length === 32;
}
