import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import vm from "node:vm";
import { downloadFile } from "../src/main/update.js";
import { windowAlive } from "../src/main/win.js";
import { deferred, loadModule, mainSection, tempDirectory } from "./expanded-persistence-harness.js";

const bytes = Buffer.alloc(32 * 1024, 65);
const response = () => new Response(bytes, { headers: { "content-length": String(bytes.length) } });
function downloadHarness(t, { fsImpl = fs, readable = Readable, afterDownload } = {}) {
  const dir = tempDirectory(t), events = [], prompts = [];
  const updateModule = loadModule("update.js", {
    fs: fsImpl, path, Readable: readable, Transform, pipeline, AbortSignal, fetch: async () => response(),
  });
  const updateWin = { webContents: {}, isDestroyed: () => false, isVisible: () => true };
  let invoke;
  const context = vm.createContext({
    fs, AbortController, downloadAbort: null, updateWin, windowAlive,
    cards: { typeOf: () => null }, settingsWin: null, appearanceWin: null, hotkeyWin: null, toast: null, tourWin: null,
    updateCheck: { artifactName: () => "synthetic.bin", async downloadFile(...args) {
      const file = await updateModule.downloadFile(...args);
      afterDownload?.(() => invoke({ sender: updateWin.webContents }, "cancel", {}));
      return file;
    } },
    updatesDir: () => dir, openUpdateWindow() {}, sendUpdate: (event) => events.push(event),
    askBox: async (prompt) => { prompts.push(prompt); return 1; }, closeUpdateWindow() {},
    installUpdate: () => assert.fail("must never run an installer"), OK: { ok: true },
    ipcMain: { handle(_name, fn) { invoke = fn; } },
  });
  vm.runInContext(mainSection("async function downloadUpdate(", "/**\n * 看看有没有新版本")
    + mainSection("const updateActions =", 'ipcMain.on("ready"'), context);
  return {
    dir, events, prompts,
    cancel: () => invoke({ sender: updateWin.webContents }, "cancel", {}),
    run: () => context.downloadUpdate({ version: "0.0.0", setup: { url: "https://synthetic.invalid/setup" } }),
  };
}
function assertCancelled(h) {
  assert.equal(h.events.some((event) => event.type === "done"), false, "cancel must not publish completion");
  assert.equal(h.prompts.length, 0, "cancel must not ask to install");
  assert.equal(h.events.at(-1)?.type, "failed");
  assert.deepEqual(fs.readdirSync(h.dir), [], "neither part nor committed download may survive cancellation");
}

// Keep a real fs.WriteStream backed by a real file; gate only its native write completion callback.
// A fetch-only signal cannot abort this writable after the response Readable has ended.
test("P03: cancel after body end while real fs.WriteStream is unfinished blocks done and install prompt", { timeout: 5000 }, async (t) => {
  const bodyEnd = deferred(), nativeWrite = deferred(), releaseWrite = deferred();
  let writable;
  const gateCallback = (fn) => (...args) => {
    const callback = args.pop();
    fn(...args, (...result) => {
      nativeWrite.resolve();
      releaseWrite.promise.then(() => callback(...result));
    });
  };
  const h = downloadHarness(t, {
    fsImpl: { ...fs, createWriteStream(file) {
      writable = fs.createWriteStream(file, { fs: { ...fs, write: gateCallback(fs.write), writev: gateCallback(fs.writev) } });
      return writable;
    } },
    readable: { fromWeb(body) {
      const input = Readable.fromWeb(body);
      input.once("end", bodyEnd.resolve);
      return input;
    } },
  });
  const running = h.run();
  try {
    await Promise.all([bodyEnd.promise, nativeWrite.promise]);
    assert.ok(writable instanceof fs.WriteStream);
    assert.equal(writable.writableFinished, false);
    assert.equal(writable.closed, false);
    assert.equal((await h.cancel()).ok, true);
  } finally {
    releaseWrite.resolve();
  }
  await running;
  assertCancelled(h);
});

for (const boundary of ["before-rename", "after-rename"]) {
  test(`P03: cancellation at ${boundary} cannot commit the download or request installation`, async (t) => {
    let h, cancelled = false;
    h = downloadHarness(t, { fsImpl: { ...fs,
      rmSync(file, options) {
        const result = fs.rmSync(file, options);
        if (boundary === "before-rename" && file === path.join(h.dir, "synthetic.bin") && !cancelled) {
          cancelled = true;
          void h.cancel();
        }
        return result;
      },
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (boundary === "after-rename") { cancelled = true; void h.cancel(); }
      },
    } });
    await h.run();
    assert.equal(cancelled, true, "the controlled commit boundary must have been reached");
    assertCancelled(h);
  });
}

test("P03: cancel at download resolution is checked before done and installation confirmation", async (t) => {
  const h = downloadHarness(t, { afterDownload: (cancel) => { void cancel(); } });
  await h.run();
  assertCancelled(h);
});

test("P03 control: an uncancelled real-stream download commits exact bytes and prompts once", async (t) => {
  const h = downloadHarness(t);
  await h.run();
  assert.equal(h.events.at(-1).type, "done");
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(h.dir, "synthetic.bin")), bytes);
  assert.equal(fs.existsSync(path.join(h.dir, "synthetic.bin.part")), false);
});

test("P03: cancellation during stream progress removes the partial file", async (t) => {
  const dir = tempDirectory(t), controller = new AbortController();
  const body = new ReadableStream({ start(stream) { stream.enqueue(bytes); stream.close(); } });
  const result = downloadFile("https://synthetic.invalid/setup", dir, "synthetic.bin", {
    signal: controller.signal,
    fetchImpl: async () => ({ ok: true, body, headers: new Headers() }),
    onProgress() { controller.abort(); },
  });
  await assert.rejects(result, { name: "AbortError" });
  assert.deepEqual(fs.readdirSync(dir), []);
});
