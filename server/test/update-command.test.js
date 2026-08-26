import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const updateCommand = path.join(projectRoot, "update.command");

test("update command exposes the safe manual sync workflow", () => {
  assert.equal(fs.existsSync(updateCommand), true);
  const result = spawnSync("zsh", [updateCommand, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /拉取 GitHub 最新代码/);
  assert.match(result.stdout, /保留当前电脑的本地配置/);
  assert.match(result.stdout, /重启并检查本地服务/);
  assert.match(result.stdout, /重新加载/);
});

test("update command is valid zsh", () => {
  const result = spawnSync("zsh", ["-n", updateCommand], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
