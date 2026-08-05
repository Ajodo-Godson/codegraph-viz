import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inputFingerprint } from "../src/watch.ts";

test("input fingerprint tracks CodeGraph, Git, configuration, and trace changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-viz-watch-"));
  const projectPath = join(root, "project");
  const traceRoot = join(root, "traces");
  const explicitTrace = join(root, "events.jsonl");
  await mkdir(join(projectPath, ".codegraph"), { recursive: true });
  await mkdir(traceRoot, { recursive: true });
  await writeFile(join(projectPath, ".codegraph", "codegraph.db"), "db-1");
  await writeFile(join(projectPath, "src.ts"), "export const value = 1;\n");
  await writeFile(join(projectPath, "codegraph-viz.json"), "{}");
  await writeFile(join(traceRoot, "session.jsonl"), "event-1\n");
  await writeFile(explicitTrace, "explicit-1\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: projectPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Fixture User"], { cwd: projectPath });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: projectPath });
  execFileSync("git", ["add", "."], { cwd: projectPath });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: projectPath, stdio: "ignore" });
  const options = {
    projectPath,
    tracePaths: [explicitTrace],
    providers: ["codex" as const],
    traceRoots: { codex: traceRoot }
  };

  const initial = await inputFingerprint(options);
  await writeFile(join(projectPath, ".codegraph", "codegraph.db"), "db-22");
  const indexed = await inputFingerprint(options);
  await writeFile(join(projectPath, "src.ts"), "export const value = 222;\n");
  const committed = await inputFingerprint(options);
  await writeFile(join(traceRoot, "session.jsonl"), "event-222\n");
  const traced = await inputFingerprint(options);
  await writeFile(explicitTrace, "explicit-222\n");
  const explicit = await inputFingerprint(options);
  await writeFile(join(projectPath, "codegraph-viz.json"), "{\"rename\":{}}\n");
  const configured = await inputFingerprint(options);

  assert.equal(new Set([initial, indexed, committed, traced, explicit, configured]).size, 6);
});

test("input fingerprint can exclude automatic provider traces", async () => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-viz-watch-disabled-"));
  const projectPath = join(root, "project");
  const traceRoot = join(root, "traces");
  await mkdir(join(projectPath, ".codegraph"), { recursive: true });
  await mkdir(traceRoot);
  await writeFile(join(projectPath, ".codegraph", "codegraph.db"), "db");
  await writeFile(join(traceRoot, "session.jsonl"), "event-1\n");
  const options = { projectPath, autoTraces: false, traceRoots: { codex: traceRoot } };
  const initial = await inputFingerprint(options);
  await writeFile(join(traceRoot, "session.jsonl"), "event-222\n");
  assert.equal(await inputFingerprint(options), initial);
});
