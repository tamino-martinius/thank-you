// Run with: npx tsx src/collectors/github.contributors.test.ts
import assert from "node:assert/strict";
import { isBotContributor } from "./github.js";

// GitHub flags app bots with type: "Bot"
assert.equal(isBotContributor({ login: "dependabot[bot]", type: "Bot" }), true);
assert.equal(isBotContributor({ login: "github-actions[bot]", type: "Bot" }), true);

// The [bot] login suffix is excluded even if type is missing or mislabeled
assert.equal(isBotContributor({ login: "renovate[bot]", type: "User" }), true);
assert.equal(isBotContributor({ login: "some-app[bot]" }), true);

// Real humans are kept
assert.equal(isBotContributor({ login: "octocat", type: "User" }), false);
assert.equal(isBotContributor({ login: "torvalds" }), false);

// A human whose login merely contains "bot" mid-string is kept
assert.equal(isBotContributor({ login: "robotnik", type: "User" }), false);

console.log("isBotContributor: all assertions passed ✓");
