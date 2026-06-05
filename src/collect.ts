// Orchestrator: run every enabled collector, merge into one people-centric
// Snapshot, and write it encrypted to data/snapshot.enc.
//
//   ENCRYPTION_KEY=<64 hex>  GH_PAT=<token>  npm run collect

import "./env.js"; // load .env before anything reads process.env
import { mkdir, writeFile } from "node:fs/promises";
import config from "../config.json" with { type: "json" };
import { collectCodepen } from "./collectors/codepen.js";
import { collectGithub } from "./collectors/github.js";
import { collectImport } from "./collectors/imports.js";
import { encrypt, hasKey } from "./crypto.js";
import type { RawInteraction, RawPerson, RawProject, Snapshot } from "./types.js";
import { hasGithubToken, log } from "./util.js";

async function main() {
  if (!hasKey()) throw new Error("ENCRYPTION_KEY required to write the encrypted snapshot.");
  if (config.sources.github.enabled && !hasGithubToken()) {
    throw new Error("Set GH_PAT (or GH_TOKEN) to collect GitHub data.");
  }

  const people = new Map<string, RawPerson>();
  const projects = new Map<string, RawProject>();
  const interactions: RawInteraction[] = [];
  const mergePeople = (list: RawPerson[]) => {
    for (const p of list) if (!people.has(p.id)) people.set(p.id, p);
  };
  const mergeProjects = (list: RawProject[]) => {
    for (const p of list) projects.set(p.id, p);
  };

  let me: Snapshot["me"] | null = null;
  let given: Snapshot["given"] = { following: [], starred: [], dependencies: [] };

  // GitHub (primary).
  if (config.sources.github.enabled) {
    const gh = await collectGithub(config.sources.github, config.dependencies);
    me = gh.me;
    given = gh.given;
    mergePeople(gh.people);
    mergeProjects(gh.projects);
    interactions.push(...gh.interactions);
  }

  // CodePen (best effort).
  if (config.sources.codepen.enabled) {
    const cp = await collectCodepen(config.sources.codepen);
    mergePeople(cp.people);
    mergeProjects(cp.projects);
    interactions.push(...cp.interactions);
  }

  // X/Twitter + LinkedIn via optional exports.
  for (const source of ["twitter", "linkedin"] as const) {
    if (!config.sources[source].enabled) continue;
    const r = await collectImport(source);
    mergePeople(r.people);
    mergeProjects(r.projects);
    interactions.push(...r.interactions);
  }

  if (!me) throw new Error("No primary identity collected — enable at least the GitHub source.");

  const snapshot: Snapshot = {
    generatedAt: new Date().toISOString(),
    me,
    people: [...people.values()],
    projects: [...projects.values()],
    interactions,
    given,
  };

  await mkdir("data", { recursive: true });
  await writeFile("data/snapshot.enc", encrypt(JSON.stringify(snapshot)), "utf8");
  log(
    `Wrote encrypted snapshot: ${snapshot.people.length} people, ` +
      `${snapshot.projects.length} projects, ${snapshot.interactions.length} interactions.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
