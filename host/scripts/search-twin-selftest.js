#!/usr/bin/env node
"use strict";
/**
 * The uncached twin of `socket-transport-baseline.js --search`, tested.
 *
 * The twin must be a different cache key with the same parse, the same
 * answer and the same work, so it flips the case of one letter in a plain
 * word (a word, a phrase, or an operator's operand) and never one inside an
 * operator name, `OR`, a `[property]` or a regex. A query with no such
 * letter, or with `match-case:`, is refused. A plain node script, like
 * `socket-transport-guard-selftest.js`, because the harnesses have no test
 * project.
 *
 *     node host/scripts/search-twin-selftest.js   # exits 0 or 1
 *
 * It writes nothing.
 */

const assert = require("node:assert/strict");

const { searchTwin } = require("./socket-transport-baseline.js");

function refused(query) {
  try {
    return `allowed: ${searchTwin(query)}`;
  } catch {
    return "refused";
  }
}

function main() {
  // The documented queries keep the twins the baseline used.
  assert.equal(searchTwin("meeting group"), "meeting grouP");
  assert.equal(searchTwin("tag:#group-3"), "tag:#grouP-3");
  assert.equal(searchTwin("file:Note-0001"), "file:NotE-0001");
  // The last letter sits in an operator name: flip an earlier plain word.
  assert.equal(searchTwin("meeting file:1"), "meetinG file:1");
  assert.equal(searchTwin("meeting -path:2"), "meetinG -path:2");
  // `OR` is an operator, not a word.
  assert.equal(searchTwin("a OR"), "A OR");
  assert.equal(searchTwin("alpha OR beta"), "alpha OR betA");
  // A phrase's text is plain.
  assert.equal(searchTwin('"big cat" 1'), '"big caT" 1');
  // A property is never touched.
  assert.equal(searchTwin("note [status:Draft]"), "notE [status:Draft]");
  // A group's operand is plain.
  assert.equal(searchTwin("tag:(work OR home)"), "tag:(work OR homE)");

  assert.equal(refused("file:1"), "refused", "only an operator name holds a letter");
  assert.equal(refused("[status]"), "refused", "only a property holds a letter");
  assert.equal(refused("123"), "refused", "no letter at all");
  assert.equal(refused("match-case:Meeting"), "refused", "a flipped letter changes a case-sensitive answer");
  assert.equal(refused("meeting /a.c/"), "refused", "a regex may read a flipped letter differently");
  process.stdout.write("search-twin-selftest: ok\n");
}

main();
