import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  pathCanAffectIndex,
  scanRootPaths,
  scanDirectoryPath,
  scanFilePath,
} from "../../dist/engine/pipeline/indexing/scanner/index.js";
import { createTemporaryDirectory } from "../helpers/fixtures.mjs";

const exec = promisify(execFile);
for (const pattern of ["/gen/*", "/gen/", "gen", "gen/**"]) {
  test(`ignored ancestors stay ignored after an explicit include (${pattern})`, async (t) => {
    const root = await createTemporaryDirectory(t, "zg-ignore-inheritance-");
    await exec("git", ["-C", root, "init", "--quiet"]);
    await mkdir(join(root, "gen/android/assets"), { recursive: true });
    await mkdir(join(root, "node_modules/package"), { recursive: true });
    await mkdir(join(root, "src"));
    await writeFile(join(root, ".gitignore"), `${pattern}\nnode_modules/\n`);
    await writeFile(
      join(root, "gen/android/keep.ts"),
      "export const keep = true;\n",
    );
    const ignored = join(root, "gen/android/assets/THIRD-PARTY.txt");
    await writeFile(ignored, "generated dependency notices\n");
    await writeFile(
      join(root, "node_modules/package/index.js"),
      "module.exports = true;\n",
    );
    await writeFile(join(root, "src/main.ts"), "export const main = true;\n");
    await exec("git", ["-C", root, "check-ignore", "--quiet", ignored]);
    const options = {
      absolutePath: root,
      recursive: true,
      include: ["**", "gen/android/keep.ts", "gen/android/.gitignore"],
    };
    const full = await scanRootPaths("test", [options]);
    assert.deepEqual(full.files.map((file) => file.relativePath).sort(), [
      "gen/android/keep.ts",
      "src/main.ts",
    ]);
    assert.equal(
      (await scanFilePath("test", [options], ignored)).files.length,
      0,
    );
    assert.equal(await pathCanAffectIndex([options], ignored, false), false);
    assert.deepEqual(
      (
        await scanDirectoryPath("test", [options], join(root, "gen/android"))
      ).files.map((file) => file.relativePath),
      ["gen/android/keep.ts"],
    );
    options.include = ["**", "gen/android/keep.ts"];
    await writeFile(
      join(root, "gen/android/.gitignore"),
      "!assets/\n!assets/**\n",
    );
    await exec("git", ["-C", root, "check-ignore", "--quiet", ignored]);
    assert.equal(
      (await scanFilePath("test", [options], ignored)).files.length,
      0,
      "a child ignore file cannot unignore an excluded parent",
    );
    assert.deepEqual(
      (await scanRootPaths("test", [options])).files
        .map((file) => file.relativePath)
        .sort(),
      ["gen/android/keep.ts", "src/main.ts"],
    );
    const excluded = await scanRootPaths("test", [
      { ...options, exclude: ["gen/**"] },
    ]);
    assert.deepEqual(
      excluded.files.map((file) => file.relativePath),
      ["src/main.ts"],
    );
    const explicitNoIgnore = await scanRootPaths("test", [
      { ...options, noIgnore: true },
    ]);
    assert.ok(
      explicitNoIgnore.files.some((file) =>
        file.relativePath.endsWith("THIRD-PARTY.txt"),
      ),
    );
    assert.ok(
      explicitNoIgnore.files.some((file) =>
        file.relativePath.startsWith("node_modules/"),
      ),
    );
  });
}
