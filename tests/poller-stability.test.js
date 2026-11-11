import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "./support/clock.js";
import { importMain } from "./support/source.js";

const { createPoller } = await importMain("poller.js");
const { createClient } = await importMain("sp-client.js");
const emptyClient = () => ({
  current: async () => null, focus: async () => ({}),
  todayTasks: async () => [], allTasks: async () => [], tags: async () => [],
  projects: async () => [], repeatCfgs: async () => [],
});
const makePoller = (clock, options) => createPoller({
  now: () => clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout,
  ...options,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("throwing data and error callbacks cannot terminate automatic retry", async () => {
  const clock = new Clock();
  let dataCalls = 0, errors = 0;
  const poller = makePoller(clock, {
    client: emptyClient(),
    onData() { if (++dataCalls === 1) throw new Error("view failed"); },
    onError() { errors += 1; throw new Error("error view failed"); },
  });
  await assert.doesNotReject(poller.start());
  assert.equal(errors, 1);
  assert.deepEqual(clock.delays(), [5000]);
  await clock.advance(5000);
  assert.equal(dataCalls, 2);
  assert.deepEqual(clock.delays(), [2000]);
  poller.stop();
});

test("a throwing error callback cannot stop retries after a transport failure", async () => {
  const clock = new Clock();
  let offline = true, errors = 0, snapshots = 0;
  const client = emptyClient();
  client.current = async () => { if (offline) throw new Error("offline"); return null; };
  const poller = makePoller(clock, {
    client, onData() { snapshots += 1; }, onError() { errors += 1; throw new Error("error callback failed"); },
  });
  await assert.doesNotReject(poller.start());
  assert.equal(errors, 1);
  offline = false;
  await clock.advance(5000);
  assert.equal(snapshots, 1);
  assert.deepEqual(clock.delays(), [2000]);
  poller.stop();
});

test("a malformed list keeps the last good snapshot and recovers on the automatic retry", async () => {
  const clock = new Clock();
  let stage = "good";
  const snapshots = [], errors = [];
  const client = createClient({
    getToken: () => "isolated-test-token",
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      const data = pathname === "/task-control/current" ? null
        : pathname === "/focus" ? {}
          : pathname === "/tags" ? stage === "bad" ? [null] : [{ id: stage }]
            : pathname === "/tasks" ? [{ id: stage, title: stage }]
              : [];
      return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, data }) };
    },
  });
  const poller = makePoller(clock, { client, onData: (data) => snapshots.push(data), onError: (error) => errors.push(error) });
  await poller.start();
  const good = snapshots[0];
  stage = "bad";
  await poller.kick();
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0], good);
  assert.equal(snapshots[0].tags[0].id, "good");
  assert.equal(errors[0]?.code, "SP_BAD_RESPONSE");
  assert.deepEqual(clock.delays(), [5000]);
  stage = "recovered";
  await clock.advance(5000);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].tags[0].id, "recovered");
  assert.equal(snapshots[1].allTasks[0].id, "recovered");
  poller.stop();
});

test("stop discards in-flight data and a queued kick without reviving polling", async () => {
  const clock = new Clock();
  const gate = deferred();
  let requests = 0, snapshots = 0, errors = 0;
  const client = emptyClient();
  client.current = () => { requests += 1; return gate.promise; };
  const poller = makePoller(clock, { client, onData() { snapshots += 1; }, onError() { errors += 1; } });
  const first = poller.start();
  const queued = poller.kick();
  poller.stop();
  gate.resolve(null);
  await Promise.all([first, queued]);
  await clock.advance(20_000);
  assert.equal(requests, 1);
  assert.equal(snapshots, 0);
  assert.equal(errors, 0);
  assert.equal(clock.tasks.size, 0);
});

test("stop discards a late request error and leaves no retry", async () => {
  const clock = new Clock();
  const gate = deferred();
  let errors = 0;
  const client = emptyClient();
  client.current = () => gate.promise;
  const poller = makePoller(clock, { client, onData() {}, onError() { errors += 1; } });
  const first = poller.start();
  poller.stop();
  gate.reject(new Error("late failure"));
  await first;
  assert.equal(errors, 0);
  assert.equal(clock.tasks.size, 0);
});

test("stop cancels a scheduled retry and only explicit start resumes polling", async () => {
  const clock = new Clock();
  let requests = 0, offline = true;
  const client = emptyClient();
  client.current = async () => { requests += 1; if (offline) throw new Error("offline"); return null; };
  const poller = makePoller(clock, { client, onData() {}, onError() {} });
  await poller.start();
  assert.deepEqual(clock.delays(), [5000]);
  poller.stop();
  offline = false;
  await poller.kick();
  await poller.poll();
  await clock.advance(20_000);
  assert.equal(requests, 1);
  assert.equal(clock.tasks.size, 0);
  await poller.start();
  assert.equal(requests, 2);
  assert.deepEqual(clock.delays(), [2000]);
  poller.stop();
});
