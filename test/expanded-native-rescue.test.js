import assert from "node:assert/strict";
import test from "node:test";
import { defaultSpot } from "../src/main/snap.js";
import { intersection, nativeHarness, PRIMARY } from "./expanded-native-harness.js";

function assertReachable(bounds, area) {
  // Check the real 34 DIP drag header, independently of isOnScreen's predicate.
  assert.ok(bounds.x >= area.x, "the left end of the title bar must not escape the work area");
  assert.ok(bounds.y >= area.y, "the title bar must not be above the work area");
  assert.ok(bounds.y + 34 <= area.y + area.height, "the full header height must remain reachable");
  assert.ok(intersection({ ...bounds, height: 34 }, area) >= Math.min(bounds.width, area.width) * 34,
    "the title bar must have a usable horizontal span");
}

test("N02 control: default layout still stacks at the right and opens a fitting left column", () => {
  const size = { width: 320, height: 300 };
  const first = defaultSpot(size, [], PRIMARY);
  assert.deepEqual(first, { x: 940, y: 20, width: 320, height: 300 });
  const second = defaultSpot(size, [first], PRIMARY);
  assert.deepEqual(second, { x: 940, y: 326, width: 320, height: 300 });
  const third = defaultSpot(size, [first, second], PRIMARY);
  assert.deepEqual(third, { x: 614, y: 20, width: 320, height: 300 });
});

for (const { name, size, area, placed = [] } of [
  { name: "tall wide card", size: { width: 600, height: 1000 }, area: PRIMARY },
  { name: "tall narrow card", size: { width: 240, height: 1000 }, area: PRIMARY },
  { name: "oversized width and height", size: { width: 1600, height: 1000 }, area: PRIMARY },
  { name: "narrow work area", size: { width: 320, height: 380 }, area: { x: 0, y: 0, width: 250, height: 180 } },
  { name: "offset work area", size: { width: 600, height: 1000 }, area: { x: -1280, y: 80, width: 1280, height: 720 } },
  { name: "occupied only fitting column", size: { width: 320, height: 300 }, area: { x: 0, y: 0, width: 350, height: 720 },
    placed: [{ x: 10, y: 20, width: 320, height: 680 }] },
]) {
  test(`N02: ${name} keeps a reachable header instead of searching off-screen columns`, () => {
    const spot = defaultSpot(size, placed, area);
    assert.equal(spot.width, size.width);
    assert.equal(spot.height, size.height);
    assertReachable(spot, area);
  });
}

test("N02: display removal rescues a genuinely resized tall card and remembers reachable bounds", (t) => {
  const secondary = { x: 1280, y: 0, width: 2560, height: 1440 };
  const h = nativeHarness({ today: { visible: true, bounds: { x: 1400, y: 100, width: 320, height: 380 } } },
    { areas: [PRIMARY, secondary] });
  t.after(() => h.stop());
  h.start();
  h.setCursor({ x: 1720, y: 480 });
  h.cards.resizeStart("today", "se");
  h.setCursor({ x: 2000, y: 1100 });
  h.clock.tick(16);
  h.cards.resizeEnd();
  assert.deepEqual({ ...h.cards.bounds("today") }, { x: 1400, y: 100, width: 600, height: 1000 });

  h.setAreas([PRIMARY]);
  h.screen.emit("display-removed");
  const after = h.cards.bounds("today");
  assertReachable(after, PRIMARY);
  assert.equal(after.width, 600);
  assert.equal(after.height, 1000);
  assert.deepEqual(h.settings.get().cards.today.bounds, { ...after }, "recovery must save the reachable placement");
  const saved = { ...after };
  h.screen.emit("display-metrics-changed");
  assert.deepEqual({ ...h.cards.bounds("today") }, saved, "later display events must not move the rescued card again");
});
