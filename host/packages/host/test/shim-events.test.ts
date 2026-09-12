/**
 * The event bus's own test.
 *
 * `ShimEventBus` is the one piece of shim machinery Task 6b builds ahead of its
 * consumers, and by Task 14b five surfaces and every loaded plugin depend on
 * it. Its semantics are not obvious — `off` matches a callback while `offref`
 * matches a registration, a throwing handler must not cost the other plugins
 * their event, and the attribution that names the plugin whose handler threw is
 * ambient rather than passed — so each one is pinned here, where it is cheap,
 * rather than discovered later from a failure three layers away.
 *
 * Every case below fails under a one-line change to `src/shim/events.ts`, which
 * is the only thing that makes it worth writing.
 */

import { describe, expect, it } from "vitest";

import { Events, ShimEventBus } from "../src/shim/events";
import type { EventCallback } from "../src/shim/events";

/** A listener that records the order it was called in, into a shared array. */
function recorder(log: string[], name: string): EventCallback {
  return () => {
    log.push(name);
  };
}

describe("ShimEventBus fan-out", () => {
  it("calls listeners in registration order", () => {
    const bus = new ShimEventBus();
    const log: string[] = [];
    bus.on("changed", recorder(log, "first"));
    bus.on("changed", recorder(log, "second"));
    bus.on("changed", recorder(log, "third"));
    bus.trigger("changed");
    expect(log).toEqual(["first", "second", "third"]);
  });

  it("passes every argument through to each listener", () => {
    const bus = new ShimEventBus();
    const seen: unknown[][] = [];
    bus.on("changed", (...data: unknown[]) => {
      seen.push(data);
    });
    bus.trigger("changed", ...(["A.md", 7] as never[]));
    expect(seen).toEqual([["A.md", 7]]);
  });

  it("triggers nothing for an event nobody listens to", () => {
    const bus = new ShimEventBus();
    expect(() => {
      bus.trigger("nobody-home");
    }).not.toThrow();
    expect(bus.count("nobody-home")).toBe(0);
  });

  it("does not call a listener registered from inside the event it is handling", () => {
    // The set is copied before iteration, so a registration made during a
    // fan-out joins the *next* one. Without the copy this either skips a
    // listener or loops forever, depending on the engine — and `registerEvent`
    // inside a `layout-ready` handler is an everyday plugin shape.
    const bus = new ShimEventBus();
    const log: string[] = [];
    bus.on("ready", () => {
      log.push("outer");
      bus.on("ready", recorder(log, "inner"));
    });

    bus.trigger("ready");
    expect(log).toEqual(["outer"]);
    bus.trigger("ready");
    expect(log).toEqual(["outer", "outer", "inner"]);
  });
});

describe("ShimEventBus detachment", () => {
  it("offref detaches exactly one of two identical registrations", () => {
    // The whole reason `EventRef` exists: the same function registered twice is
    // two registrations, and `Component.registerEvent` keeps the ref precisely
    // so it can drop its own without touching anyone else's.
    const bus = new ShimEventBus();
    let calls = 0;
    const callback = (() => {
      calls += 1;
    }) as EventCallback;
    const first = bus.on("changed", callback);
    bus.on("changed", callback);
    expect(bus.count("changed")).toBe(2);

    bus.offref(first);
    expect(bus.count("changed")).toBe(1);
    bus.trigger("changed");
    expect(calls).toBe(1);
  });

  it("off detaches every registration of that callback", () => {
    const bus = new ShimEventBus();
    let calls = 0;
    const callback = (() => {
      calls += 1;
    }) as EventCallback;
    bus.on("changed", callback);
    bus.on("changed", callback);
    bus.off("changed", callback);

    expect(bus.count("changed")).toBe(0);
    bus.trigger("changed");
    expect(calls).toBe(0);
  });

  it("leaves other callbacks and other events alone", () => {
    const bus = new ShimEventBus();
    const log: string[] = [];
    const going = recorder(log, "going");
    bus.on("changed", going);
    bus.on("changed", recorder(log, "staying"));
    bus.on("renamed", going);

    bus.off("changed", going);
    bus.trigger("changed");
    bus.trigger("renamed");
    expect(log).toEqual(["staying", "going"]);
  });

  it("detaching twice is harmless, and so is detaching what was never there", () => {
    const bus = new ShimEventBus();
    const ref = bus.on("changed", () => undefined);
    ref.detach();
    expect(() => {
      ref.detach();
    }).not.toThrow();
    expect(() => {
      bus.off("changed", () => undefined);
    }).not.toThrow();
    expect(bus.count()).toBe(0);
  });
});

describe("ShimEventBus attribution and failure", () => {
  it("a throwing listener does not stop the others, and is reported with its owner", () => {
    // Task 14b quarantines the plugin whose handler threw, so "whose" has to
    // survive the throw. And a plugin's exception must not cost every other
    // plugin its event — a shim that let one bad handler end the fan-out would
    // produce failures that look like the *other* plugin's bug.
    const bus = new ShimEventBus();
    const failures: Array<{ event: string; owner: string | null }> = [];
    bus.onHandlerError((failure) => {
      failures.push({ event: failure.event, owner: failure.owner });
    });

    const log: string[] = [];
    bus.attributingTo("plugin-a", () => {
      bus.on("changed", () => {
        throw new Error("boom");
      });
    });
    bus.attributingTo("plugin-b", () => {
      bus.on("changed", recorder(log, "b"));
    });
    bus.on("changed", recorder(log, "host"));

    bus.trigger("changed");
    expect(log).toEqual(["b", "host"]);
    expect(failures).toEqual([{ event: "changed", owner: "plugin-a" }]);
  });

  it("attributes a registration to whichever load is running, and to nobody outside one", () => {
    const bus = new ShimEventBus();
    bus.attributingTo("plugin-a", () => {
      bus.on("changed", () => undefined);
    });
    bus.attributingTo("plugin-b", () => {
      bus.on("changed", () => undefined);
    });
    bus.on("changed", () => undefined);

    expect(bus.owners("changed")).toEqual(["plugin-a", "plugin-b", null]);
    expect(bus.attribution()).toBeNull();
  });

  it("restores the previous attribution even when the load throws", () => {
    const bus = new ShimEventBus();
    expect(() =>
      bus.attributingTo("plugin-a", () => {
        throw new Error("onload failed");
      }),
    ).toThrow(/onload failed/);
    bus.on("changed", () => undefined);
    expect(bus.owners("changed")).toEqual([null]);
  });

  it("detachOwner drops one plugin's listeners across every event", () => {
    const bus = new ShimEventBus();
    const log: string[] = [];
    bus.attributingTo("plugin-a", () => {
      bus.on("changed", recorder(log, "a-changed"));
      bus.on("renamed", recorder(log, "a-renamed"));
    });
    bus.attributingTo("plugin-b", () => {
      bus.on("changed", recorder(log, "b-changed"));
    });
    expect(bus.count()).toBe(3);

    expect(bus.detachOwner("plugin-a")).toBe(2);
    expect(bus.count()).toBe(1);
    bus.trigger("changed");
    bus.trigger("renamed");
    expect(log).toEqual(["b-changed"]);
  });

  it("a failure listener that throws does not break the fan-out", () => {
    const bus = new ShimEventBus();
    bus.onHandlerError(() => {
      throw new Error("the reporter is broken too");
    });
    const log: string[] = [];
    bus.on("changed", () => {
      throw new Error("boom");
    });
    bus.on("changed", recorder(log, "after"));

    expect(() => {
      bus.trigger("changed");
    }).not.toThrow();
    expect(log).toEqual(["after"]);
  });

  it("stops reporting to a failure listener that detached", () => {
    const bus = new ShimEventBus();
    let reports = 0;
    const stop = bus.onHandlerError(() => {
      reports += 1;
    });
    bus.on("changed", () => {
      throw new Error("boom");
    });

    bus.trigger("changed");
    expect(reports).toBe(1);
    stop();
    bus.trigger("changed");
    expect(reports).toBe(1);
  });
});

describe("Events, the base every shim surface extends", () => {
  class VaultSurface extends Events {
    protected override prefix(): string {
      return "vault";
    }
  }

  it("scopes a surface's events so two surfaces can both have a rename", () => {
    // One bus serves every surface, and `rename` means different things on the
    // vault and on the workspace. Without the prefix the two would collide and
    // a workspace listener would hear vault renames.
    const bus = new ShimEventBus();
    const surface = new VaultSurface(bus);
    const log: string[] = [];
    surface.on("rename", recorder(log, "surface"));

    expect(bus.count("vault:rename")).toBe(1);
    bus.trigger("rename");
    expect(log).toEqual([]);

    bus.trigger("vault:rename");
    expect(log).toEqual(["surface"]);
    surface.trigger("rename");
    expect(log).toEqual(["surface", "surface"]);
  });

  it("unscoped by default, so a surface that wants raw names gets them", () => {
    const bus = new ShimEventBus();
    const plain = new Events(bus);
    const log: string[] = [];
    plain.on("changed", recorder(log, "plain"));
    expect(bus.count("changed")).toBe(1);
    bus.trigger("changed");
    expect(log).toEqual(["plain"]);
  });

  it("off and offref both reach a surface's scoped registration", () => {
    const bus = new ShimEventBus();
    const surface = new VaultSurface(bus);
    const callback: EventCallback = () => undefined;

    const ref = surface.on("rename", callback);
    surface.offref(ref);
    expect(bus.count("vault:rename")).toBe(0);

    surface.on("rename", callback);
    surface.off("rename", callback);
    expect(bus.count("vault:rename")).toBe(0);
  });
});
