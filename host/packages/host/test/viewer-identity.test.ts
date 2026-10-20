import { describe, expect, it } from "vitest";
import { VIEWER_COOKIE, resolveViewer } from "../src/web/viewer-identity";

const req = (headers: Record<string, string>, encrypted = false) => ({
  headers,
  socket: { encrypted },
});

describe("resolveViewer", () => {
  it("takes the Tailscale login header first, trimmed, and sets no cookie", () => {
    const got = resolveViewer(
      req({ "tailscale-user-login": "  ann@example.com ", cookie: `${VIEWER_COOKIE}=${"a".repeat(32)}` }),
    );
    expect(got).toEqual({ id: "ann@example.com", source: "header", setCookie: null });
  });

  it("ignores an empty header and falls back to the cookie", () => {
    const got = resolveViewer(req({ "tailscale-user-login": "   " }));
    expect(got.source).toBe("new");
    expect(got.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates a 128-bit id with a hardened cookie, then reuses it", () => {
    const first = resolveViewer(req({}));
    expect(first.source).toBe("new");
    expect(first.setCookie).toContain(`${VIEWER_COOKIE}=${first.id}`);
    expect(first.setCookie).toContain("HttpOnly");
    expect(first.setCookie).toContain("SameSite=Lax");
    expect(first.setCookie).toContain("Path=/");
    expect(first.setCookie).not.toContain("Secure");
    const again = resolveViewer(req({ cookie: `other=1; ${VIEWER_COOKIE}=${first.id}; x=y` }));
    expect(again).toEqual({ id: first.id, source: "cookie", setCookie: null });
  });

  it("adds Secure over https, by socket or by forwarded protocol", () => {
    expect(resolveViewer(req({}, true)).setCookie).toContain("Secure");
    expect(resolveViewer(req({ "x-forwarded-proto": "https" })).setCookie).toContain("Secure");
  });

  it("replaces a malformed cookie instead of trusting it", () => {
    const got = resolveViewer(req({ cookie: `${VIEWER_COOKIE}=../../x` }));
    expect(got.source).toBe("new");
    expect(got.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("takes the first well-formed cookie when the name is repeated", () => {
    const good = "b".repeat(32);
    const got = resolveViewer(req({ cookie: `${VIEWER_COOKIE}=bad; ${VIEWER_COOKIE}=${good}; ${VIEWER_COOKIE}=${"c".repeat(32)}` }));
    expect(got).toEqual({ id: good, source: "cookie", setCookie: null });
  });

  it("makes different ids for different first visits", () => {
    expect(resolveViewer(req({})).id).not.toBe(resolveViewer(req({})).id);
  });
});
