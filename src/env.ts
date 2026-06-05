// Zero-dependency .env loader.
//
// Loads KEY=VALUE pairs from a `.env` in the working directory into process.env
// (never overwriting a value that's already set). This is what makes the project
// "just work" the same way locally, in CI, and inside a Conductor workspace that
// had `.env` copied in via files-to-copy — no `export` dance required.
//
// Imported FIRST by collect.ts / aggregate.ts so the values are present before
// util.ts / crypto.ts read them.

import { readFileSync } from "node:fs";
import { join } from "node:path";

try {
  const text = readFileSync(join(process.cwd(), ".env"), "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  // No .env present — rely on the real environment (CI secrets, shell exports, gh auth).
}
