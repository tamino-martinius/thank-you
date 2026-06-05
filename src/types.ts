// ─────────────────────────────────────────────────────────────────────────────
// Shared data contract for the "thank-you" project.
//
// Two artifacts flow through the pipeline:
//   1. A FULL, encrypted snapshot  (data/snapshot.enc)  — every raw person + event.
//   2. A PUBLIC, aggregated graph  (data/public/graph.json) — what the website reads.
//
// Everything here is PEOPLE-centric. We deliberately do not keep statistics that
// can't be traced back to a human who interacted with my work.
// ─────────────────────────────────────────────────────────────────────────────

export type SourceId = "github" | "codepen" | "twitter" | "linkedin";

/** How a person touched my work. A follow targets *me*; the rest target a project. */
export type InteractionKind = "star" | "fork" | "watch" | "follow" | "love" | "like";

// ── FULL snapshot (encrypted) ────────────────────────────────────────────────

/** A single human, as seen on one platform. */
export interface RawPerson {
  /** Stable id, e.g. "github:3111766" or "codepen:TaminoMartinius". */
  id: string;
  source: SourceId;
  login: string;
  name: string | null;
  avatar: string | null;
  url: string;
  /** Platform-native numeric id when available (used for de-dup across sources). */
  externalId?: string | number;
  /** Follower count — only collected for accounts I follow (ranks the "lean on" list). */
  followers?: number;
}

/** One project / repo / pen / post that people can interact with. */
export interface RawProject {
  id: string;
  source: SourceId;
  kind: "repo" | "pen" | "post" | "gist" | "profile";
  title: string;
  url: string;
  /** Total public reactions (stars / hearts / likes). */
  reactions: number;
  /** Primary language (kept for the cloud tooltip). */
  language?: string | null;
  /** All languages, biggest-first, with GitHub's linguist colour. */
  languages?: LanguageBreakdown[];
  archived?: boolean;
  createdAt?: string | null;
}

/** One language of a repo, with the colour GitHub assigns it. */
export interface LanguageBreakdown {
  name: string;
  color: string | null;
}

/** A directed edge: person → (project | me). */
export interface RawInteraction {
  personId: string;
  /** Project id, or "me" for follows. */
  projectId: string;
  kind: InteractionKind;
  source: SourceId;
  at?: string | null;
}

/** A dependency I rely on — a maintainer I could thank with a star. */
export interface RawDependency {
  /** "owner/name" on GitHub. */
  repo: string;
  url: string;
  owner: RawPerson;
  stars: number;
  language: string | null;
  description: string | null;
  /** Direct (1) = used in my repos. Second-degree (2) = a dependency of my dependencies. */
  degree: 1 | 2;
  /** Direct: # of my repos using it. Second-degree: # of my direct deps that pull it in. */
  usageCount: number;
  /** Used as a runtime dependency (not just dev tooling) in at least one repo. */
  runtime: boolean;
  /** I already starred it. */
  isStarred: boolean;
  /** Last push to the repo (proxy for "still maintained"). */
  pushedAt: string | null;
  /** npm package names that resolve to this repo (e.g. @babel/core → babel/babel). */
  packages: string[];
}

/** Where MY appreciation went — people/projects *I* starred, follow, or depend on. */
export interface RawGiven {
  /** People I follow / accounts I appreciate. */
  following: RawPerson[];
  /** Projects I starred, paired with their owner. */
  starred: Array<{ project: RawProject; owner: RawPerson }>;
  /** Open-source I depend on — candidates to thank with a star. */
  dependencies: RawDependency[];
}

export interface Snapshot {
  generatedAt: string;
  me: RawPerson & { bio?: string | null };
  people: RawPerson[];
  projects: RawProject[];
  interactions: RawInteraction[];
  given: RawGiven;
}

// ── PUBLIC aggregated graph (what the site renders) ──────────────────────────

export interface GraphProject {
  id: string;
  source: SourceId;
  kind: RawProject["kind"];
  title: string;
  url: string;
  reactions: number;
  /** Number of distinct supporters we could attribute to this project. */
  supporters: number;
  language?: string | null;
  languages?: LanguageBreakdown[];
  archived?: boolean;
  /** Owner avatar — only set for repos I starred (rendered as a logo). */
  avatar?: string | null;
}

export interface GraphPerson {
  id: string;
  login: string;
  name: string | null;
  avatar: string | null;
  url: string;
  source: SourceId;
  sources: SourceId[];
  /** Total interactions with my work — drives node size & ranking. */
  score: number;
  /** Per-kind breakdown, e.g. { star: 4, follow: 1 }. */
  kinds: Partial<Record<InteractionKind, number>>;
  /** True if this person follows me anywhere. */
  isFollower: boolean;
  /** Earliest interaction timestamp we know about. */
  firstSeen?: string | null;
  /** Follower count — set for accounts I follow (ranks the "lean on" list). */
  followers?: number;
}

export interface GraphLink {
  /** GraphPerson id. */
  source: string;
  /** GraphProject id, or "me". */
  target: string;
  kind: InteractionKind;
  platform: SourceId;
  at?: string | null;
}

export interface PublicGraph {
  generatedAt: string;
  /** GitHub repo that builds this page (for the titlebar link). */
  repoUrl?: string | null;
  /** Star ceiling under which a dependency counts as a "worth a star" gem. */
  gemThreshold?: number;
  me: {
    id: string;
    login: string;
    name: string;
    avatar: string | null;
    url: string;
    bio?: string | null;
    tagline?: string;
  };
  sources: SourceId[];
  stats: {
    supporters: number;
    interactions: number;
    projects: number;
    superFans: number;
    countries?: number;
  };
  projects: GraphProject[];
  people: GraphPerson[];
  links: GraphLink[];
  /** Where my own appreciation went. */
  given: {
    following: GraphPerson[];
    starred: GraphProject[];
    /** Open-source I depend on, ranked as star candidates. */
    dependencies: GraphDependency[];
  };
  /** My presence across the internet (rendered as a "find me" strip). */
  presence?: PresenceLink[];
}

export interface GraphDependency {
  repo: string;
  url: string;
  owner: { login: string; name: string | null; avatar: string | null; url: string };
  stars: number;
  language: string | null;
  description: string | null;
  degree: 1 | 2;
  usageCount: number;
  runtime: boolean;
  isStarred: boolean;
  pushedAt: string | null;
  /** Pushed within the active window (a commit in the last ~12 months). */
  active: boolean;
  /** Worth a star: active AND under the star ceiling. */
  gem: boolean;
}

export interface PresenceLink {
  platform: string;
  label: string;
  url: string;
  /** "connected" = data is flowing; "export" = needs a manual export; "link" = just a link. */
  status: "connected" | "export" | "link";
  note?: string;
}
