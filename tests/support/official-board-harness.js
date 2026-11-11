// Execute unmodified SP 20 sourcesContent with only import/type plumbing removed.
// The fixture contains code only, never user data. Hash drift fails the suite.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const fixtureRoot = new URL("./official-sp20/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", fixtureRoot), "utf8"));
assert.equal(manifest.installedVersion, "20.0.0");
assert.equal(manifest.sourceArchiveSha256, "1a3ac279e8b861fa92c907cd92a400dccf72de6737d4240a0e1307d14c6f4e1e");
const files = new Map(manifest.files.map((entry) => [entry.path, entry]));
function verifiedSource(relative) {
  const entry = files.get(relative);
  assert.ok(entry, `Official source missing from manifest: ${relative}`);
  const text = fs.readFileSync(new URL(relative, fixtureRoot), "utf8");
  assert.equal(crypto.createHash("sha256").update(text).digest("hex"), entry.sha256, `Official fixture drift: ${relative}`);
  return text;
}
function source(relative) {
  const text = verifiedSource(relative);
  const withoutImports = text.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\r?\n/gm, "");
  return stripTypeScriptTypes(withoutImports, { mode: "transform" }).replace(/^export\s+/gm, "");
}

// Retain and hash the entire official reducer. Execute only its completion
// cleanup helper: loading the whole root reducer would require unrelated state.
// Both declaration and following-function boundaries must match exactly once.
function completionCleanupSource() {
  const text = verifiedSource("src/app/root-store/meta/task-shared-meta-reducers/task-shared-crud.reducer.ts");
  assert.equal([...text.matchAll(/^const removeInProgressTagOnCompletion = \(/gm)].length, 1, "Official completion helper declaration changed");
  const matches = [...text.matchAll(/^const removeInProgressTagOnCompletion = \(\r?\n[\s\S]*?^};(?=\r?\n\r?\nconst handleUpdateTask = \()/gm)];
  assert.equal(matches.length, 1, "Official completion helper boundaries changed");
  return stripTypeScriptTypes(matches[0][0], { mode: "transform" });
}

// Default panels have no date/priority rules. Fail rather than silently model
// behavior if a future fixture starts requiring one of these dependencies.
const unused = () => { throw new Error("Date/priority custom views are outside this default-board harness"); };
const context = vm.createContext({
  Date,
  DEFAULT_TAG_COLOR: "unused", DEFAULT_TODAY_TAG_COLOR: "unused",
  WORK_CONTEXT_DEFAULT_COMMON: {}, WORK_CONTEXT_DEFAULT_THEME: {},
  T: { F: { BOARDS: { DEFAULT: new Proxy({}, { get: (_target, key) => String(key) }) } } },
  getDbDateStr: unused, isDBDateStr: unused, dateStrToUtcDate: unused,
  getWeekStartDate: unused, getTaskPriority: unused,
  getLogicalTodayStartMs: unused, isTaskOverdueByThreshold: unused,
});
const order = [
  "src/app/features/boards/boards.model.ts",
  "src/app/features/tag/tag.const.ts",
  "src/app/features/boards/boards.const.ts",
  "src/app/features/tasks/task-criteria/task-criteria.model.ts",
  "src/app/features/tasks/task-criteria/task-criteria.ts",
  "src/app/features/boards/boards.util.ts",
  "src/app/features/boards/board-panel/panel-rules.ts",
];
new vm.Script(order.map(source).join("\n") + "\n" + completionCleanupSource() + "\n;globalThis.official = { DEFAULT_BOARDS, URGENT_TAG, IMPORTANT_TAG, IN_PROGRESS_TAG, panelToCriteria, matchesTaskCriteria, getPanelChangesToMatch, removeInProgressTagOnCompletion };", { filename: "official-sp20-default-boards.js" }).runInContext(context);
const api = context.official;
const clone = (value) => JSON.parse(JSON.stringify(value));
const ctx = (raw) => {
  const projects = raw.projects || [];
  const backlogIds = new Set(projects.flatMap((project) => project.backlogTaskIds || []));
  return {
    todayStr: "2026-11-11", todayStartMs: 0, startOfNextDayDiffMs: 0,
    isInBacklog: (task) => backlogIds.has(task.parentId || task.id),
    isBacklogEnabled: (id) => projects.find((project) => project.id === id)?.isEnableBacklog === true,
  };
};

export const official = {
  version: manifest.installedVersion,
  archiveSha256: manifest.sourceArchiveSha256,
  boards: clone(api.DEFAULT_BOARDS),
  tags: clone([api.URGENT_TAG, api.IMPORTANT_TAG, api.IN_PROGRESS_TAG]),
  matches(panel, task, raw) { return api.matchesTaskCriteria(task, api.panelToCriteria(panel), ctx(raw)); },
  changes(panel, task, raw) {
    const value = api.getPanelChangesToMatch(task, api.panelToCriteria(panel), ctx(raw), new Set((raw.tags || []).map((tag) => tag.id)));
    return value === null ? null : clone(value);
  },
  // This is one actual official reducer step, not a simulated full server.
  completionUpdate(task, changes) {
    return clone(api.removeInProgressTagOnCompletion({ id: task.id, changes }, task));
  },
};
