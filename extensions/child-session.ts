/** SDK children need the same tool infrastructure that the CLI installs for the root. */
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type AgentSession,
  type CreateAgentSessionOptions,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

/** Built-in identities preserve settings exclusions and third-party replacements. */
export function childToolExtensions(): InlineExtension[] {
  return [
    { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
    { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
  ];
}

/** Inherit activation, not an SDK allowlist that would discard future MCP tools. */
export async function createChildAgentSession(
  options: Omit<CreateAgentSessionOptions, "tools" | "noTools" | "excludeTools">,
  activeTools: string[],
): Promise<AgentSession> {
  const { session } = await createAgentSession(options);
  try {
    session.setActiveToolsByName(activeTools);
    // MCP connects on session_start and can register/activate more tools afterward.
    await session.bindExtensions({ mode: "print" });
    return session;
  } catch (error) {
    await disposeChildAgentSession(session).catch(() => undefined);
    throw error;
  }
}

/** AgentSession.dispose() alone does not close extension-owned MCP connections. */
export async function disposeChildAgentSession(session: AgentSession): Promise<void> {
  try {
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}
