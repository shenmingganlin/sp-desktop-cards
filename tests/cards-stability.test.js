import assert from "node:assert/strict";
import test from "node:test";
import { cardsHost } from "./support/cards-host.js";

test("a crashed renderer rebuilds after the existing delay and retains card settings", async () => {
  const h = await cardsHost();
  const original = h.created[0];
  h.ready(original);
  await h.clock.advance(160);
  h.crash(original);
  assert.equal(original.isDestroyed(), true);
  await h.clock.advance(1499);
  assert.equal(h.created.length, 1);
  await h.clock.advance(1);
  assert.equal(h.created.length, 2);
  const recovered = h.created[1];
  h.ready(recovered);
  await h.clock.advance(160);
  assert.equal(recovered.isVisible(), true);
  assert.deepEqual(recovered.getBounds(), h.data.cards.focus.bounds);
  assert.equal(recovered.clickThrough, true);
  assert.equal(recovered.getOpacity(), 0.95);
  assert.equal(h.data.cards.focus.visible, true);
});

test("renderer recovery preserves global hiding until Show All", async () => {
  const h = await cardsHost();
  h.ready(h.created[0]);
  await h.clock.advance(160);
  h.cards.hideAll();
  await h.clock.advance(160);
  h.crash(h.created[0], "oom");
  await h.clock.advance(1500);
  assert.equal(h.created.length, 2);
  h.ready(h.created[1]);
  assert.equal(h.created[1].isVisible(), false);
  assert.equal(h.cards.isShown(), false);
  h.cards.showAll();
  await h.clock.advance(160);
  assert.equal(h.created[1].isVisible(), true);
});

test("intentional card closure does not trigger crash recovery", async () => {
  const h = await cardsHost();
  h.ready(h.created[0]);
  await h.clock.advance(160);
  h.cards.setVisible("focus", false);
  h.crash(h.created[0]);
  await h.clock.advance(2000);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].isDestroyed(), true);
  assert.equal(h.data.cards.focus.visible, false);
});

test("quit suppresses new crashes and already queued recovery", async () => {
  const beforeCrash = await cardsHost();
  beforeCrash.cards.quit();
  beforeCrash.crash(beforeCrash.created[0]);
  await beforeCrash.clock.advance(2000);
  assert.equal(beforeCrash.created[0].isDestroyed(), false);
  assert.equal(beforeCrash.created.length, 1);

  const afterCrash = await cardsHost();
  afterCrash.crash(afterCrash.created[0]);
  assert.equal(afterCrash.created[0].isDestroyed(), true);
  afterCrash.cards.quit();
  await afterCrash.clock.advance(2000);
  assert.equal(afterCrash.created.length, 1);
});

test("clean renderer exit and stale renderer events do not destroy the current card", async () => {
  const h = await cardsHost();
  const original = h.created[0];
  h.crash(original, "clean-exit");
  assert.equal(original.isDestroyed(), false);
  h.crash(original, "killed");
  await h.clock.advance(1500);
  assert.equal(h.created.length, 2);
  h.crash(original);
  await h.clock.advance(2000);
  assert.equal(h.created.length, 2);
  assert.equal(h.created[1].isDestroyed(), false);
});
