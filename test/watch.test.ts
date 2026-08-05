import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { get } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inputFingerprint, startLiveVisualization } from "../src/watch.ts";
import { createCodeGraphProject, insertFile } from "./fixtures.ts";

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

test("live server reloads after trace changes while keeping the snapshot offline", { timeout: 15_000 }, async () => {
  const fixture = await createCodeGraphProject({ populate(database) {
    insertFile(database, { path: "src/index.ts", nodeCount: 0 });
  } });
  const root = await mkdtemp(join(tmpdir(), "codegraph-viz-live-"));
  const outputPath = join(root, "map.html");
  const tracePath = join(root, "events.jsonl");
  await writeFile(tracePath, "");
  let resolveUpdate: (() => void) | undefined;
  const updated = new Promise<void>((resolvePromise) => { resolveUpdate = resolvePromise; });
  const live = await startLiveVisualization({
    projectPath: fixture.projectPath,
    outputPath,
    tracePaths: [tracePath],
    autoTraces: false,
    intervalMs: 20,
    remoteRefreshMs: 60_000,
    port: 0,
    onUpdate: () => resolveUpdate?.()
  });
  try {
    const served = await fetch(live.url).then((response) => response.text());
    assert.match(served, /EventSource\("\/__codegraph_viz_events"\)/);
    assert.match(served, /connect-src 'self'/);
    const snapshot = await readFile(outputPath, "utf8");
    assert.doesNotMatch(snapshot, /EventSource/);
    assert.doesNotMatch(snapshot, /connect-src/);

    let resolveConnected: (() => void) | undefined;
    const connected = new Promise<void>((resolvePromise) => { resolveConnected = resolvePromise; });
    const reloaded = new Promise<void>((resolvePromise, reject) => {
      const request = get(`${live.url}__codegraph_viz_events`, (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          resolveConnected?.();
          if (chunk.includes("event: reload")) resolvePromise();
        });
      });
      request.on("error", reject);
    });
    await connected;
    await writeFile(tracePath, `${JSON.stringify({
      id: "live-event", timestamp: "2026-08-05T05:00:00Z", runId: "live-run",
      agentId: "root", kind: "file_read", target: "src/index.ts"
    })}\n`);
    await Promise.all([updated, reloaded]);
    assert.match(await readFile(outputPath, "utf8"), /live-event/);
  } finally {
    await live.close();
  }
});
