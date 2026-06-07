// GitHub collector — the richest, fully-implemented source.
//
// People who touched my work:
//   • stargazers of each repo        → star  (with starred_at timestamps)
//   • forkers of each repo           → fork
//   • watchers (subscribers)         → watch
//   • my followers                   → follow (targets "me")
//
// Where my appreciation went (RawGiven):
//   • accounts I follow
//   • repos I starred + their owners

import type { LanguageBreakdown, RawGiven, RawInteraction, RawPerson, RawProject } from "../types.js";
import { ghGraphQL, ghJson, ghPaginate, log } from "../util.js";
import { collectDependencies } from "./dependencies.js";

interface GhUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url: string;
  html_url: string;
}

interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  fork: boolean;
  archived: boolean;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  created_at: string;
  owner: GhUser;
}

interface GhContributor extends GhUser {
  /** Commit count attributed to this contributor on the default branch. */
  contributions: number;
  /** "User" | "Bot" — GitHub's bot flag. */
  type?: string | null;
}

export interface GithubResult {
  me: RawPerson & { bio?: string | null };
  people: RawPerson[];
  projects: RawProject[];
  interactions: RawInteraction[];
  given: RawGiven;
}

const personId = (u: { id: number }) => `github:${u.id}`;
const repoId = (r: { name: string }) => `gh:repo:${r.name}`;

/** Bots we never thank — flagged by GitHub's `type: "Bot"` or the `[bot]` login suffix. */
export function isBotContributor(c: { login: string; type?: string | null }): boolean {
  return c.type === "Bot" || /\[bot\]$/i.test(c.login);
}

function toPerson(u: GhUser): RawPerson {
  return {
    id: personId(u),
    source: "github",
    login: u.login,
    name: u.name ?? null,
    avatar: u.avatar_url,
    url: u.html_url,
    externalId: u.id,
  };
}

export async function collectGithub(
  cfg: {
    username: string;
    includeForks?: boolean;
    skipRepos?: string[];
    includeContributors?: boolean;
    contributorsSinceCreation?: boolean;
  },
  depCfg?: { includeTransitive?: boolean; transitiveLimit?: number },
): Promise<GithubResult> {
  const { username } = cfg;
  const skip = new Set(cfg.skipRepos ?? []);

  log(`GitHub: fetching profile for @${username}`);
  const profile = await ghJson<GhUser & { bio?: string | null }>(`/users/${username}`);
  const me: RawPerson & { bio?: string | null } = { ...toPerson(profile), bio: profile.bio ?? null };

  const people = new Map<string, RawPerson>();
  const projects: RawProject[] = [];
  const interactions: RawInteraction[] = [];
  const addPerson = (u: GhUser) => {
    const p = toPerson(u);
    if (!people.has(p.id)) people.set(p.id, p);
    return p.id;
  };

  // ── My repos ───────────────────────────────────────────────────────────────
  let repos = await ghPaginate<GhRepo>(`/users/${username}/repos?sort=updated`);
  repos = repos.filter((r) => (cfg.includeForks ? true : !r.fork) && !skip.has(r.name));
  log(`GitHub: ${repos.length} repos to scan`);

  // All languages, with GitHub's linguist colours, in one batched GraphQL sweep.
  const languagesByRepo = await fetchLanguages(username, repos.map((r) => r.name));

  for (const repo of repos) {
    const pid = repoId(repo);
    projects.push({
      id: pid,
      source: "github",
      kind: "repo",
      title: repo.name,
      url: repo.html_url,
      reactions: repo.stargazers_count,
      language: repo.language,
      languages: languagesByRepo.get(repo.name) ?? (repo.language ? [{ name: repo.language, color: null }] : []),
      archived: repo.archived,
      createdAt: repo.created_at,
    });

    // One repo's failure (rate limit, transient 5xx) shouldn't kill the whole run —
    // log it, keep the project node, and move on.
    try {
      // Stargazers (with starred_at via the star+json media type).
      if (repo.stargazers_count > 0) {
        const gazers = await ghPaginate<{ starred_at: string; user: GhUser }>(
          `/repos/${username}/${repo.name}/stargazers`,
          { starred: true },
        );
        for (const g of gazers) {
          if (!g?.user) continue;
          const id = addPerson(g.user);
          interactions.push({ personId: id, projectId: pid, kind: "star", source: "github", at: g.starred_at });
        }
      }

      // Forkers.
      if (repo.forks_count > 0) {
        const forks = await ghPaginate<{ owner: GhUser; created_at: string }>(
          `/repos/${username}/${repo.name}/forks`,
        );
        for (const f of forks) {
          if (!f?.owner) continue;
          const id = addPerson(f.owner);
          interactions.push({ personId: id, projectId: pid, kind: "fork", source: "github", at: f.created_at });
        }
      }

      // Watchers (subscribers — people who explicitly clicked "watch").
      const watchers = await ghPaginate<GhUser>(`/repos/${username}/${repo.name}/subscribers`);
      for (const w of watchers) {
        if (w.login === username) continue; // I watch my own repos by default
        const id = addPerson(w);
        interactions.push({ personId: id, projectId: pid, kind: "watch", source: "github", at: null });
      }
      // Contributors (people with merged commits) — skip bots and myself, and
      // skip authors carried in via inherited git history (templates, forks):
      // anyone whose commits all predate the repo's creation isn't *my* contributor.
      let contributorCount = 0;
      if (cfg.includeContributors !== false) {
        const contributors = await ghPaginate<GhContributor>(`/repos/${username}/${repo.name}/contributors`);

        // The set of logins that committed *since the repo was created*. Authors
        // missing from it only exist in inherited history → not real contributors.
        // (One extra sweep, cheap on forks since few commits post-date the fork.)
        let activeSince: Set<string> | null = null;
        if (contributors.length > 0 && cfg.contributorsSinceCreation !== false && repo.created_at) {
          const recent = await ghPaginate<{ author: GhUser | null }>(
            `/repos/${username}/${repo.name}/commits?since=${encodeURIComponent(repo.created_at)}`,
          );
          activeSince = new Set(recent.map((r) => r.author?.login).filter((l): l is string => !!l));
        }

        for (const c of contributors) {
          if (!c?.login || c.login === username || isBotContributor(c)) continue;
          if (activeSince && !activeSince.has(c.login)) continue; // inherited/template/upstream author
          const id = addPerson(c);
          interactions.push({
            personId: id,
            projectId: pid,
            kind: "contribute",
            source: "github",
            at: null,
            commits: c.contributions,
          });
          contributorCount += 1;
        }
      }
      log(`GitHub:   ${repo.name} — ${repo.stargazers_count}★ ${repo.forks_count}⑂ ${watchers.length}👁 ${contributorCount}⎇`);
    } catch (err) {
      log(`GitHub:   ${repo.name} — skipped (${(err as Error).message})`);
    }
  }

  // ── My followers (→ follow targets "me") ─────────────────────────────────────
  log("GitHub: fetching followers");
  const followers = await ghPaginate<GhUser>(`/users/${username}/followers`);
  for (const f of followers) {
    const id = addPerson(f);
    interactions.push({ personId: id, projectId: "me", kind: "follow", source: "github", at: null });
  }
  log(`GitHub: ${followers.length} followers`);

  // ── Where my appreciation went ───────────────────────────────────────────────
  log("GitHub: fetching who I follow & what I starred");
  const followingUsers = await ghPaginate<GhUser>(`/users/${username}/following`);
  const followerCounts = await fetchFollowerCounts(followingUsers.map((u) => u.login));
  const following = followingUsers.map((u) => ({ ...toPerson(u), followers: followerCounts.get(u.login) ?? 0 }));

  const starredRepos = await ghPaginate<GhRepo>(`/users/${username}/starred`);
  const starredFullNames = new Set(starredRepos.map((r) => r.full_name.toLowerCase()));
  const starred = starredRepos.slice(0, 200).map((r) => ({
    project: {
      id: `gh:starred:${r.full_name}`,
      source: "github" as const,
      kind: "repo" as const,
      title: r.full_name,
      url: r.html_url,
      reactions: r.stargazers_count,
      language: r.language,
      createdAt: r.created_at,
    },
    owner: toPerson(r.owner),
  }));

  // The shoulders I stand on: libraries I depend on across my repos.
  const dependencies = await collectDependencies({
    username,
    repos: repos.map((r) => r.name),
    starred: starredFullNames,
    includeTransitive: depCfg?.includeTransitive,
    transitiveLimit: depCfg?.transitiveLimit,
  });

  return {
    me,
    people: [...people.values()],
    projects,
    interactions,
    given: { following, starred, dependencies },
  };
}

/** Follower counts for the accounts I follow, batched into aliased GraphQL queries. */
async function fetchFollowerCounts(logins: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const CHUNK = 50;
  for (let i = 0; i < logins.length; i += CHUNK) {
    const chunk = logins.slice(i, i + CHUNK);
    const body = chunk
      .map((login, j) => `u${j}: user(login: ${JSON.stringify(login)}) { followers { totalCount } }`)
      .join("\n");
    try {
      const data = await ghGraphQL<Record<string, { followers?: { totalCount: number } } | null>>(`query {\n${body}\n}`);
      chunk.forEach((login, j) => {
        const count = data[`u${j}`]?.followers?.totalCount;
        if (typeof count === "number") out.set(login, count);
      });
    } catch (err) {
      log(`GitHub: follower-count batch failed — ${(err as Error).message}`);
    }
  }
  return out;
}

/** GraphQL alias must be a valid identifier; repo names have hyphens/dots. */
const alias = (i: number) => `r${i}`;

/**
 * Fetch every repo's languages (biggest-first) WITH GitHub's linguist colour,
 * batching repos into aliased GraphQL queries to keep the call count tiny.
 */
async function fetchLanguages(
  username: string,
  repoNames: string[],
): Promise<Map<string, LanguageBreakdown[]>> {
  const out = new Map<string, LanguageBreakdown[]>();
  const CHUNK = 25;
  for (let i = 0; i < repoNames.length; i += CHUNK) {
    const chunk = repoNames.slice(i, i + CHUNK);
    const body = chunk
      .map(
        (name, j) =>
          `${alias(j)}: repository(owner: ${JSON.stringify(username)}, name: ${JSON.stringify(name)}) { ` +
          `languages(first: 12, orderBy: {field: SIZE, direction: DESC}) { edges { node { name color } } } }`,
      )
      .join("\n");
    try {
      const data = await ghGraphQL<Record<string, { languages?: { edges: Array<{ node: { name: string; color: string | null } }> } } | null>>(
        `query {\n${body}\n}`,
      );
      chunk.forEach((name, j) => {
        const repo = data[alias(j)];
        const langs = repo?.languages?.edges?.map((e) => ({ name: e.node.name, color: e.node.color })) ?? [];
        if (langs.length) out.set(name, langs);
      });
    } catch (err) {
      log(`GitHub: language fetch failed for a batch — ${(err as Error).message}`);
    }
  }
  log(`GitHub: languages+colours for ${out.size} repos`);
  return out;
}
