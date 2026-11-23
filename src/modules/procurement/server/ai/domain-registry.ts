import type { Permission } from "../platform/rbac";
import { buildInstructions, type PromptContext } from "./prompt";
import { DOCUMENT_TOOLS } from "./doc-tools";
import { CORE_TOOLS, type ToolDefinition } from "./tools";

/**
 * Domain agent registry. TattvaAI core selects an agent by domain; each agent
 * declares its own tools, instructions and the permission needed to use it, and
 * receives no access to another domain's data. The Mining agent is owned by the
 * CoalMind codebase: a host registers it here against this contract (it is not
 * implemented in this repository and its internals are not assumed).
 */
export interface DomainAgentDefinition {
  domain: string;
  label: string;
  requiredPermission: Permission;
  tools: ToolDefinition[];
  instructions(context: PromptContext): string;
  /** Data views this agent may query; used to document and test isolation. */
  dataViews: string[];
}

const registry = new Map<string, DomainAgentDefinition>();
const extraTools: ToolDefinition[] = [];

export function registerDomainAgent(definition: DomainAgentDefinition): void {
  registry.set(definition.domain, definition);
}

/** Add tools (for example document retrieval) to the Tender agent. */
export function registerTenderTools(tools: ToolDefinition[]): void {
  for (const tool of tools) {
    if (!extraTools.some((t) => t.name === tool.name)) extraTools.push(tool);
  }
}

export function getDomainAgent(domain: string): DomainAgentDefinition {
  const agent = registry.get(domain);
  if (!agent) throw new Error(`No agent registered for domain "${domain}"`);
  if (domain === "tender") return { ...agent, tools: [...agent.tools, ...extraTools.filter((t) => !agent.tools.some((x) => x.name === t.name))] };
  return agent;
}

registerDomainAgent({
  domain: "tender",
  label: "Tender & Procurement Intelligence",
  requiredPermission: "view:tattva",
  tools: [...CORE_TOOLS, ...DOCUMENT_TOOLS],
  instructions: buildInstructions,
  dataViews: ["ai_*"],
});
