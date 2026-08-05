import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { generateVisualization, type GenerateOptions, type GenerationResult } from "./app.ts";
import { defaultTraceRoot, findTraceFiles } from "./discovery.ts";
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

async function gitIdentity(projectPath: string): Promise<string> {
  try {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execute("git", ["rev-parse", "--verify", "HEAD"], { cwd: projectPath, encoding: "utf8" }),
      execute("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: projectPath, encoding: "utf8" })
    ]);
    return `${head.trim()}\0${status}`;
  } catch {
    return "git-unavailable";
  }
}

export async function inputFingerprint(options: GenerateOptions): Promise<string> {
  const projectPath = resolve(options.projectPath ?? process.cwd());
  const paths = [
    join(projectPath, ".codegraph", "codegraph.db"),
    join(projectPath, "codegraph-viz.json"),
    ...(options.tracePaths ?? []).map((path) => resolve(path))
  ];
  if (options.autoTraces !== false) {
    const providers = options.providers?.length
      ? [...new Set(options.providers)]
      : ["codex", "claude"] as TraceProvider[];
    for (const provider of providers) {
      const root = options.traceRoots?.[provider] ?? defaultTraceRoot(provider);
      paths.push(...await findTraceFiles(root));
    }
  }
  const identities = await Promise.all([...new Set(paths)].sort().map(fileIdentity));
  identities.push(await gitIdentity(projectPath));
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
  close(): Promise<void>;
}

const EVENTS_PATH = "/__codegraph_viz_events";
const LIVE_RELOAD_SCRIPT = `<script>(()=>{const events=new EventSource("${EVENTS_PATH}");events.addEventListener("reload",()=>location.reload());})();</script>`;

function injectLiveReload(html: string): string {
  return html.includes("</body>") ? html.replace("</body>", `${LIVE_RELOAD_SCRIPT}</body>`) : `${html}${LIVE_RELOAD_SCRIPT}`;
}

export async function startLiveVisualization(options: LiveVisualizationOptions): Promise<LiveVisualization> {
  const initial = await generateVisualization(options);
  let fingerprint = await inputFingerprint(options);
  let lastRefresh = Date.now();
  let refreshing = false;
  const clients = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Method not allowed");
      return;
    }
    if (request.url === EVENTS_PATH) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      response.write("retry: 1000\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.url !== "/") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    try {
      const html = injectLiveReload(await readFile(initial.outputPath, "utf8"));
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
      for (const client of clients) client.write("event: reload\ndata: updated\n\n");
      options.onUpdate?.(result);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      refreshing = false;
    }
  };
  const timer = setInterval(() => void refresh(), options.intervalMs ?? 1_000);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to determine live visualization address.");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    outputPath: initial.outputPath,
    async close() {
      clearInterval(timer);
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    }
  };
}
