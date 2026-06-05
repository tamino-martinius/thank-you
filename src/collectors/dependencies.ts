// Dependency collector — "the shoulders I stand on".
//
// Reads the package.json of every one of my repos, tallies which libraries I
// depend on, resolves each npm package to its GitHub repo (via the npm registry's
// `repository` field), and fetches stars + maintainer + last-push date.
//
// Two degrees of gratitude:
//   1. direct      — libraries my repos list outright.
//   2. second-grade — the dependencies of those libraries: the foundation under my
//      foundation. Bounded to the most-pulled-in ones so it stays a thank-you, not an SBOM.

import type { RawDependency, RawPerson } from "../types.js";
import { ghJson, log } from "../util.js";

interface GhUser { id: number; login: string; name?: string | null; avatar_url: string; html_url: string; }
interface GhRepoInfo {
  full_name: string; html_url: string; fork: boolean; pushed_at: string | null;
  stargazers_count: number; language: string | null; description: string | null; owner: GhUser;
}

const toPerson = (u: GhUser): RawPerson => ({
  id: `github:${u.id}`, source: "github", login: u.login,
  name: u.name ?? null, avatar: u.avatar_url, url: u.html_url, externalId: u.id,
});

const npmId = (pkg: string) => (pkg.startsWith("@") ? pkg.replace("/", "%2F") : pkg);

/** Read a repo's package.json → its dependency / devDependency names. */
async function readManifest(username: string, repo: string): Promise<{ deps: string[]; dev: string[] } | null> {
  try {
    const file = await ghJson<{ content?: string; encoding?: string }>(
      `/repos/${username}/${repo}/contents/package.json`,
    );
    if (!file?.content) return null;
    const json = JSON.parse(Buffer.from(file.content, (file.encoding as BufferEncoding) || "base64").toString("utf8"));
    return { deps: Object.keys(json.dependencies ?? {}), dev: Object.keys(json.devDependencies ?? {}) };
  } catch {
    return null; // no package.json, or unparseable
  }
}

/** npm package → "owner/repo" on GitHub (handles scopes, git+https, github: shorthand). */
async function resolveNpm(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${npmId(pkg)}`, { headers: { "User-Agent": "thank-you-collector" } });
    if (!res.ok) return null;
    const j = (await res.json()) as { repository?: string | { url?: string } };
    const raw = typeof j.repository === "string" ? j.repository : j.repository?.url;
    if (!raw) return null;
    // Repo name may contain dots (socket.io, three.js); take it whole, then trim `.git` / `#fragment`.
    const m = String(raw).match(/github\.com[:/]+([^/]+)\/([^/#?]+)/i) || String(raw).match(/^github:([^/]+)\/([^/#?]+)/i);
    return m ? `${m[1]}/${m[2].replace(/\.git$/i, "")}` : null;
  } catch {
    return null;
  }
}

/** The runtime dependencies of a package's latest version (for second-grade expansion). */
async function npmRuntimeDeps(pkg: string): Promise<string[]> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${npmId(pkg)}/latest`, { headers: { "User-Agent": "thank-you-collector" } });
    if (!res.ok) return [];
    const j = (await res.json()) as { dependencies?: Record<string, string> };
    return Object.keys(j.dependencies ?? {});
  } catch {
    return [];
  }
}

export async function collectDependencies(cfg: {
  username: string;
  repos: string[];
  starred: Set<string>; // lowercased full_names I already starred
  includeTransitive?: boolean;
  transitiveLimit?: number;
}): Promise<RawDependency[]> {
  const me = cfg.username.toLowerCase();
  const npmCache = new Map<string, string | null>();
  const resolvedMiss = new Set<string>();
  const repoCache = new Map<string, GhRepoInfo | null>();

  const repoInfo = async (full: string): Promise<GhRepoInfo | null> => {
    const key = full.toLowerCase();
    if (repoCache.has(key)) return repoCache.get(key)!;
    const info = await ghJson<GhRepoInfo>(`/repos/${full}`).catch(() => null);
    repoCache.set(key, info && !info.fork ? info : null);
    return repoCache.get(key)!;
  };
  const resolve = async (pkg: string): Promise<string | null> => {
    if (!npmCache.has(pkg)) npmCache.set(pkg, await resolveNpm(pkg));
    return npmCache.get(pkg)!;
  };
  const toDep = (info: GhRepoInfo, degree: 1 | 2, usageCount: number, runtime: boolean, packages: string[]): RawDependency => ({
    repo: info.full_name, url: info.html_url, owner: toPerson(info.owner),
    stars: info.stargazers_count, language: info.language, description: info.description,
    degree, usageCount, runtime, isStarred: cfg.starred.has(info.full_name.toLowerCase()),
    pushedAt: info.pushed_at, packages: packages.sort(),
  });

  // ── 1. Direct dependencies ──────────────────────────────────────────────────
  const usage = new Map<string, { repos: Set<string>; runtime: boolean }>();
  const note = (pkg: string, repo: string, runtime: boolean) => {
    if (pkg.startsWith("@types/")) return; // type stubs aren't libraries to thank
    let u = usage.get(pkg);
    if (!u) usage.set(pkg, (u = { repos: new Set(), runtime: false }));
    u.repos.add(repo);
    u.runtime = u.runtime || runtime;
  };
  for (const repo of cfg.repos) {
    const man = await readManifest(cfg.username, repo);
    if (!man) continue;
    man.deps.forEach((p) => note(p, repo, true));
    man.dev.forEach((p) => note(p, repo, false));
  }
  log(`Deps: ${usage.size} unique packages across ${cfg.repos.length} repos`);

  const ranked = [...usage.entries()].sort((a, b) => b[1].repos.size - a[1].repos.size).slice(0, 400);
  const direct = new Map<string, { info: GhRepoInfo; repos: Set<string>; runtime: boolean; packages: string[] }>();
  for (const [pkg, use] of ranked) {
    const full = await resolve(pkg);
    if (!full) continue;
    const key = full.toLowerCase();
    if (key.split("/")[0] === me || resolvedMiss.has(key)) continue;
    let entry = direct.get(key);
    if (!entry) {
      const info = await repoInfo(full);
      if (!info) { resolvedMiss.add(key); continue; }
      entry = { info, repos: new Set(), runtime: false, packages: [] };
      direct.set(key, entry);
    }
    use.repos.forEach((r) => entry!.repos.add(r));
    entry.runtime = entry.runtime || use.runtime;
    entry.packages.push(pkg);
  }
  const deps: RawDependency[] = [...direct.values()].map((e) => toDep(e.info, 1, e.repos.size, e.runtime, e.packages));

  // ── 2. Second-grade: dependencies of my direct dependencies ──────────────────
  if (cfg.includeTransitive) {
    const directPkgs = new Set(ranked.map(([p]) => p));
    const directRepoKeys = new Set(direct.keys());
    const secondUse = new Map<string, Set<string>>(); // sub-pkg → which of my direct pkgs pull it in
    for (const [pkg] of ranked) {
      if (npmCache.get(pkg) == null) continue; // only expand packages that are real, resolvable libs
      for (const sub of await npmRuntimeDeps(pkg)) {
        if (sub.startsWith("@types/") || directPkgs.has(sub)) continue;
        let set = secondUse.get(sub);
        if (!set) secondUse.set(sub, (set = new Set()));
        set.add(pkg);
      }
    }
    const rankedSecond = [...secondUse.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, cfg.transitiveLimit ?? 80);
    const second = new Map<string, { info: GhRepoInfo; via: Set<string>; packages: string[] }>();
    for (const [pkg, via] of rankedSecond) {
      const full = await resolve(pkg);
      if (!full) continue;
      const key = full.toLowerCase();
      if (key.split("/")[0] === me || directRepoKeys.has(key) || resolvedMiss.has(key)) continue;
      let entry = second.get(key);
      if (!entry) {
        const info = await repoInfo(full);
        if (!info) { resolvedMiss.add(key); continue; }
        entry = { info, via: new Set(), packages: [] };
        second.set(key, entry);
      }
      via.forEach((v) => entry!.via.add(v));
      entry.packages.push(pkg);
    }
    for (const e of second.values()) deps.push(toDep(e.info, 2, e.via.size, true, e.packages));
    log(`Deps: +${second.size} second-grade projects (deps of my deps)`);
  }

  log(`Deps: resolved ${deps.filter((d) => d.degree === 1).length} direct projects to thank`);
  return deps;
}
