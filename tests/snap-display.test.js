import assert from "node:assert/strict";
import test from "node:test";
import { importMain } from "./support/source.js";

const { defaultSpot } = await importMain("snap.js");
const primary = { x: 0, y: 0, width: 1920, height: 1080 };
const size = { width: 320, height: 380 };

test("a card on the lower monitor does not occupy a column on the primary monitor", () => {
  const lowerMonitorCard = { x: 1580, y: 1100, width: 320, height: 380 };
  assert.deepEqual(defaultSpot(size, [lowerMonitorCard], primary), { x: 1580, y: 20, ...size });
});

test("a card on the upper monitor cannot pull a new card above its target work area", () => {
  const upperMonitorCard = { x: 1580, y: -400, width: 320, height: 380 };
  assert.deepEqual(defaultSpot(size, [upperMonitorCard], primary), { x: 1580, y: 20, ...size });
});

test("display-local placement also works when the target work area has negative coordinates", () => {
  const target = { x: -1920, y: -1080, width: 1920, height: 1080 };
  const cardOnAnotherMonitor = { x: -340, y: 20, width: 320, height: 380 };
  assert.deepEqual(defaultSpot(size, [cardOnAnotherMonitor], target), { x: -340, y: -1060, ...size });
});

test("cards in the target work area still stack with the existing gap", () => {
  const first = { x: 1580, y: 20, ...size };
  const next = { width: 320, height: 132 };
  assert.deepEqual(defaultSpot(next, [first], primary), { x: 1580, y: 406, ...next });
});

test("a full column in the target work area still moves the new card into the next column", () => {
  const tall = { x: 1580, y: 20, width: 320, height: 1020 };
  assert.deepEqual(defaultSpot(size, [tall], primary), { x: 1254, y: 20, ...size });
});

test("a card spanning into the target display still occupies its visible part of the column", () => {
  const spanning = { x: 1580, y: -200, width: 320, height: 400 };
  assert.deepEqual(defaultSpot(size, [spanning], primary), { x: 1580, y: 206, ...size });
});
