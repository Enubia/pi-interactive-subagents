import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  closeSurface,
  createSurface,
  getMuxBackend,
  readScreen,
  readScreenAsync,
  renameCurrentTab,
  sendCommand,
  sendEscape,
} from "../pi-extension/subagents/cmux.ts";

const SERVER = `
const http = require("node:http");
const fs = require("node:fs");
const [socket, log] = process.argv.slice(1);
http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    fs.appendFileSync(log, JSON.stringify({ op: req.url.slice(1), body: JSON.parse(body) }) + "\\n");
    res.setHeader("content-type", "application/json");
    if (req.url === "/create") return res.end(JSON.stringify({ surface: "7" }));
    if (req.url === "/read") return res.end(JSON.stringify({ text: "a\\nb\\n__SUBAGENT_DONE_0__" }));
    res.end("{}");
  });
}).listen(socket);
`;

describe("vscode backend", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-vscode-backend-"));
  const socket = join(dir, "s.sock");
  const log = join(dir, "log.jsonl");
  const saved = { ...process.env };
  let server: ChildProcess;

  before(async () => {
    server = spawn(process.execPath, ["-e", SERVER, socket, log], { stdio: "ignore" });
    for (let i = 0; i < 100 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 20));
    process.env.PI_VSCODE_SOCKET = socket;
    process.env.PI_SUBAGENT_MUX = "vscode";
    process.env.PI_XTERM_SESSION = "3";
  });

  after(() => {
    server.kill();
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  const requests = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

  it("routes surface operations to the VS Code socket", async () => {
    assert.equal(getMuxBackend(), "vscode");
    assert.equal(createSurface("worker"), "7");
    sendCommand("7", "echo hi");
    sendEscape("7");
    assert.equal(readScreen("7", 2), "b\n__SUBAGENT_DONE_0__");
    assert.match(await readScreenAsync("7", 5), /__SUBAGENT_DONE_0__/);
    renameCurrentTab("Plan");
    closeSurface("7");

    assert.deepEqual(requests(), [
      { op: "create", body: { name: "worker", parent: "3", cwd: process.cwd() } },
      { op: "send", body: { surface: "7", text: "echo hi\r" } },
      { op: "send", body: { surface: "7", text: "\u001b" } },
      { op: "read", body: { surface: "7", lines: 2 } },
      { op: "read", body: { surface: "7", lines: 5 } },
      { op: "rename", body: { surface: "3", title: "Plan" } },
      { op: "close", body: { surface: "7" } },
    ]);
  });
});
