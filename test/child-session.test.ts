import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { childToolExtensions, createChildAgentSession, disposeChildAgentSession } from "../extensions/child-session.ts";

test("children load discovery tools and can call tools registered after startup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-child-tools-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  // MCP's default config reader uses getAgentDir(), not the loader's agentDir.
  process.env.PI_CODING_AGENT_DIR = cwd;
  let session: AgentSession | undefined;
  try {
    const settingsManager = SettingsManager.inMemory();
    let extensionAPI: ExtensionAPI | undefined;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        ...childToolExtensions(),
        (pi) => { extensionAPI = pi; },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);

    session = await createChildAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime: await ModelRuntime.create({
        authPath: join(cwd, "auth.json"),
        modelsPath: join(cwd, "models.json"),
      }),
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
    }, ["read", "codemode", "tool_search"]);

    assert.deepEqual(session.getActiveToolNames().sort(), ["codemode", "read", "tool_search"]);
    assert.ok(extensionAPI);
    assert.ok(extensionAPI.getAllTools().some((tool) => tool.name === "codemode"));
    assert.ok(loader.getExtensions().extensions.some((extension) => extension.path === "builtin:mcp"));

    // Simulate background MCP registration, after the inherited active set is installed.
    extensionAPI.registerTool({
      name: "mcp__fixture__echo",
      label: "Fixture",
      description: "Returns a fixture value",
      exposure: "codemode",
      namespace: { name: "mcp__fixture", description: "Fixture tools" },
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "fixture-ok" }], details: undefined };
      },
    });
    extensionAPI.registerTool({
      name: "mcp__fixture__direct",
      label: "Direct fixture",
      description: "Direct tool registered late",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "direct-ok" }], details: undefined };
      },
    });
    assert.ok(session.getActiveToolNames().includes("mcp__fixture__direct"));
    const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode");
    assert.ok(codemode);
    // Nested calls require the assistant turn that issued their parent tool call.
    session.agent.state.messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: "test-discovery", name: "codemode", arguments: {} }],
      api: "openai-responses",
      provider: "test",
      model: "test",
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    const result = await codemode.execute("test-discovery", {
      code: 'const found = await searchTools("fixture echo"); text(found.map(t => t.name)); text(await tools.mcp__fixture__echo({}));',
    });
    assert.match(JSON.stringify(result.content), /mcp__fixture__echo/);
    assert.match(JSON.stringify(result.content), /fixture-ok/);
  } finally {
    try {
      if (session) await disposeChildAgentSession(session);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
