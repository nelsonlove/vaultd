/**
 * RFC 7396 JSON Merge Patch, for the viewer data store.
 *
 * **Own-property access only.** A saved settings document is `JSON.parse`
 * output, and `JSON.parse('{"__proto__": 1}')` makes a real own key of that
 * name. Reading `target["__proto__"]` when the key is absent returns
 * `Object.prototype`, and assigning to it changes a prototype; so every read
 * here asks `hasOwn` first and every write goes through `defineProperty`.
 *
 * **Null is "absent" (the one place this departs from a faithful copy).** RFC
 * 7396 uses `null` in a patch to mean "delete this key", so a patch cannot say
 * "set this key to null". The store's rule: {@link withoutNullKeys} drops
 * every object key whose value is `null` from a saved document, before the
 * diff, so a plugin that saves `{ a: null }` reads back `{}`. Arrays are not
 * touched (their elements are replaced whole, and a `null` element survives).
 * A plugin that tells `null` from `undefined` on a settings key would see the
 * difference; none in the corpus does, and the simpler rule beats a side
 * channel in a file that stays a plain RFC 7396 document.
 */

export type JsonObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function setOwn(object: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** A deep copy that keeps own `__proto__` keys as data. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Deep structural equality over JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

/** `value` as JSON would carry it, with every null-valued object key dropped. */
export function withoutNullKeys(value: unknown): unknown {
  const plain = JSON.parse(JSON.stringify(value ?? null)) as unknown;
  return strip(plain);
}

function strip(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item !== null) setOwn(out, key, strip(item));
  }
  return out;
}

/** RFC 7396 `MergePatch(Target, Patch)`. Returns a new value; inputs are not changed. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return clone(patch);
  const out: JsonObject = isPlainObject(target) ? clone(target) : {};
  for (const key of Object.keys(patch)) {
    const item = patch[key];
    if (item === null) {
      delete out[key];
    } else {
      setOwn(out, key, mergePatch(hasOwn(out, key) ? out[key] : undefined, item));
    }
  }
  return out;
}

/**
 * The patch that turns `base` into `next`: `mergePatch(base, patch)` equals
 * `next` when neither holds a null-valued object key (see the file header).
 * Objects are compared key by key; anything else, arrays included, is replaced
 * whole.
 */
export function diffMergePatch(base: unknown, next: unknown): unknown {
  const to = withoutNullKeys(next);
  const from = withoutNullKeys(base);
  return diff(from, to);
}

function diff(from: unknown, to: unknown): unknown {
  if (!isPlainObject(to) || !isPlainObject(from)) return to;
  const patch: JsonObject = {};
  for (const key of Object.keys(to)) {
    if (!hasOwn(from, key)) {
      setOwn(patch, key, to[key]);
    } else if (!jsonEqual(from[key], to[key])) {
      setOwn(patch, key, diff(from[key], to[key]));
    }
  }
  for (const key of Object.keys(from)) {
    if (!hasOwn(to, key)) setOwn(patch, key, null);
  }
  return patch;
}
