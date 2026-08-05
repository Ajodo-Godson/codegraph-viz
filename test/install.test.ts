import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = new URL("../install.sh", import.meta.url);

test("installer exposes the simple setup contract", async () => {
  const { stdout } = await execute("sh", [script.pathname, "--help"]);
  assert.match(stdout, /Usage: install\.sh \[--uninstall\]/);
  assert.match(stdout, /CODEGRAPH_VIZ_INSTALL_DIR/);
  assert.match(stdout, /CODEGRAPH_VIZ_BIN_DIR/);
});

test("installer includes direct CLI and MCP next steps", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /codegraph-viz/);
  assert.match(source, /codegraph-viz --init/);
  assert.match(source, /codex mcp add codegraph-viz -- codegraph-viz-mcp/);
  assert.match(source, /claude mcp add --scope user codegraph-viz -- codegraph-viz-mcp/);
});

test("installer uninstall removes only its installation and launchers", async () => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-viz-uninstall-"));
  const installDir = join(root, "install");
  const binDir = join(root, "bin");
  await mkdir(join(installDir, "current"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(installDir, "current", ".codegraph-viz-install"), "");
  await symlink(join(installDir, "current", "dist/bin/codegraph-viz.js"), join(binDir, "codegraph-viz"));
  await symlink(join(installDir, "current", "dist/bin/codegraph-viz-mcp.js"), join(binDir, "codegraph-viz-mcp"));

  const { stdout } = await execute("sh", [script.pathname, "--uninstall"], {
    env: { ...process.env, CODEGRAPH_VIZ_INSTALL_DIR: installDir, CODEGRAPH_VIZ_BIN_DIR: binDir }
  });

  assert.match(stdout, /codegraph-viz uninstalled/);
  await assert.rejects(stat(installDir));
  await assert.rejects(stat(join(binDir, "codegraph-viz")));
  await assert.rejects(stat(join(binDir, "codegraph-viz-mcp")));
  assert.ok(await stat(binDir));
});

test("installer refuses unsafe uninstall directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-viz-unsafe-uninstall-"));
  const installDir = join(root, "install");
  const binDir = join(root, "bin");
  await mkdir(installDir);
  await mkdir(binDir);

  await assert.rejects(execute("sh", [script.pathname, "--uninstall"], {
    env: { ...process.env, CODEGRAPH_VIZ_INSTALL_DIR: "/", CODEGRAPH_VIZ_BIN_DIR: binDir }
  }), /unsafe install directory/);
  await assert.rejects(execute("sh", [script.pathname, "--uninstall"], {
    env: { ...process.env, CODEGRAPH_VIZ_INSTALL_DIR: installDir, CODEGRAPH_VIZ_BIN_DIR: "/" }
  }), /unsafe launcher directory/);

  assert.ok(await stat(installDir));
  assert.ok(await stat(binDir));
});

test("installer refuses home and relative uninstall directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-viz-directory-guard-"));
  const binDir = join(root, "bin");
  await mkdir(binDir);
  await assert.rejects(execute("sh", [script.pathname, "--uninstall"], {
    env: { ...process.env, HOME: root, CODEGRAPH_VIZ_INSTALL_DIR: root, CODEGRAPH_VIZ_BIN_DIR: binDir }
  }), /unsafe install directory/);
  await assert.rejects(execute("sh", [script.pathname, "--uninstall"], {
    env: { ...process.env, CODEGRAPH_VIZ_INSTALL_DIR: "relative", CODEGRAPH_VIZ_BIN_DIR: binDir }
  }), /relative install directory/);
});

test("installer preserves unowned directories and launchers", async () => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-viz-owned-uninstall-"));
  const installDir = join(root, "shared");
  const binDir = join(root, "bin");
  await mkdir(join(installDir, "current"), { recursive: true });
  await mkdir(binDir);
  const unrelated = join(installDir, "current", "unrelated.txt");
  const launcher = join(binDir, "codegraph-viz");
  await writeFile(unrelated, "keep");
  await writeFile(launcher, "keep");

  await assert.rejects(execute("sh", [script.pathname, "--uninstall"], {
    env: { ...process.env, CODEGRAPH_VIZ_INSTALL_DIR: installDir, CODEGRAPH_VIZ_BIN_DIR: binDir }
  }), /unowned installation/);
  assert.equal(await readFile(unrelated, "utf8"), "keep");
  assert.equal(await readFile(launcher, "utf8"), "keep");
});
