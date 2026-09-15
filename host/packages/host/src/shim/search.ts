/**
 * The five search helpers, implemented rather than stubbed.
 *
 * **Why these are real.** Task 18's `FuzzySuggestModal` brokering has to order
 * the items it offers, and quickadd calls `prepareFuzzySearch` directly and
 * reads the score back. A stub that answered `null` would make every brokered
 * picker empty; one that answered a constant score would make every picker's
 * order arbitrary. Neither is a thing a caller could work around.
 *
 * **What is not claimed.** This is a subsequence matcher with a contiguity and
 * a word-boundary bonus, not a reproduction of Obsidian's ranking. Obsidian's
 * exact scores are **uncaptured** — nothing in the corpus records them — and
 * nothing in the corpus depends on them either: a plugin reads `score` to sort
 * its own list, never to compare against a number it was told to expect. So the
 * contract kept here is the one that is observable: a match is found exactly
 * when the query's characters appear in order, a closer match scores higher
 * than a more scattered one, and the offsets reported really do cover the
 * characters that matched.
 */

import { stub } from "./policy";
import type { StubNode } from "./dom";

/** `[start, end)` in UTF-16 code units, which is what Obsidian reports. */
export type SearchMatchPart = [number, number];

/** Obsidian's `SearchResult`: a score and the spans that earned it. */
export interface SearchResult {
  score: number;
  matches: SearchMatchPart[];
}

/** What `prepareFuzzySearch` and `prepareSimpleSearch` hand back. */
export type PreparedSearch = (text: string) => SearchResult | null;

/** What `sortSearchResults` orders: anything carrying a nullable match. */
export interface SearchResultContainer {
  match: SearchResult | null;
}

/** Each character matched immediately after the previous one. */
const CONTIGUITY_BONUS = 1;
/** The character matched at a word boundary — a start, a space, a separator. */
const BOUNDARY_BONUS = 0.8;
/** Charged per character skipped between two matched ones. */
const GAP_PENALTY = 0.4;

/**
 * A scorer for one query, reusable across many candidate strings.
 *
 * Prepared once and called many times because that is how plugins use it: build
 * the scorer outside the loop, run it over every item. Case is folded on both
 * sides; a query of only whitespace matches everything with score `0`, which is
 * what an empty search box means.
 */
export function prepareFuzzySearch(query: string): PreparedSearch {
  // Trimmed, so the sentence above is true: a query of only whitespace is an
  // empty search box, and an empty search box matches everything. Without the
  // trim a single space matched nothing, because no candidate carries a space
  // where the scorer looked for one.
  const needle = query.trim().toLowerCase();
  return (text: string): SearchResult | null => scoreSubsequence(needle, text);
}

/**
 * The substring matcher, for the callers that want no fuzziness at all.
 *
 * Obsidian's own simple search splits the query on whitespace and requires
 * every part to appear; that is what is done here, and a part that appears at
 * the start of the text or of a word scores higher than one buried inside it.
 */
export function prepareSimpleSearch(query: string): PreparedSearch {
  const parts = query.toLowerCase().split(/\s+/).filter((part) => part.length > 0);
  return (text: string): SearchResult | null => {
    if (parts.length === 0) return { score: 0, matches: [] };
    const haystack = text.toLowerCase();
    const matches: SearchMatchPart[] = [];
    let score = 0;
    for (const part of parts) {
      const at = haystack.indexOf(part);
      if (at === -1) return null;
      matches.push([at, at + part.length]);
      score += part.length * CONTIGUITY_BONUS;
      if (isBoundary(haystack, at)) score += BOUNDARY_BONUS;
    }
    matches.sort((left, right) => left[0] - right[0]);
    return { score, matches };
  };
}

/**
 * Score one text against one query, without preparing a scorer first.
 *
 * Obsidian's signature takes the prepared scorer and the text, which is what
 * this takes: it is the free-function spelling of calling the scorer.
 */
export function fuzzySearch(prepared: PreparedSearch, text: string): SearchResult | null {
  return prepared(text);
}

/**
 * Order matches best-first, **in place**, the way Obsidian's does.
 *
 * In place because that is the contract plugins rely on — they pass their own
 * array and read it back — and a copy would leave them sorting nothing. An
 * entry with no match sorts last rather than being dropped: removing entries
 * from a caller's array would be a surprise no signature announces.
 */
export function sortSearchResults(results: SearchResultContainer[]): void {
  results.sort((left, right) => (right.match?.score ?? -Infinity) - (left.match?.score ?? -Infinity));
}

/**
 * Paint a match into an element. `safe_stub`: the text lands, the highlight
 * does not.
 *
 * There is no document, so the `<span class="suggestion-highlight">` runs
 * Obsidian wraps each matched span in cannot exist. The text itself is set,
 * because a plugin that renders a suggestion and then reads `el.textContent`
 * back — several in the corpus build their own labels that way — would
 * otherwise read an empty string.
 */
export function renderResults(el: StubNode, text: string, result: SearchResult, offset?: number): void {
  void result;
  void offset;
  stub("renderResults", undefined);
  el.setText(text);
}

/**
 * Paint the matched spans of a result a caller already holds. `safe_stub`.
 *
 * `renderResults` takes a whole {@link SearchResult}; this takes the spans on
 * their own, which is the shape a caller that built them itself is holding.
 * Neither can highlight, for the same reason: there is no document. The text
 * lands so a caller reading `el.textContent` back is not handed a blank.
 */
export function renderMatches(
  el: StubNode,
  text: string,
  matches: SearchMatchPart[] | null,
  offset?: number,
): void {
  void matches;
  void offset;
  stub("renderMatches", undefined);
  el.setText(text);
}

/**
 * The matcher itself: leftmost-greedy, scored by how tightly it landed.
 *
 * Leftmost-greedy rather than optimal, which is a real limit and a deliberate
 * one. An optimal matcher would try every placement of every character and cost
 * `O(query × text)` per candidate, on a path a picker runs over every file in a
 * vault. The case it gets wrong is a query whose earlier character also appears
 * later, where taking the later occurrence would have scored better; the effect
 * is a slightly worse order, never a missed match, because the leftmost run
 * finds a match whenever one exists.
 *
 * **One measured limit in the offsets.** Matching is case-folded on both sides,
 * and a few characters change length when folded — `"İ".toLowerCase()` is two
 * UTF-16 units — so for a text containing one of them the reported `matches`
 * spans drift from the original string's indices. Ordering is unaffected (both
 * sides fold the same way); a highlighter painting those spans over the
 * *unfolded* text would paint them one unit late.
 */
function scoreSubsequence(needle: string, text: string): SearchResult | null {
  if (needle.length === 0) return { score: 0, matches: [] };
  const haystack = text.toLowerCase();
  const matches: SearchMatchPart[] = [];
  let score = 0;
  let cursor = 0;
  let previousEnd = -1;
  for (const character of needle) {
    const at = haystack.indexOf(character, cursor);
    if (at === -1) return null;
    if (at === previousEnd) {
      score += CONTIGUITY_BONUS;
      // Extend the run rather than starting a second span, so `matches`
      // describes the text the way a highlighter would paint it.
      const last = matches[matches.length - 1];
      if (last !== undefined) last[1] = at + 1;
    } else {
      if (previousEnd !== -1) score -= (at - previousEnd) * GAP_PENALTY;
      if (isBoundary(haystack, at)) score += BOUNDARY_BONUS;
      matches.push([at, at + 1]);
    }
    previousEnd = at + 1;
    cursor = at + 1;
  }
  return { score, matches };
}

/** The start of the text, or of a word inside it. */
function isBoundary(text: string, at: number): boolean {
  if (at === 0) return true;
  const before = text.charAt(at - 1);
  return before === " " || before === "/" || before === "-" || before === "_" || before === ".";
}
// This file declares no rows of its own: every one of its surfaces is a
// top-level export, and the barrel declares those from the policy table.
