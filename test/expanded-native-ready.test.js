import assert from "node:assert/strict";
import test from "node:test";
import { nativeHarness } from "./expanded-native-harness.js";

async function hiddenPoll(h) {
  // Run the real timer callback and main onData/pushState, not a manual setIdle repair.
  await h.schedules.at(-1).fn();
  assert.equal(h.schedules.at(-1).ms, 10000);
}

async function assertVisibleTier(h) {
  h.rendererReady(); // The renderer's independent ready IPC must not be needed to repair visibility.
  await h.schedules.at(-1).fn();
  assert.deepEqual({
    shown: h.cards.isShown(),
    lastNotification: h.changes.at(-1),
    trayLabel: h.label(),
    nextPollMs: h.schedules.at(-1).ms,
  }, { shown: true, lastNotification: true, trayLabel: "隐藏全部卡片", nextPollMs: 2000 });
  await h.poller.kick();
  assert.equal(h.schedules.at(-1).ms, 2000, "full refresh must keep the visible polling tier");
}

test("N03: reopening the final card notifies actual main tray and poller after ready-to-show", async (t) => {
  const h = nativeHarness();
  t.after(() => h.stop());
  h.start();
  await h.poller.start();
  assert.equal(h.schedules.at(-1).ms, 2000);
  const old = h.cards.window("today");
  h.set("today", false);
  h.clock.tick(200);
  assert.equal(old.isDestroyed(), true);
  assert.equal(h.cards.isShown(), false);
  assert.equal(h.label(), "显示全部卡片");
  await hiddenPoll(h);

  h.set("today", true);
  assert.notEqual(h.cards.window("today"), old);
  assert.equal(h.cards.isShown(), false, "creation with show:false is not a visibility transition yet");
  assert.equal(h.label(), "显示全部卡片");
  h.ready();
  h.clock.tick(200);
  await assertVisibleTier(h);
});

test("N03: unexpected final-window destruction recovers the tray and visible polling tier", async (t) => {
  const h = nativeHarness();
  t.after(() => h.stop());
  h.start();
  await h.poller.start();
  const old = h.cards.window("today");
  old.destroy();
  assert.equal(h.cards.isShown(), false);
  assert.equal(h.label(), "显示全部卡片");
  await hiddenPoll(h);
  h.clock.tick(1500);
  const replacement = h.cards.window("today");
  assert.ok(replacement, "unexpected destruction must still recreate enabled cards");
  assert.notEqual(replacement, old);
  assert.equal(replacement.isVisible(), false);
  h.ready();
  h.clock.tick(200);
  await assertVisibleTier(h);
});

test("N03 control: initial ready-to-show also rebuilds the tray while keeping fast polling", async (t) => {
  const h = nativeHarness();
  t.after(() => h.stop());
  h.start();
  await h.poller.start();
  await assertVisibleTier(h);
});

test("N03 control: ready-to-show while hidden-all does not announce a visible card", async (t) => {
  const h = nativeHarness();
  t.after(() => h.stop());
  h.start();
  await h.poller.start();
  h.set("today", false);
  h.clock.tick(200);
  h.set("today", true);
  h.cards.hideAll();
  const notifications = h.changes.length;
  h.ready();
  h.clock.tick(200);
  assert.equal(h.changes.length, notifications, "suppressed ready-to-show must not report an actual show");
  assert.equal(h.cards.window("today").isVisible(), false);
  assert.equal(h.label(), "显示全部卡片");
  await hiddenPoll(h);
  h.trayClick();
  h.clock.tick(200);
  await assertVisibleTier(h);
});
