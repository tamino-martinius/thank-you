// Generic import collector for sources with no usable public API (X/Twitter,
// LinkedIn). You export your data from the platform, normalise it into the simple
// shape below, and drop it at data/import/<source>.json. The collector folds it
// straight into the graph — so the people who liked/followed you there are thanked
// exactly like everyone else.
//
// Expected file shape (data/import/twitter.json, data/import/linkedin.json):
// {
//   "projects": [ { "id": "tw:post:123", "title": "A thread about…", "url": "…", "reactions": 42 } ],
//   "people":   [ { "login": "someone", "name": "Some One", "avatar": "https://…", "url": "https://…" } ],
//   "interactions": [ { "person": "someone", "project": "tw:post:123", "kind": "like" } ]
// }
// `project` may be "me" for a plain follow.

import { readFile } from "node:fs/promises";
import type { InteractionKind, RawInteraction, RawPerson, RawProject, SourceId } from "../types.js";
import { log } from "../util.js";

export interface ImportResult {
  people: RawPerson[];
  projects: RawProject[];
  interactions: RawInteraction[];
}

interface ImportFile {
  projects?: Array<Partial<RawProject> & { id: string; title: string; url: string }>;
  people?: Array<{ login: string; name?: string; avatar?: string; url?: string }>;
  interactions?: Array<{ person: string; project: string; kind?: InteractionKind }>;
}

export async function collectImport(source: SourceId): Promise<ImportResult> {
  let raw: string;
  try {
    raw = await readFile(`data/import/${source}.json`, "utf8");
  } catch {
    log(`${source}: no data/import/${source}.json — skipping`);
    return { people: [], projects: [], interactions: [] };
  }

  const file = JSON.parse(raw) as ImportFile;
  const defaultKind: InteractionKind = source === "twitter" ? "like" : "follow";

  const projects: RawProject[] = (file.projects ?? []).map((p) => ({
    kind: "post",
    reactions: 0,
    ...p,
    source,
  }));

  const people: RawPerson[] = (file.people ?? []).map((p) => ({
    id: `${source}:${p.login}`,
    source,
    login: p.login,
    name: p.name ?? null,
    avatar: p.avatar ?? null,
    url: p.url ?? "",
  }));

  const interactions: RawInteraction[] = (file.interactions ?? []).map((i) => ({
    personId: `${source}:${i.person}`,
    projectId: i.project,
    kind: i.kind ?? defaultKind,
    source,
  }));

  log(`${source}: imported ${people.length} people, ${projects.length} projects, ${interactions.length} interactions`);
  return { people, projects, interactions };
}
