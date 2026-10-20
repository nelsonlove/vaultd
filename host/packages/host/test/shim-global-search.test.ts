import { describe, expect, it } from "vitest";

import { GlobalSearchInstance } from "../src/shim/global-search";
import type { RequestSink } from "../src/client/request-sink";

function recordingClient(answer: unknown): { client: RequestSink; calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: RequestSink = {
    request: <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer as T);
    },
  };
  return { client, calls };
}

const ANSWER = { generation: 4, total_files: 1, total_matches: 1, items: [], next_cursor: null };

describe("GlobalSearchInstance", () => {
  it("starts with no query", () => {
    const { client } = recordingClient(ANSWER);
    expect(new GlobalSearchInstance({ client }).getGlobalSearchQuery()).toBe("");
  });

  it("opens a search: records the query, asks the engine, and reports the answer", async () => {
    const { client, calls } = recordingClient(ANSWER);
    const search = new GlobalSearchInstance({ client });
    const seen: string[] = [];
    search.onOpened((state) => seen.push(`${state.query}:${state.answer?.total_files}`));
    search.openGlobalSearch("tag:#project");
    expect(search.getGlobalSearchQuery()).toBe("tag:#project");
    await search.settled();
    expect(calls).toEqual([{ method: "search", params: { query: "tag:#project", limit: 100 } }]);
    expect(search.state().answer).toEqual(ANSWER);
    expect(seen).toEqual(["tag:#project:1"]);
  });

  it("composes the way tag-wrangler does: the current query plus a tag", async () => {
    const { client, calls } = recordingClient(ANSWER);
    const search = new GlobalSearchInstance({ client });
    search.openGlobalSearch("meeting");
    await search.settled();
    search.openGlobalSearch(`${search.getGlobalSearchQuery()} tag:#work`);
    await search.settled();
    expect(calls.map((c) => (c.params as { query: string }).query)).toEqual(["meeting", "meeting tag:#work"]);
  });

  it("coerces a non-string query from a plugin to a string, as a search box would", async () => {
    const { client, calls } = recordingClient(ANSWER);
    const search = new GlobalSearchInstance({ client });
    (search.openGlobalSearch as (query: unknown) => void)(42);
    expect(search.getGlobalSearchQuery()).toBe("42");
    await search.settled();
    expect(calls).toEqual([{ method: "search", params: { query: "42", limit: 100 } }]);
    expect(search.state().query).toBe("42");
  });

  it("keeps a refused query as state with its error, and never throws into the plugin", async () => {
    const { client } = recordingClient(new Error("query_invalid: unmatched `)` (at character 3)"));
    const search = new GlobalSearchInstance({ client });
    expect(() => search.openGlobalSearch("a b)")).not.toThrow();
    await search.settled();
    expect(search.state()).toEqual({ query: "a b)", answer: null, error: "query_invalid: unmatched `)` (at character 3)" });
  });

  it("answers only the newest open when two overlap", async () => {
    let release: (() => void) | undefined;
    const client: RequestSink = {
      request: async <T>(_method: string, params?: unknown): Promise<T> => {
        const query = (params as { query: string }).query;
        if (query === "slow") await new Promise<void>((resolve) => (release = resolve));
        return { ...ANSWER, total_files: query === "slow" ? 9 : 2 } as T;
      },
    };
    const search = new GlobalSearchInstance({ client });
    search.openGlobalSearch("slow");
    search.openGlobalSearch("fast");
    await search.settled();
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(search.state().query).toBe("fast");
    expect(search.state().answer?.total_files).toBe(2);
  });
});
