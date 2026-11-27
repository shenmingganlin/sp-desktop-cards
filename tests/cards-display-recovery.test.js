import assert from "node:assert/strict";
import test from "node:test";
import { cardsHost } from "./support/cards-host.js";

const primary = { id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
const secondary = { id: 2, scaleFactor: 1, workArea: { x: 1920, y: 0, width: 1920, height: 1080 } };
const remote = { id: 1, scaleFactor: 1.5, workArea: { x: 0, y: 0, width: 1280, height: 720 } };

function changeMetrics(host, display) {
  host.screen.getAllDisplays = () => [display];
  host.screen.emit("display-metrics-changed", {}, display, ["bounds", "workArea", "scaleFactor"]);
}

function nativeBounds(window, bounds) {
  window.setBounds(bounds);
  window.emit("move");
  window.emit("resize");
}

async function hostOnSecondary() {
  const bounds = { x: 2100, y: 100, width: 320, height: 132 };
  const h = await cardsHost({ bounds, displays: [primary, secondary] });
  h.ready(h.created[0]);
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
  assert.ok([...h.clock.tasks.values()].every((task) => !task.repeat), "The old drag interval is cancelled");
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
  assert.ok([...h.clock.tasks.values()].every((task) => !task.repeat), "The old resize interval is cancelled");
});

test("display metrics changes restore the user's size and position even after late native resize events", async () => {
  const bounds = { x: 112, y: 96, width: 320, height: 132 };
  const h = await cardsHost({ bounds, displays: [primary] });
  const [window] = h.created;
  h.ready(window);
  await h.clock.advance(160);

  let cursor = { x: 432, y: 228 };
  h.screen.getCursorScreenPoint = () => cursor;
  h.cards.resizeStart("focus", "se");
  cursor = { x: 512, y: 280 };
  await h.clock.advance(16);
  h.cards.resizeEnd();
  const chosen = { ...bounds, width: 400, height: 184 };
  assert.deepEqual(window.getBounds(), chosen);
  assert.deepEqual({ ...h.data.cards.focus.bounds }, chosen);

  nativeBounds(window, { x: 140, y: 110, width: 600, height: 276 });
  changeMetrics(h, remote);
  await h.clock.advance(32);
  nativeBounds(window, { x: 124, y: 120, width: 360, height: 166 });
  assert.deepEqual({ ...h.data.cards.focus.bounds }, chosen, "Native events must not overwrite the user's layout");
  await h.clock.advance(1000);
  assert.deepEqual(window.getBounds(), chosen, "The card is still on-screen, but its native dimensions need to be restored");

  changeMetrics(h, primary);
  await h.clock.advance(1000);
  assert.deepEqual(window.getBounds(), chosen);
  assert.deepEqual({ ...h.data.cards.focus.bounds }, chosen);
});

test("display recovery restores a collapsed header without losing its expanded height", async () => {
  const bounds = { x: 76, y: 88, width: 380, height: 176 };
  const h = await cardsHost({ bounds, displays: [primary] });
  const [window] = h.created;
  h.ready(window);
  await h.clock.advance(160);
  h.cards.setCollapsed("focus", true);
  const collapsed = window.getBounds();

  nativeBounds(window, { ...collapsed, width: 440, height: 51 });
  changeMetrics(h, remote);
  await h.clock.advance(1000);
  assert.deepEqual(window.getBounds(), collapsed);
  assert.deepEqual({ ...h.data.cards.focus.bounds }, bounds);

  h.cards.setCollapsed("focus", false);
  assert.deepEqual(window.getBounds(), bounds);
});

test("adding a display restores on-screen card bounds after a native size change", async () => {
  const bounds = { x: 96, y: 84, width: 372, height: 152 };
  const h = await cardsHost({ bounds, displays: [primary] });
  const [window] = h.created;
  h.ready(window);
  await h.clock.advance(160);
  nativeBounds(window, { ...bounds, width: 465, height: 190 });
  h.screen.getAllDisplays = () => [primary, secondary];
  h.screen.emit("display-added", {}, secondary);
  await h.clock.advance(1000);
  assert.deepEqual(window.getBounds(), bounds);
  assert.deepEqual({ ...h.data.cards.focus.bounds }, bounds);
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
