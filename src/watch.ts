import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { generateVisualization, type GenerateOptions, type GenerationResult } from "./app.ts";
import { defaultTraceRoot, findMatchingTraceFiles } from "./discovery.ts";
import type { TraceProvider } from "./types.ts";

const execute = promisify(execFile);

async function fileIdentity(path: string): Promise<string> {
  try {
    const info = await stat(path, { bigint: true });
    return `${path}\0${info.size}\0${info.mtimeNs}`;
  } catch {
    return `${path}\0missing`;
  }
}

async function contentIdentity(path: string): Promise<string> {
  try {
    return `${path}\0${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  } catch {
    return `${path}\0missing`;
  }
}

async function gitIdentity(projectPath: string, outputPath: string): Promise<string> {
  try {
    const outputRelative = relative(projectPath, outputPath);
    const excludesOutput = outputRelative && !outputRelative.startsWith("..") && !isAbsolute(outputRelative);
    const stagedArgs = ["diff", "--binary", "--cached", "--", "."];
    const unstagedArgs = ["diff", "--binary", "--", "."];
    if (excludesOutput) {
      stagedArgs.push(`:(exclude)${outputRelative}`);
      unstagedArgs.push(`:(exclude)${outputRelative}`);
    }
    const [head, branch] = await Promise.all([
      execute("git", ["rev-parse", "--verify", "HEAD"], { cwd: projectPath, encoding: "utf8" })
        .then(({ stdout }) => stdout.trim(), () => "unborn"),
      execute("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: projectPath, encoding: "utf8" })
        .then(({ stdout }) => stdout.trim(), () => "detached")
    ]);
    const [{ stdout: status }, { stdout: staged }, { stdout: unstaged }, { stdout: untracked }] = await Promise.all([
      execute("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: projectPath, encoding: "utf8" }),
      execute("git", stagedArgs, { cwd: projectPath, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }),
      execute("git", unstagedArgs, { cwd: projectPath, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }),
      execute("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: projectPath, encoding: "utf8" })
    ]);
    const untrackedPaths = untracked.split("\0").filter(Boolean)
      .map((path) => resolve(projectPath, path))
      .filter((path) => path !== outputPath)
      .sort();
    const untrackedIdentities = await Promise.all(untrackedPaths.map(contentIdentity));
    return `${head}\0${branch}\0${status}\0${staged}\0${unstaged}\0${untrackedIdentities.join("\n")}`;
  } catch {
    return "git-unavailable";
  }
}

export async function inputFingerprint(options: GenerateOptions): Promise<string> {
  const projectPath = resolve(options.projectPath ?? process.cwd());
  const outputPath = resolve(options.outputPath ?? "codegraph-map.html");
  const paths = [
    join(projectPath, ".codegraph", "codegraph.db"),
    join(projectPath, ".codegraph", "codegraph.db-wal"),
    join(projectPath, ".codegraph", "codegraph.db-shm"),
    join(projectPath, "codegraph-viz.json"),
    ...(options.tracePaths ?? []).map((path) => resolve(path))
  ];
  if (options.autoTraces !== false) {
    const providers = options.providers?.length
      ? [...new Set(options.providers)]
      : ["codex", "claude"] as TraceProvider[];
    for (const provider of providers) {
      const root = options.traceRoots?.[provider] ?? defaultTraceRoot(provider);
      paths.push(...await findMatchingTraceFiles(provider, root, projectPath));
    }
  }
  const identities = await Promise.all([...new Set(paths)].sort().map(fileIdentity));
  identities.push(await gitIdentity(projectPath, outputPath));
  return createHash("sha256").update(identities.join("\n")).digest("hex");
}

export interface LiveVisualizationOptions extends GenerateOptions {
  port?: number;
  intervalMs?: number;
  remoteRefreshMs?: number;
  onUpdate?: (result: GenerationResult) => void;
  onError?: (error: Error) => void;
}

export interface LiveVisualization {
  url: string;
  outputPath: string;
  warnings: string[];
  close(): Promise<void>;
}

const EVENTS_PATH = "/__codegraph_viz_events";
function liveReloadScript(generation: number): string {
  return `<script>(()=>{const events=new EventSource("${EVENTS_PATH}?generation=${generation}");events.addEventListener("reload",()=>location.reload());})();</script>`;
}

function injectLiveReload(html: string, generation: number): string {
  const liveCsp = html.replace("default-src 'none';", "default-src 'none'; connect-src 'self';");
  const script = liveReloadScript(generation);
  return liveCsp.includes("</body>")
    ? liveCsp.replace("</body>", `${script}</body>`)
    : `${liveCsp}${script}`;
}

export async function startLiveVisualization(options: LiveVisualizationOptions): Promise<LiveVisualization> {
  let fingerprint = await inputFingerprint(options);
  const initial = await generateVisualization({ ...options, force: true });
  let lastRefresh = Date.now();
  let refreshing = false;
  let generation = 0;
  let expectedHost = "";
  const clients = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    if (request.headers.host !== expectedHost) {
      response.writeHead(421, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Misdirected request");
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Method not allowed");
      return;
    }
    const requestUrl = new URL(request.url ?? "/", `http://${expectedHost}`);
    if (requestUrl.pathname === EVENTS_PATH) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      response.write("retry: 1000\n\n");
      if (requestUrl.searchParams.get("generation") !== String(generation)) {
        response.write("event: reload\ndata: missed-update\n\n");
      }
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (requestUrl.pathname !== "/") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    try {
      const servedGeneration = generation;
      const html = injectLiveReload(await readFile(initial.outputPath, "utf8"), servedGeneration);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(html);
    } catch (error) {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4173, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to determine live visualization address.");
  }
  expectedHost = `127.0.0.1:${address.port}`;

  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    try {
      const nextFingerprint = await inputFingerprint(options);
      const remoteRefreshDue = Date.now() - lastRefresh >= (options.remoteRefreshMs ?? 60_000);
      if (nextFingerprint === fingerprint && !remoteRefreshDue) return;
      const result = await generateVisualization({ ...options, outputPath: initial.outputPath, force: true });
      fingerprint = nextFingerprint;
      lastRefresh = Date.now();
      generation += 1;
      for (const client of clients) client.write("event: reload\ndata: updated\n\n");
      options.onUpdate?.(result);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      refreshing = false;
    }
  };
  const timer = setInterval(() => void refresh(), options.intervalMs ?? 1_000);
  return {
    url: `http://127.0.0.1:${address.port}/`,
    outputPath: initial.outputPath,
    warnings: initial.warnings,
    async close() {
      clearInterval(timer);
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    }
  };
}
