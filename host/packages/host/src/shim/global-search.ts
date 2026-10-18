/**
 * `global-search`'s instance — Obsidian's core Search, as much of it as a
 * headless host can honestly serve.
 *
 * **Opening a search means one thing here, and nothing more.** In Obsidian,
 * `openGlobalSearch(query)` reveals the Search pane, types the query into its
 * box and runs it. A headless host has no pane, so "open" becomes the part that
 * is left: the query becomes this host's **current search**, the engine's
 * `search` runs it for its first page, and `host.search_opened` tells every
 * host subscriber it happened. Any host client then reads the query and its
 * answer through `host.search_state`. Nothing is rendered, and nothing claims to
 * be.
 *
 * **Only the two methods the corpus calls exist.** tag-wrangler reads
 * `getGlobalSearchQuery()` and calls `openGlobalSearch(query)` from its tag
 * menu ("Search for #tag", "Require #tag in search", "Exclude #tag from
 * search"), and those two are the whole surface. An instance that grew the
 * view's other members — its result lookup, its sort toggle — would claim a
 * pane this host does not have, which is worse than the `undefined` a plugin
 * gets for a member that is not there.
 *
 * **The newest open wins.** Two opens in quick succession start two engine
 * requests, and the older one may answer last; each open takes a sequence
 * number, and an answer whose number is no longer the newest is dropped, so a
 * slow search never overwrites the state of a newer one.
 *
 * **A refusal is state, never a throw.** Obsidian's `openGlobalSearch` returns
 * nothing and throws nothing to a plugin, whatever the query. A query the
 * engine refuses (`query_invalid`, `unsupported_operator`, or no engine at all)
 * is recorded as the state's `error`, the refusal's message, and reported to
 * listeners like any other answer.
 */

import { declarePolicy, recordUse } from "./policy";
import type { RequestSink } from "../client/request-sink";
import type { SearchParams, SearchResponse } from "../client/protocol";

/** How many hits the first page of an opened search asks the engine for. */
const OPENED_PAGE_LIMIT = 100;

/** The host's current search: its query and the engine's last answer to it. */
export interface SearchState {
  readonly query: string;
  /** The first page, or `null` while the search runs or when it was refused. */
  readonly answer: SearchResponse | null;
  /** The refusal's message, or `null` when there was none. */
  readonly error: string | null;
}

export class GlobalSearchInstance {
  private readonly client: RequestSink;
  private current: SearchState = { query: "", answer: null, error: null };
  /** Incremented by every open; an answer applies only while it is the newest. */
  private sequence = 0;
  private latest: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(state: SearchState) => void>();

  constructor(deps: { client: RequestSink }) {
    this.client = deps.client;
  }

  /** Obsidian's method: make `query` the current search and run it. */
  openGlobalSearch(query: string): void {
    recordUse("GlobalSearchInstance.openGlobalSearch");
    this.sequence += 1;
    const mine = this.sequence;
    this.current = { query, answer: null, error: null };
    const params: SearchParams = { query, limit: OPENED_PAGE_LIMIT };
    this.latest = this.client.request<SearchResponse>("search", params).then(
      (answer) => {
        this.settle(mine, { query, answer, error: null });
      },
      (error: unknown) => {
        this.settle(mine, { query, answer: null, error: error instanceof Error ? error.message : String(error) });
      },
    );
  }

  /** Obsidian's method: the current query, `""` when none. */
  getGlobalSearchQuery(): string {
    recordUse("GlobalSearchInstance.getGlobalSearchQuery");
    return this.current.query;
  }

  /** **HOST-ONLY.** The current query and its last answer. */
  state(): SearchState {
    return this.current;
  }

  /** **HOST-ONLY.** Resolves when the search started by the last open has answered. */
  settled(): Promise<void> {
    return this.latest;
  }

  /** **HOST-ONLY.** Called with the state each time an opened search answers or fails. */
  onOpened(listener: (state: SearchState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private settle(sequence: number, state: SearchState): void {
    if (sequence !== this.sequence) return;
    this.current = state;
    for (const listener of [...this.listeners]) {
      // A listener is host code (the server's broadcast); one that throws must
      // not stop the others, nor reach the plugin that opened the search.
      try {
        listener(state);
      } catch {
        // Deliberately dropped: see above.
      }
    }
  }
}

// The rows this file owns. Not a barrel export: a plugin reaches the instance
// through `app.internalPlugins`, never through the `obsidian` module.
declarePolicy("GlobalSearchInstance.openGlobalSearch", "implemented");
declarePolicy("GlobalSearchInstance.getGlobalSearchQuery", "implemented");
