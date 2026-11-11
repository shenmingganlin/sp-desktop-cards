import assert from "node:assert/strict";
import test from "node:test";
import { cardsHost } from "./support/cards-host.js";

async function hostOnSecondary() {
  const h = await cardsHost();
  const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  const secondary = { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } };
  h.screen.getAllDisplays = () => [primary, secondary];
  h.screen.getPrimaryDisplay = () => primary;
  const window = h.created[0];
  window.setBounds({ x: 2100, y: 100, width: 320, height: 132 });
  window.emit("move");
  h.ready(window);
  await h.clock.advance(160);
  let cursor = { x: 2100, y: 100 };
  h.screen.getCursorScreenPoint = () => cursor;
  return {
    ...h,
    cursor(point) { cursor = point; },
    removeSecondary(event = "display-removed") {
      h.screen.getAllDisplays = () => [primary];
      h.screen.emit(event, {}, secondary, ["bounds", "workArea", "scaleFactor"]);
    },
  };
}

test("display removal ends the old drag before rescuing and saving the card", async () => {
  const h = await hostOnSecondary();
  h.cards.dragStart("focus", true);
  h.cursor({ x: 2110, y: 100 });
  await h.clock.advance(16);
  h.removeSecondary();
  const rescued = h.cards.bounds("focus");
  assert.ok(rescued.x < 1920);
  h.cursor({ x: 2120, y: 110 });
  await h.clock.advance(32);
  assert.deepEqual(h.cards.bounds("focus"), rescued, "A stale drag snapshot cannot put the rescued card back on the removed display");
  assert.deepEqual(h.data.cards.focus.bounds, rescued);
  assert.equal(h.clock.tasks.size, 0, "The old drag interval is cancelled");
});

test("display metrics recovery ends the old resize before placing the card", async () => {
  const h = await hostOnSecondary();
  h.cards.resizeStart("focus", "e");
  h.cursor({ x: 2110, y: 100 });
  await h.clock.advance(16);
  h.removeSecondary("display-metrics-changed");
  const rescued = h.cards.bounds("focus");
  assert.ok(rescued.x < 1920);
  h.cursor({ x: 2130, y: 100 });
  await h.clock.advance(32);
  assert.deepEqual(h.cards.bounds("focus"), rescued, "A stale resize snapshot cannot undo display recovery");
  assert.deepEqual(h.data.cards.focus.bounds, rescued);
  assert.equal(h.clock.tasks.size, 0, "The old resize interval is cancelled");
});

for (const gesture of ["drag", "resize"]) {
  test(`native window destruction cancels its ${gesture} before delayed recreation`, async () => {
    const h = await hostOnSecondary();
    if (gesture === "drag") h.cards.dragStart("focus", true);
    else h.cards.resizeStart("focus", "e");
    h.cursor({ x: 2110, y: 100 });
    await h.clock.advance(16);
    h.created[0].destroy();
    assert.equal(h.clock.tasks.size, 1, "Only the existing delayed recreation remains, without an orphan gesture interval");
    await h.clock.advance(1500);
    const replacement = h.created[1];
    const restored = replacement.getBounds();
    h.ready(replacement);
    h.cursor({ x: 2150, y: 120 });
    await h.clock.advance(160);
    assert.deepEqual(replacement.getBounds(), restored, "The replacement cannot inherit the old window's gesture");
    assert.equal(h.clock.tasks.size, 0);
  });
}
