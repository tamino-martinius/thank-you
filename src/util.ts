// Small shared helpers: a resilient GitHub REST client with pagination + retry,
// and generic fetch utilities used by the other collectors.

/** Plain intermediate written by collect.ts, read by aggregate.ts (gitignored). */
export const SNAPSHOT_PATH = "data/snapshot.json";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

const GH_TOKEN = process.env.GH_PAT || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

interface GhOptions {
  /** Send the star+json media type to receive `starred_at` timestamps. */
  starred?: boolean;
}

/**
 * GET a single GitHub REST page. Handles secondary-rate-limit / abuse retries
 * with exponential backoff and respects the `Retry-After` header.
 */
async function ghGet(url: string, opts: GhOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": "thank-you-collector",
    Accept: opts.starred
      ? "application/vnd.github.star+json"
      : "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`;

  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const remaining = res.headers.get("x-ratelimit-remaining"); // string | null
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      // A 403 that ISN'T rate-limited (bad/expired token, "resource not accessible")
      // won't fix itself — return it so the caller surfaces the real error fast.
      const isRateLimit = res.status === 429 || retryAfter > 0 || remaining === "0";
      if (!isRateLimit) return res;
      let waitMs = retryAfter ? retryAfter * 1000 : 2 ** attempt * 1000;
      if (!retryAfter && remaining === "0" && reset) {
        waitMs = Math.max(0, reset * 1000 - Date.now()) + 1000;
      }
      log(`Rate limited on ${url} — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1})`);
      await sleep(waitMs);
      continue;
    }
    return res;
  }
  throw new Error(`GitHub request failed after retries: ${url}`);
}

/** Follow Link: rel="next" pagination, returning every item across all pages. */
export async function ghPaginate<T = any>(path: string, opts: GhOptions = {}): Promise<T[]> {
  let url: string | null = path.startsWith("http")
    ? path
    : `https://api.github.com${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  const out: T[] = [];
  while (url) {
    const res = await ghGet(url, opts);
    if (res.status === 404) break;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub ${res.status} for ${url}: ${body.slice(0, 200)}`);
    }
    const page = (await res.json()) as T[];
    out.push(...page);
    const link = res.headers.get("link") || "";
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return out;
}

export async function ghJson<T = any>(path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const res = await ghGet(url);
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
  return (await res.json()) as T;
}

export function hasGithubToken(): boolean {
  return !!GH_TOKEN;
}

/**
 * POST a GitHub GraphQL query. Used to fetch per-repo languages *with their
 * linguist colours* — the REST API exposes neither colours nor a clean
 * multi-language list. Mirrors the technique from node-github-graphql-api.
 */
export async function ghGraphQL<T = any>(query: string): Promise<T> {
  const headers: Record<string, string> = {
    "User-Agent": "thank-you-collector",
    "Content-Type": "application/json",
  };
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    });
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      await sleep(2 ** attempt * 1000);
      continue;
    }
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      // Partial data is common with aliased batches (one bad repo); keep what we got.
      log(`GraphQL warning: ${json.errors[0].message}`);
    }
    if (json.data) return json.data;
    await sleep(2 ** attempt * 1000);
  }
  throw new Error("GitHub GraphQL request failed after retries");
}

/** Plain text fetch with a friendly UA — used for RSS/Atom feeds. */
export async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "thank-you-collector" } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
