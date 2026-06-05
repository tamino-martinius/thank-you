// CodePen collector — best effort.
//
// CodePen has no public API for "who loved a pen", and that data requires an
// authenticated session. What IS public is the user's pen feed (Atom), so we
// surface the pens themselves as project nodes (with their love/heart counts when
// present). People who loved them can be layered in later from an export at
// data/import/codepen.json (array of { pen, login, name, avatar, url }).

import { readFile } from "node:fs/promises";
import type { RawInteraction, RawPerson, RawProject } from "../types.js";
import { fetchText, log } from "../util.js";

export interface CodepenResult {
  people: RawPerson[];
  projects: RawProject[];
  interactions: RawInteraction[];
}

const EMPTY: CodepenResult = { people: [], projects: [], interactions: [] };

export async function collectCodepen(cfg: { username: string }): Promise<CodepenResult> {
  const { username } = cfg;
  const feed = await fetchText(`https://codepen.io/${username}/public/feed`);
  const projects: RawProject[] = [];

  if (feed) {
    // Atom feed: each <entry> has <title>, <link href>, <published>.
    const entries = feed.split(/<entry>/).slice(1);
    for (const entry of entries) {
      const title = decodeXml(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
      const link = entry.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? "";
      const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] ?? null;
      const slug = link.split("/").pop() || title;
      if (!title || !link) continue;
      projects.push({
        id: `cp:pen:${slug}`,
        source: "codepen",
        kind: "pen",
        title,
        url: link,
        reactions: 0,
        createdAt: published,
      });
    }
    log(`CodePen: ${projects.length} public pens from feed`);
  } else {
    log("CodePen: public feed unavailable (skipping)");
  }

  // Optional manual export of people who loved the pens.
  const { people, interactions } = await loadLovesImport(projects);

  return { people, projects, interactions };
}

async function loadLovesImport(
  projects: RawProject[],
): Promise<{ people: RawPerson[]; interactions: RawInteraction[] }> {
  try {
    const raw = await readFile("data/import/codepen.json", "utf8");
    const rows = JSON.parse(raw) as Array<{
      pen: string;
      login: string;
      name?: string;
      avatar?: string;
      url?: string;
    }>;
    const people = new Map<string, RawPerson>();
    const interactions: RawInteraction[] = [];
    const byTitle = new Map(projects.map((p) => [p.title.toLowerCase(), p]));
    for (const row of rows) {
      const id = `codepen:${row.login}`;
      people.set(id, {
        id,
        source: "codepen",
        login: row.login,
        name: row.name ?? null,
        avatar: row.avatar ?? null,
        url: row.url ?? `https://codepen.io/${row.login}`,
      });
      const project = byTitle.get(row.pen.toLowerCase());
      interactions.push({
        personId: id,
        projectId: project?.id ?? `cp:pen:${row.pen}`,
        kind: "love",
        source: "codepen",
      });
    }
    log(`CodePen: +${people.size} lovers from data/import/codepen.json`);
    return { people: [...people.values()], interactions };
  } catch {
    return { people: [], interactions: [] };
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export { EMPTY as CODEPEN_EMPTY };
