import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, stat, symlink } from "node:fs/promises";
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

test("installer uninstall removes only its installation and launchers", async () => {
  const root = await mkdtemp(join(tmpdir(), "codegraph-viz-uninstall-"));
  const installDir = join(root, "install");
  const binDir = join(root, "bin");
  await mkdir(join(installDir, "current"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await symlink(join(installDir, "current", "codegraph-viz"), join(binDir, "codegraph-viz"));
  await symlink(join(installDir, "current", "codegraph-viz-mcp"), join(binDir, "codegraph-viz-mcp"));

  const { stdout } = await execute("sh", [script.pathname, "--uninstall"], {
    env: { ...process.env, CODEGRAPH_VIZ_INSTALL_DIR: installDir, CODEGRAPH_VIZ_BIN_DIR: binDir }
  });

  assert.match(stdout, /codegraph-viz uninstalled/);
  await assert.rejects(stat(installDir));
  await assert.rejects(stat(join(binDir, "codegraph-viz")));
  await assert.rejects(stat(join(binDir, "codegraph-viz-mcp")));
  assert.ok(await stat(binDir));
});
