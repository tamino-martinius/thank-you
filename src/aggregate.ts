// Aggregator: read the full snapshot and distil it into the PUBLIC graph the
// website reads (data/public/graph.json). This is the only file the site needs.
//
//   npm run aggregate    (reads data/snapshot.json from a prior `npm run collect`)

import "./env.js"; // load .env before anything reads process.env
import { mkdir, readFile, writeFile } from "node:fs/promises";
import config from "../config.json" with { type: "json" };
import type {
  GraphDependency,
  GraphLink,
  GraphPerson,
  GraphProject,
  InteractionKind,
  PresenceLink,
  PublicGraph,
  SourceId,
  Snapshot,
} from "./types.js";
import { log, SNAPSHOT_PATH } from "./util.js";

async function main() {
  const snapshot = JSON.parse(
    await readFile(SNAPSHOT_PATH, "utf8").catch(() => {
      throw new Error(`${SNAPSHOT_PATH} not found — run \`npm run collect\` first.`);
    }),
  ) as Snapshot;

  const { superFanThreshold, maxPeopleInGraph } = config.aggregate;

  // Opt-out: GitHub logins (case-insensitive) to exclude from the public graph.
  const excluded = new Set(
    (((config.aggregate as { excludePeople?: string[] }).excludePeople) ?? []).map((l) => l.toLowerCase()),
  );
  const isExcluded = (login?: string | null) => !!login && excluded.has(login.toLowerCase());

  // O(1) person lookup — a linear find() per interaction hangs popular forks.
  const peopleById = new Map(snapshot.people.map((p) => [p.id, p]));

  // Tally how many distinct supporters each project has.
  const supportersByProject = new Map<string, Set<string>>();

  // Build per-person aggregates.
  const peopleAgg = new Map<
    string,
    {
      person: (typeof snapshot.people)[number];
      score: number;
      kinds: Partial<Record<InteractionKind, number>>;
      sources: Set<SourceId>;
      isFollower: boolean;
      firstSeen: string | null;
    }
  >();

  const links: GraphLink[] = [];
  let interactionCount = 0;

  for (const it of snapshot.interactions) {
    const person = peopleById.get(it.personId);
    if (!person || isExcluded(person.login)) continue;
    interactionCount += 1;

    let agg = peopleAgg.get(person.id);
    if (!agg) {
      agg = { person, score: 0, kinds: {}, sources: new Set(), isFollower: false, firstSeen: null };
      peopleAgg.set(person.id, agg);
    }
    agg.score += 1;
    agg.kinds[it.kind] = (agg.kinds[it.kind] ?? 0) + 1;
    agg.sources.add(it.source);
    if (it.kind === "follow") agg.isFollower = true;
    if (it.at && (!agg.firstSeen || it.at < agg.firstSeen)) agg.firstSeen = it.at;

    if (it.projectId !== "me") {
      if (!supportersByProject.has(it.projectId)) supportersByProject.set(it.projectId, new Set());
      supportersByProject.get(it.projectId)!.add(person.id);
    }

    links.push({
      source: person.id,
      target: it.projectId,
      kind: it.kind,
      platform: it.source,
      at: it.at ?? null,
    });
  }

  // Rank people by engagement; keep the most-engaged within the cap.
  let people: GraphPerson[] = [...peopleAgg.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPeopleInGraph)
    .map((a) => ({
      id: a.person.id,
      login: a.person.login,
      name: a.person.name,
      avatar: a.person.avatar,
      url: a.person.url,
      source: a.person.source,
      sources: [...a.sources],
      score: a.score,
      kinds: a.kinds,
      isFollower: a.isFollower,
      firstSeen: a.firstSeen,
    }));

  const keptIds = new Set(people.map((p) => p.id));

  // Only keep projects that have at least one supporter we're showing.
  const projects: GraphProject[] = snapshot.projects
    .map((p) => ({
      id: p.id,
      source: p.source,
      kind: p.kind,
      title: p.title,
      url: p.url,
      reactions: p.reactions,
      supporters: supportersByProject.get(p.id)?.size ?? 0,
      language: p.language ?? null,
      languages: p.languages ?? (p.language ? [{ name: p.language, color: null }] : []),
      archived: p.archived ?? false,
    }))
    .filter((p) => p.supporters > 0)
    .sort((a, b) => b.reactions - a.reactions);

  const projectIds = new Set(projects.map((p) => p.id));

  // Drop links whose endpoints we trimmed.
  const cleanLinks = links.filter(
    (l) => keptIds.has(l.source) && (l.target === "me" || projectIds.has(l.target)),
  );

  // Reciprocal: where my own appreciation went. (Honour the opt-out here too.)
  const givenFollowing: GraphPerson[] = snapshot.given.following
    .filter((f) => !isExcluded(f.login))
    .map((f) => ({
    id: f.id,
    login: f.login,
    name: f.name,
    avatar: f.avatar,
    url: f.url,
    source: f.source,
    sources: [f.source],
    score: 1,
    kinds: { follow: 1 },
    isFollower: false,
    firstSeen: null,
    followers: f.followers ?? 0,
  }));

  const givenStarred: GraphProject[] = snapshot.given.starred
    .filter(({ owner }) => !isExcluded(owner.login))
    .map(({ project, owner }) => ({
      id: project.id,
      source: project.source,
      kind: project.kind,
      title: project.title,
      url: project.url,
      reactions: project.reactions,
      supporters: 0,
      language: project.language ?? null,
      avatar: owner.avatar,
    }))
    .sort((a, b) => b.reactions - a.reactions)
    .slice(0, 60);

  // The shoulders I stand on — dependencies ranked as star candidates.
  const gemMaxStars = config.aggregate.gemMaxStars ?? 6000;
  const activeMonths = config.aggregate.activeWithinMonths ?? 12;
  const activeCutoff = new Date(snapshot.generatedAt).getTime() - activeMonths * 30.44 * 24 * 3600 * 1000;
  const isActive = (pushedAt: string | null) => !!pushedAt && new Date(pushedAt).getTime() >= activeCutoff;

  const toGraphDep = (d: (typeof snapshot.given.dependencies)[number]): GraphDependency => {
    const active = isActive(d.pushedAt);
    return {
      repo: d.repo,
      url: d.url,
      owner: { login: d.owner.login, name: d.owner.name, avatar: d.owner.avatar, url: d.owner.url },
      stars: d.stars,
      language: d.language,
      description: d.description,
      degree: d.degree ?? 1,
      usageCount: d.usageCount,
      runtime: d.runtime,
      isStarred: d.isStarred,
      pushedAt: d.pushedAt,
      active,
      // Worth a star: still maintained AND small. Independent of whether I've starred it.
      gem: active && d.stars < gemMaxStars,
    };
  };
  // Active first, then most-relied-upon, then smallest. Cap each degree on its own.
  const byRank = (a: GraphDependency, b: GraphDependency) =>
    Number(b.active) - Number(a.active) || b.usageCount - a.usageCount || a.stars - b.stars;
  const allDeps = (snapshot.given.dependencies ?? [])
    .filter((d) => !isExcluded(d.owner.login))
    .map(toGraphDep);
  const dependencies: GraphDependency[] = [
    ...allDeps.filter((d) => d.degree === 1).sort(byRank).slice(0, 120),
    ...allDeps.filter((d) => d.degree === 2).sort(byRank).slice(0, 80),
  ];

  const superFans = people.filter((p) => p.score >= superFanThreshold).length;
  const sources = [...new Set(snapshot.projects.map((p) => p.source))] as SourceId[];
  const presence = (config.presence ?? []) as unknown as PresenceLink[];

  const graph: PublicGraph = {
    generatedAt: snapshot.generatedAt,
    repoUrl: (config as { repoUrl?: string }).repoUrl ?? null,
    gemThreshold: gemMaxStars,
    me: {
      id: snapshot.me.id,
      login: snapshot.me.login,
      name: config.owner.name || snapshot.me.name || snapshot.me.login,
      avatar: snapshot.me.avatar,
      url: snapshot.me.url,
      bio: snapshot.me.bio ?? null,
      tagline: config.owner.tagline,
    },
    sources,
    stats: {
      supporters: peopleAgg.size,
      interactions: interactionCount,
      projects: projects.length,
      superFans,
    },
    projects,
    people,
    links: cleanLinks,
    given: { following: givenFollowing, starred: givenStarred, dependencies },
    presence,
  };

  // Indented + newline-delimited: gzip flattens the size difference on the wire,
  // and it makes diffs (PRs and the nightly data commits) actually readable.
  const json = JSON.stringify(graph, null, 2) + "\n";
  await mkdir("data/public", { recursive: true });
  await writeFile("data/public/graph.json", json, "utf8");
  // Mirror into the site so GitHub Pages serves it from one place.
  await mkdir("site/data", { recursive: true });
  await writeFile("site/data/graph.json", json, "utf8");

  const direct = dependencies.filter((d) => d.degree === 1);
  const second = dependencies.filter((d) => d.degree === 2);
  log(
    `Public graph: ${graph.people.length} people · ${graph.projects.length} projects · ` +
      `${graph.links.length} links · ${superFans} super-fans · ` +
      `${direct.length} direct deps (${direct.filter((d) => d.gem).length} gems) · ` +
      `${second.length} second-grade (${second.filter((d) => d.gem).length} gems).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
