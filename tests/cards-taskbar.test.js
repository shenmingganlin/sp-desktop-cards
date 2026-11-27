import assert from "node:assert/strict";
import test from "node:test";
import { cardsHost } from "./support/cards-host.js";

test("quick entry keeps an embedded card off the Windows taskbar", async (t) => {
  const { cards, created, ready } = await cardsHost({ mode: "desktop" });
  t.after(() => cards.quit());
  const [window] = created;
  ready(window);
  assert.equal(window.desktopAttached, true);
  assert.equal(window.focusable, false);
  assert.equal(window.skipTaskbar, true);

  cards.requestFocus("focus");
  assert.equal(window.isFocused(), true, "The embedded card can still accept keyboard input");
  assert.equal(window.desktopAttached, true);
  assert.equal(window.skipTaskbar, true, "Giving the card focus must not register a taskbar tab");

  window.blur();
  assert.equal(window.focusable, false);
  assert.equal(window.skipTaskbar, true);
  assert.equal(window.windowType, "toolbar", "Explorer must recognize a card as a tool window when showing it");
});

test("switching card modes and showing cards again keeps taskbar tabs hidden", async (t) => {
  const { cards, clock, created, data, ready } = await cardsHost({ mode: "desktop" });
  t.after(() => cards.quit());
  const [window] = created;
  ready(window);

  for (const mode of ["normal", "top", "desktop"]) {
    data.mode = mode;
    cards.applyMode();
    assert.equal(window.focusable, mode !== "desktop");
    assert.equal(window.desktopAttached, mode === "desktop");
    assert.equal(window.skipTaskbar, true, `${mode} card must remain off the taskbar`);
  }

  cards.hideAll();
  await clock.advance(160);
  assert.equal(window.isVisible(), false);
  window.skipTaskbar = false;
  cards.showAll();
  assert.equal(window.isVisible(), true);
  assert.equal(window.skipTaskbar, true);
});

test("reattaching an embedded card clears a stale taskbar tab without interrupting input", async (t) => {
  const { cards, clock, created, ready } = await cardsHost({ mode: "desktop" });
  t.after(() => cards.quit());
  const [window] = created;
  ready(window);
  cards.requestFocus("focus");

  window.desktopAttached = false;
  window.skipTaskbar = false;
  await clock.advance(5000);
  assert.equal(window.desktopAttached, true);
  assert.equal(window.skipTaskbar, true);
  assert.equal(window.isFocused(), true);
});
