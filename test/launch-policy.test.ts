import { it, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childExtension from "../pi-extension/subagents/subagent-done.ts";
import { readSubagentActivityFile } from "../pi-extension/subagents/activity.ts";

let launchCommand = "";
mock.module("../pi-extension/subagents/cmux.ts", {
  namedExports: {
    isMuxAvailable: () => true,
    muxSetupHint: () => "",
    createSurface: () => "test-surface",
    sendLongCommand: (_surface: string, command: string) => { launchCommand = command; },
    pollForExit: () => new Promise(() => {}),
    closeSurface: () => {},
    getMuxBackend: () => "tmux",
    sendEscape: () => {},
    shellEscape: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
    renameCurrentTab: () => {},
    renameWorkspace: () => {},
    readScreen: () => "",
  },
});
const { default: parentExtension, __test__ } = await import("../pi-extension/subagents/index.ts");

function extensionApi() {
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const commands = new Map<string, any>();
  const prompts: string[] = [];
  return {
    tools, events, commands, prompts,
    api: {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      on: (name: string, handler: any) => events.set(name, handler),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      registerMessageRenderer() {},
      registerShortcut() {},
      sendMessage() {},
      sendUserMessage: (prompt: string) => prompts.push(prompt),
      getAllTools: () => [],
    } as any,
  };
}

async function verifyLaunch(options: { params?: Record<string, unknown>; frontmatter?: string; autoExit: boolean; interactive: boolean; iterate?: boolean; stopReason?: string; inheritedAutoExit?: string }) {
  const root = mkdtempSync(join(tmpdir(), "launch-policy-"));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const parent = extensionApi();
  try {
    process.chdir(root);
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.PI_SUBAGENT_AUTO_EXIT = options.inheritedAutoExit ?? "0";
    delete process.env.PI_DENY_TOOLS;
    delete process.env.PI_SUBAGENT_AGENT;
    const agentsDir = join(root, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    if (options.frontmatter) writeFileSync(join(agentsDir, "fixture.md"), `---\n${options.frontmatter}\n---\nFixture identity`);
    const sessionFile = join(root, "parent.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: new Date().toISOString(), cwd: root }) + "\n");
    parentExtension(parent.api);
    let params: Record<string, unknown> = { name: "child", task: "Finish task", ...options.params };
    if (options.iterate) {
      parent.commands.get("iterate").handler("Finish task", {});
      const match = parent.prompts[0].match(/fork: (true), name: ("[^"]+"), task: (".*")$/s);
      assert.ok(match, parent.prompts[0]);
      params = { fork: JSON.parse(match[1]), name: JSON.parse(match[2]), task: JSON.parse(match[3]) };
    }
    const ctx = { cwd: root, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "parent", getSessionDir: () => root } };
    const result = await parent.tools.get("subagent").execute("call", params, undefined, undefined, ctx);
    assert.equal(result.details.status, "started");
    const output = execFileSync("bash", ["-c", `pi() { node -e 'console.log(JSON.stringify({env:process.env,args:process.argv.slice(1)}))' -- "$@"; }; ${launchCommand}`], { encoding: "utf8" });
    const launched = JSON.parse(output.split("\n")[0]);
    Object.assign(process.env, launched.env);
    const child = extensionApi();
    childExtension(child.api);
    let shutdowns = 0;
    child.events.get("agent_start")({}, {});
    child.events.get("agent_end")({ messages: [{ role: "assistant", content: [{ type: "text", text: "Finished" }], stopReason: options.stopReason ?? "stop" }] }, { shutdown: () => { shutdowns++; } });
    assert.equal(shutdowns, options.autoExit && options.stopReason !== "aborted" ? 1 : 0, "normal completion shutdown follows launch policy");
    assert.equal(launched.env.PI_SUBAGENT_AUTO_EXIT, options.autoExit ? "1" : "0", "launch explicitly overrides inherited auto-exit");
    const activity = readSubagentActivityFile(launched.env.PI_SUBAGENT_ACTIVITY_FILE, launched.env.PI_SUBAGENT_ID);
    assert.ok(activity.ok);
    assert.equal(activity.activity.phase, shutdowns ? "done" : "waiting");
    assert.equal(__test__.runningSubagents.get(result.details.id)?.interactive, options.interactive);
    const artifact = launched.args.find((arg: string) => arg.startsWith("@"));
    if (artifact) {
      const prompt = readFileSync(artifact.slice(1), "utf8");
      assert.equal(prompt.includes("Complete your task autonomously."), options.autoExit);
      assert.equal(prompt.includes("Your FINAL assistant message should summarize"), options.autoExit);
    }
  } finally {
    parent.events.get("session_shutdown")?.({}, {});
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
}

it("bare spawn requests child shutdown on normal completion", async () => {
  await verifyLaunch({ autoExit: true, interactive: false });
});

it("interactive spawn stays open under an autonomous parent", async () => {
  await verifyLaunch({ params: { interactive: true }, inheritedAutoExit: "1", autoExit: false, interactive: true });
});

for (const agent of ["worker", "scout", "reviewer"]) {
  it(`${agent} retains autonomous completion`, async () => {
    await verifyLaunch({ params: { agent }, autoExit: true, interactive: false });
  });
  it(`explicit interactive keeps ${agent} open`, async () => {
    await verifyLaunch({ params: { agent, interactive: true }, inheritedAutoExit: "1", autoExit: false, interactive: true });
  });
}

for (const scenario of [
  { name: "planner default", params: { agent: "planner" }, autoExit: false, interactive: true },
  { name: "planner notification opt-in", params: { agent: "planner", interactive: false }, autoExit: false, interactive: false },
  { name: "bare fork", params: { fork: true }, autoExit: false, interactive: true },
  { name: "autonomous bare fork", params: { fork: true, interactive: false }, autoExit: true, interactive: false },
  { name: "iterate", iterate: true, autoExit: false, interactive: true },
  { name: "frontmatter interactive", params: { agent: "fixture" }, frontmatter: "auto-exit: true\ninteractive: true", autoExit: false, interactive: true },
  { name: "explicit false overrides frontmatter interactive", params: { agent: "fixture", interactive: false }, frontmatter: "auto-exit: true\ninteractive: true", autoExit: true, interactive: false },
  { name: "named auto-exit opt-out with notifications", params: { agent: "fixture", interactive: false }, frontmatter: "auto-exit: false\ninteractive: true", autoExit: false, interactive: false },
  { name: "named frontmatter notification opt-in", params: { agent: "fixture" }, frontmatter: "auto-exit: false\ninteractive: false", autoExit: false, interactive: false },
  { name: "bare explicit autonomous", params: { interactive: false }, autoExit: true, interactive: false },
  { name: "aborted autonomous turn", stopReason: "aborted", autoExit: true, interactive: false },
]) {
  it(`${scenario.name} launch respects completion policy`, async () => {
    await verifyLaunch({ ...scenario, inheritedAutoExit: "1" });
  });
}
