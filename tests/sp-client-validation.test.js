import assert from "node:assert/strict";
import test from "node:test";
import { importMain } from "./support/source.js";

const { createClient } = await importMain("sp-client.js");
const listMethods = ["todayTasks", "allTasks", "tags", "projects", "repeatCfgs"];
function clientWith(data) {
  return createClient({
    getToken: () => "isolated-test-token",
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ ok: true, data }) }),
  });
}

test("every list endpoint rejects null, primitive and array entries as a bad response", async () => {
  for (const entry of [null, "broken", 7, true, []]) {
    for (const method of listMethods) {
      await assert.rejects(clientWith([entry])[method](), { code: "SP_BAD_RESPONSE" }, `${method}: ${JSON.stringify(entry)}`);
    }
  }
});

test("empty lists and object entries retain their existing response behavior", async () => {
  for (const method of listMethods) {
    assert.deepEqual(await clientWith([])[method](), []);
    assert.deepEqual(await clientWith([{ id: "test", extra: "retained" }])[method](), [{ id: "test", extra: "retained" }]);
  }
});
