import { describe, expect, it } from "vitest";

import { FramingError, LineFramer, MalformedEnvelopeError } from "../src/client/framing";

describe("LineFramer", () => {
  it("reassembles a response split across three chunks", () => {
    const framer = new LineFramer();
    const line =
      '{"version":1,"id":"h-1","outcome":{"status":"ok","value":{"type":"health","value":{"service":"vaultd","status":"ok"}}}}\n';
    expect(framer.push(Buffer.from(line.slice(0, 20))).frames).toEqual([]);
    expect(framer.push(Buffer.from(line.slice(20, 60))).frames).toEqual([]);
    const { frames, error } = framer.push(Buffer.from(line.slice(60)));
    expect(error).toBeUndefined();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ version: 1, id: "h-1" });
  });

  it("yields two frames from one chunk and skips blank lines", () => {
    const framer = new LineFramer();
    const a = '{"version":1,"id":"a","outcome":{"status":"ok","value":{"type":"health","value":{}}}}';
    const b =
      '{"version":1,"subscription_id":"sub-1","event":{"type":"resync_required","value":{"current_generation":4,"reason":"watcher_overflow"}}}';
    const { frames, error } = framer.push(Buffer.from(`${a}\n\n${b}\n`));
    expect(error).toBeUndefined();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ subscription_id: "sub-1" });
  });

  it("splits multi-byte characters safely across a chunk boundary", () => {
    const framer = new LineFramer();
    const line = Buffer.from(
      '{"version":1,"id":"x","outcome":{"status":"ok","value":{"type":"health","value":{"service":"vaultd\u{1F600}"}}}}\n',
      "utf8",
    );
    expect(framer.push(line.subarray(0, line.length - 3)).frames).toEqual([]);
    expect(framer.push(line.subarray(line.length - 3)).frames).toHaveLength(1);
  });

  it("reports FramingError on a non-JSON line without throwing", () => {
    const framer = new LineFramer();
    const { frames, error } = framer.push(Buffer.from("not json\n"));
    expect(frames).toEqual([]);
    expect(error).toBeInstanceOf(FramingError);
    expect(error?.line).toBe("not json");
  });

  it("keeps the good frames that arrived in the same chunk as a bad line", () => {
    const framer = new LineFramer();
    const good =
      '{"version":1,"id":"h-7","outcome":{"status":"ok","value":{"type":"health","value":{"service":"vaultd","status":"ok"}}}}';
    const later =
      '{"version":1,"id":"h-8","outcome":{"status":"ok","value":{"type":"health","value":{}}}}';
    const { frames, error } = framer.push(Buffer.from(`${good}\n{oops\n${later}\n`));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: "h-7" });
    expect(error).toBeInstanceOf(FramingError);
    expect(error?.line).toBe("{oops");
  });

  it("drops the rest of the buffer after a bad line, so a later push starts clean", () => {
    // The stream position is untrustworthy after a framing error, so the tail
    // of that chunk is discarded rather than re-parsed as if it were aligned.
    const framer = new LineFramer();
    framer.push(Buffer.from('{oops\n{"version":1,"id":"h-9",'));
    const good =
      '{"version":1,"id":"h-10","outcome":{"status":"ok","value":{"type":"health","value":{}}}}\n';
    const { frames, error } = framer.push(Buffer.from(good));
    expect(error).toBeUndefined();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: "h-10" });
  });

  it("reports a malformed envelope without stopping, and keeps the stream position", () => {
    // A line that parses as JSON but is not an envelope is a different failure
    // from a corrupt one: the stream is still byte-aligned, so the framer reads
    // on rather than discarding the buffer.
    const framer = new LineFramer();
    const good =
      '{"version":1,"id":"h-2","outcome":{"status":"ok","value":{"type":"health","value":{}}}}';
    const { frames, malformed, error } = framer.push(
      Buffer.from(`{"version":1,"id":"h-1"}\n${good}\n`),
    );
    expect(error).toBeUndefined();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: "h-2" });
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toBeInstanceOf(MalformedEnvelopeError);
    expect(malformed[0]?.id).toBe("h-1");
    expect(malformed[0]?.line).toBe('{"version":1,"id":"h-1"}');
  });

  it("claims no id when the malformed line named none", () => {
    const framer = new LineFramer();
    const { frames, malformed } = framer.push(Buffer.from('{"version":1}\n'));
    expect(frames).toEqual([]);
    expect(malformed[0]?.id).toBeNull();
  });

  it("refuses an outcome whose status it does not understand", () => {
    const framer = new LineFramer();
    const { malformed } = framer.push(
      Buffer.from('{"version":1,"id":"h-1","outcome":{"status":"maybe","value":{}}}\n'),
    );
    expect(malformed).toHaveLength(1);
  });

  it("refuses an error body whose fields are the wrong types", () => {
    const framer = new LineFramer();
    const { malformed } = framer.push(
      Buffer.from(
        '{"version":1,"id":"h-1","outcome":{"status":"err","value":{"code":5,"message":"nope"}}}\n',
      ),
    );
    expect(malformed).toHaveLength(1);
  });

  it("refuses an error body whose position is not a number, and accepts one that is", () => {
    const framer = new LineFramer();
    const bad = framer.push(
      Buffer.from(
        '{"version":1,"id":"h-1","outcome":{"status":"err","value":{"code":"query_invalid","message":"m","position":"3"}}}\n',
      ),
    );
    expect(bad.malformed).toHaveLength(1);
    const good = framer.push(
      Buffer.from(
        '{"version":1,"id":"h-2","outcome":{"status":"err","value":{"code":"query_invalid","message":"m","position":3}}}\n',
      ),
    );
    expect(good.malformed).toEqual([]);
    expect(good.frames).toHaveLength(1);
  });

  it("accepts an error body carrying only its two required fields", () => {
    const framer = new LineFramer();
    const { frames, malformed } = framer.push(
      Buffer.from(
        '{"version":1,"id":"h-1","outcome":{"status":"err","value":{"code":"internal","message":"boom"}}}\n',
      ),
    );
    expect(malformed).toEqual([]);
    expect(frames).toHaveLength(1);
  });

  it("accepts an unknown error code, and an unknown tail field, unchanged", () => {
    // Unknown-variant tolerance reaches the decoder too: a code this build has
    // never heard of is a widening, not a malformed line.
    const framer = new LineFramer();
    const { frames, malformed } = framer.push(
      Buffer.from(
        '{"version":1,"id":"h-1","outcome":{"status":"err","value":{"code":"from_the_future","message":"m","tomorrow":true}}}\n',
      ),
    );
    expect(malformed).toEqual([]);
    expect(frames).toHaveLength(1);
  });

  it("refuses an event line with no event type", () => {
    const framer = new LineFramer();
    const { malformed } = framer.push(
      Buffer.from('{"version":1,"subscription_id":"sub-1","event":{}}\n'),
    );
    expect(malformed).toHaveLength(1);
  });

  it("accepts an event kind it has never heard of", () => {
    const framer = new LineFramer();
    const { frames, malformed } = framer.push(
      Buffer.from(
        '{"version":1,"subscription_id":"sub-1","event":{"type":"from_the_future","value":{}}}\n',
      ),
    );
    expect(malformed).toEqual([]);
    expect(frames).toHaveLength(1);
  });

  it("encodes a request as one JSON line terminated by a single newline", () => {
    const encoded = LineFramer.encode({
      version: 1,
      id: "h-1",
      request: { method: "health" },
    });
    expect(encoded.toString("utf8")).toBe('{"version":1,"id":"h-1","request":{"method":"health"}}\n');
  });
});
