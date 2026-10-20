import { randomBytes } from "node:crypto";

/**
 * Who is looking at the page: the identity the viewer data store is keyed by.
 *
 * Plain CommonJS-friendly code with no host imports, so the web server can
 * `require` the compiled `dist/web/viewer-identity.js` directly.
 *
 * **Order.** The `Tailscale-User-Login` header that `tailscale serve` adds
 * wins (the same person on every device); with no such header, a cookie
 * `vaultd_viewer` holds a random 128-bit id, minted on the first visit.
 *
 * **Trust.** The header is trusted as-is, so the web server must only be
 * reachable through `tailscale serve` (bound to loopback). On any other
 * listener a client could send the header itself and read another viewer's
 * values.
 *
 * Owner ruling, 2026-10-19 (docs/design/web-plugins.md, owner decision 2).
 */

export const VIEWER_COOKIE = "vaultd_viewer";
export const TAILSCALE_LOGIN_HEADER = "tailscale-user-login";

/** 400 days, the longest a current browser keeps a cookie. */
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const COOKIE_ID = /^[0-9a-f]{32}$/;

export interface ViewerRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly socket?: { readonly encrypted?: boolean } | null;
}

export interface ResolvedViewer {
  readonly id: string;
  readonly source: "header" | "cookie" | "new";
  /** A `Set-Cookie` value to send, only when the id was just minted. */
  readonly setCookie: string | null;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The first well-formed `name=<32 hex>` pair; a malformed duplicate is skipped. */
function viewerCookie(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== VIEWER_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (COOKIE_ID.test(value)) return value;
  }
  return undefined;
}

function isHttps(req: ViewerRequest): boolean {
  if (req.socket?.encrypted === true) return true;
  const proto = first(req.headers["x-forwarded-proto"]);
  return proto !== undefined && proto.split(",")[0]?.trim().toLowerCase() === "https";
}

export function resolveViewer(req: ViewerRequest): ResolvedViewer {
  const login = first(req.headers[TAILSCALE_LOGIN_HEADER])?.trim();
  if (login !== undefined && login !== "") return { id: login, source: "header", setCookie: null };

  const held = viewerCookie(first(req.headers["cookie"]));
  if (held !== undefined) {
    return { id: held, source: "cookie", setCookie: null };
  }

  const id = randomBytes(16).toString("hex");
  const attributes = [
    `${VIEWER_COOKIE}=${id}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${String(COOKIE_MAX_AGE_SECONDS)}`,
  ];
  if (isHttps(req)) attributes.push("Secure");
  return { id, source: "new", setCookie: attributes.join("; ") };
}
