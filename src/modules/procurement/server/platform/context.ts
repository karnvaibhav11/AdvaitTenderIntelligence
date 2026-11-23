import { AsyncLocalStorage } from "node:async_hooks";
import type { Principal } from "./rbac";

/**
 * Request-scoped security context. Database row-level security reads it, so
 * every query made while handling a request is automatically limited to what
 * the signed-in principal may see. Code running outside a request (CLI tools)
 * has no context and is treated as a trusted system caller by the unscoped
 * `getStore()` only; the scoped store refuses to run without one.
 */
export interface RequestContext {
  principal: Principal;
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function requirePrincipal(): Principal {
  const context = storage.getStore();
  if (!context) throw new Error("No authenticated principal in this execution context");
  return context.principal;
}

/** For CLI tools and tests that act as one principal for the whole process. */
export function enterContext(context: RequestContext): void {
  storage.enterWith(context);
}
