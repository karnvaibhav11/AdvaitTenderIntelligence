import assert from "node:assert/strict";
import { handleProcurementRequest } from "../src/modules/procurement/server/handler";
import { type LlmProvider, type LlmRequest, type LlmResponse, setLlmProviderForTests } from "../src/modules/procurement/server/ai/provider";
import { openAppDb, useAppDbForTests } from "../src/modules/procurement/server/platform/app-db";

export { assert };

let passed = 0;
let failed = 0;

export async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    process.exitCode = 1;
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : error}`);
  }
}

export function summary(label: string): void {
  console.log(`\n${label}: ${passed} passed${failed ? `, ${failed} FAILED` : ""}`);
}

export function freshAppDb(): void {
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-123";
  process.env.DEMO_LOGIN_PASSWORD = "test-passphrase";
  useAppDbForTests(openAppDb(":memory:"));
}

export const PASSWORD = "test-passphrase";

export interface CallOptions {
  cookie?: string;
  body?: unknown;
  origin?: string | null;
}

export function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const url = `http://localhost:3000/api/procurement/${path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin !== null) headers.origin = options.origin ?? "http://localhost:3000";
  const request = new Request(url, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  return handleProcurementRequest(request, path.split("?")[0].split("/"));
}

export async function login(username: string): Promise<string> {
  const response = await call("POST", "auth/login", { body: { username, password: PASSWORD } });
  assert.equal(response.status, 200, `login ${username} -> ${response.status}`);
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0];
}

export interface ScriptedTurn {
  text?: string;
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
  expect?: (request: LlmRequest) => void;
}

/** Test double standing in for the model: replays a fixed script and records requests. Never used outside tests. */
export class ScriptedProvider implements LlmProvider {
  readonly name = "scripted-test-double";
  readonly model = "scripted-test-model";
  readonly requests: LlmRequest[] = [];
  private index = 0;

  constructor(private readonly turns: ScriptedTurn[]) {}

  async respond(request: LlmRequest, hooks?: { onTextDelta?: (delta: string) => void }): Promise<LlmResponse> {
    this.requests.push(JSON.parse(JSON.stringify(request)) as LlmRequest);
    const turn = this.turns[Math.min(this.index++, this.turns.length - 1)];
    turn.expect?.(request);
    const calls = (turn.calls ?? []).map((c, i) => ({ callId: `call_${this.index}_${i}`, name: c.name, arguments: JSON.stringify(c.args) }));
    if (turn.text) hooks?.onTextDelta?.(turn.text);
    return {
      id: `resp_${this.index}`,
      model: this.model,
      text: turn.text ?? "",
      functionCalls: calls,
      outputItems: calls.map((c) => ({ type: "function_call", call_id: c.callId, name: c.name, arguments: c.arguments })),
      usage: { inputTokens: 1000, outputTokens: 200 },
      incomplete: null,
    };
  }
}

export function installProvider(turns: ScriptedTurn[]): ScriptedProvider {
  const provider = new ScriptedProvider(turns);
  setLlmProviderForTests(provider);
  return provider;
}

export async function readSse(response: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? "";
      const data = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "{}") as Record<string, unknown>;
      return { event, data };
    });
}
