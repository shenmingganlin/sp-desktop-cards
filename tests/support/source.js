import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Point this at the untouched baseline to run the same regression checks red.
export const sourceRoot = process.env.SPW_TEST_SOURCE_ROOT
  ? path.resolve(process.env.SPW_TEST_SOURCE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const readMainSource = (name) => fs.readFileSync(path.join(sourceRoot, "src/main", name), "utf8");
export const importMain = (name) => import(pathToFileURL(path.join(sourceRoot, "src/main", name)).href);
