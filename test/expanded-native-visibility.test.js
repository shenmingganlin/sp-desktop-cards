import assert from "node:assert/strict";
import test from "node:test";
import { nativeHarness, POSITION } from "./expanded-native-harness.js";

const pair = { today: { visible: true, bounds: POSITION }, focus: { visible: true } };

test("N01: hideAll preserves a disabled card's pending destruction instead of stranding it", (t) => {
  // Replacing the close fade with a hide fade drops its destroy callback.
  const h = nativeHarness(pair);
  t.after(() => h.stop());
  h.start();
  const old = h.cards.window("today");
  h.set("today", false);
  h.clock.tick(32);
  h.trayClick();
  h.clock.tick(200);
  assert.equal(old.isDestroyed(), true, "an unchecked card must finish closing even during hideAll");
  h.trayClick();
  h.clock.tick(200);
  assert.equal(h.cards.window("today"), null, "showAll must not resurrect an unchecked card");
  h.clock.tick(1600);
  assert.equal(h.cards.window("today"), null, "intentional close must not schedule crash recovery");
  h.check("today", true);
  h.ready();
  h.clock.tick(200);
  assert.equal(h.cards.window("today").isVisible(), true);
});

test("N01: rechecking a surviving hidden card actually shows the same native window", (t) => {
  // A native hide can leave a usable instance; opacity alone is not visibility.
  const h = nativeHarness(pair);
  t.after(() => h.stop());
  h.start();
  const win = h.cards.window("today");
  win.hide(); // synthetic native boundary, as with an externally hidden surviving window
  h.set("today", true);
  h.clock.tick(200);
  assert.equal(h.cards.window("today"), win);
  assert.equal(win.isVisible(), true, "checking the card must show it, not merely raise opacity");
});

test("N01 control: rechecking during single-card fade cancels closing without replacing the window", (t) => {
  const h = nativeHarness(pair);
  t.after(() => h.stop());
  h.start();
  const win = h.cards.window("today");
  h.set("today", false);
  h.clock.tick(32);
  h.set("today", true);
  h.clock.tick(200);
  assert.equal(h.cards.window("today"), win);
  assert.equal(win.isVisible(), true);
  assert.equal(win.getOpacity(), 0.95);
});

test("N01 control: checking while hideAll is pending cancels closing before showAll", (t) => {
  const h = nativeHarness(pair);
  t.after(() => h.stop());
  h.start();
  const win = h.cards.window("today");
  h.set("today", false);
  h.clock.tick(32);
  h.trayClick();
  h.clock.tick(32);
  h.set("today", true);
  h.clock.tick(200);
  assert.equal(win.isDestroyed(), false);
  assert.equal(win.isVisible(), true);
  // A later unexpected native destruction must recover: no stale intentional-close flag.
  win.destroy();
  h.clock.tick(1500);
  h.ready();
  h.clock.tick(200);
  const replacement = h.cards.window("today");
  assert.ok(replacement, "rechecking must clear the intentional-close flag so crash recovery still works");
  assert.notEqual(replacement, win);
  assert.equal(replacement.isVisible(), true);
});

test("N01 control: ordinary hideAll cancellation and completed hide/show keep windows usable", (t) => {
  const h = nativeHarness(pair);
  t.after(() => h.stop());
  h.start();
  const win = h.cards.window("today");
  h.trayClick();
  h.clock.tick(32);
  h.trayClick();
  h.clock.tick(200);
  assert.equal(win.isVisible(), true);
  h.trayClick();
  h.clock.tick(200);
  assert.equal(win.isVisible(), false);
  h.trayClick();
  h.clock.tick(200);
  assert.equal(win.isVisible(), true);
  assert.equal(win.getOpacity(), 0.95);
});
