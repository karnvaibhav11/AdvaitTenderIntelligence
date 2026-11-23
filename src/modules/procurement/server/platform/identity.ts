import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { getAppDb } from "./app-db";
import { getStore } from "../db";
import { AuthenticationError, ROLE_DEFINITIONS, type Principal, type RoleId } from "./rbac";

/**
 * Identity abstraction. The product never decides who a user is by itself:
 * an `IdentityProvider` does. The bundled `DemoIdentityProvider` signs in the
 * synthetic officers with a shared demo passphrase for local demonstration
 * only. A host (for example the AdvaitSI console SSO) supplies its own
 * provider that maps its session to a `Principal`.
 */
export interface IdentityProvider {
  readonly id: string;
  /** Verify credentials; return a principal or null. */
  authenticate(username: string, password: string): Principal | null;
  /** Rebuild a principal from a stored subject (session restore). */
  resolve(userId: string): Principal | null;
  /** Public list for login screens (demo provider only). */
  listLoginHints?(): Array<{ username: string; name: string; role: RoleId; designation: string }>;
}

interface DemoUserSpec {
  username: string;
  role: RoleId;
  designation: string;
  pick: string;
  scope: "all" | "department" | "area" | "none";
  synthetic?: { id: string; name: string };
}

const DEMO_USERS: DemoUserSpec[] = [
  { username: "cmd", role: "cmd", designation: "Chairman-cum-Managing Director", pick: "SELECT * FROM employee_officer_master WHERE approval_level = 5 ORDER BY officer_id LIMIT 1", scope: "all" },
  { username: "director.finance", role: "director", designation: "Director (Finance)", pick: "SELECT * FROM employee_officer_master WHERE designation LIKE 'Director (Finance)%' ORDER BY officer_id LIMIT 1", scope: "all" },
  { username: "procurement.head", role: "procurement_head", designation: "General Manager (Materials Management)", pick: "SELECT * FROM employee_officer_master WHERE designation LIKE 'General Manager (Materials Management)%' ORDER BY officer_id LIMIT 1", scope: "all" },
  { username: "gm.mechanical", role: "gm", designation: "General Manager (Mechanical)", pick: "SELECT * FROM employee_officer_master WHERE designation LIKE 'General Manager (Mechanical)%' ORDER BY officer_id LIMIT 1", scope: "department" },
  { username: "head.safety", role: "functional_head", designation: "General Manager (Safety)", pick: "SELECT * FROM employee_officer_master WHERE designation LIKE 'General Manager (Safety)%' ORDER BY officer_id LIMIT 1", scope: "department" },
  { username: "area.gm", role: "area_gm", designation: "Area General Manager", pick: "SELECT * FROM employee_officer_master WHERE designation = 'Area General Manager' ORDER BY officer_id LIMIT 1", scope: "area" },
  { username: "tender.officer", role: "tender_officer", designation: "Tender officer (Materials Management)", pick: "SELECT * FROM employee_officer_master WHERE department_id = 'DEP-MATM' AND approval_level <= 2 ORDER BY officer_id LIMIT 1", scope: "department" },
  { username: "finance.officer", role: "finance_officer", designation: "Finance officer", pick: "SELECT * FROM employee_officer_master WHERE department_id = 'DEP-FINA' AND approval_level <= 2 ORDER BY officer_id LIMIT 1", scope: "all" },
  { username: "technical.evaluator", role: "technical_evaluator", designation: "Technical evaluator (Mechanical)", pick: "SELECT * FROM employee_officer_master WHERE department_id = 'DEP-MECH' AND approval_level <= 2 ORDER BY officer_id LIMIT 1", scope: "department" },
  { username: "auditor", role: "auditor", designation: "Internal auditor", pick: "", scope: "all", synthetic: { id: "AUD-DEMO-01", name: "Meera Iyer (demo auditor)" } },
  { username: "admin", role: "super_admin", designation: "Administrator", pick: "", scope: "all", synthetic: { id: "ADM-DEMO-00", name: "Administrator" } },
  { username: "sysadmin", role: "administrator", designation: "System administrator", pick: "", scope: "none", synthetic: { id: "ADM-DEMO-01", name: "System Administrator (demo)" } },
];

function demoPassphrase(): string | null {
  if (process.env.DEMO_LOGIN_PASSWORD) return process.env.DEMO_LOGIN_PASSWORD;
  if (process.env.NODE_ENV === "production") return null;
  return "advaitsi-demo";
}

const PASSWORD_SALT = "advaitsi-demo-salt";

function digest(value: string): Buffer {
  return scryptSync(value, PASSWORD_SALT, 32);
}

export class DemoIdentityProvider implements IdentityProvider {
  readonly id = "demo";
  private principals: Map<string, Principal> | null = null;

  private load(): Map<string, Principal> {
    if (this.principals) return this.principals;
    const store = getStore();
    const map = new Map<string, Principal>();
    for (const spec of DEMO_USERS) {
      const officer = spec.pick ? (store.query<Record<string, string | number | null>>(spec.pick)[0] ?? null) : null;
      if (spec.pick && !officer) continue;
      const departmentId = officer ? String(officer.department_id ?? "") || null : null;
      const areaId = officer ? String(officer.area_id ?? "") || null : null;
      const scope =
        spec.scope === "all"
          ? { all: true, departments: [], areas: [] }
          : spec.scope === "department" && departmentId
            ? { all: false, departments: [departmentId], areas: [] }
            : spec.scope === "area" && areaId
              ? { all: false, departments: [], areas: [areaId] }
              : { all: false, departments: [], areas: [] };
      const id = officer ? String(officer.officer_id) : spec.synthetic!.id;
      map.set(spec.username, {
        id,
        username: spec.username,
        name: officer ? String(officer.officer_name) : spec.synthetic!.name,
        role: spec.role,
        designation: officer ? String(officer.designation) : spec.designation,
        officerId: officer ? String(officer.officer_id) : null,
        departmentId,
        scope,
        permissions: ROLE_DEFINITIONS[spec.role].permissions,
        provider: this.id,
      });
    }
    this.principals = map;
    return map;
  }

  authenticate(username: string, password: string): Principal | null {
    const expected = demoPassphrase();
    const principal = this.load().get(username.trim().toLowerCase());
    // Always compare, so timing does not reveal whether the user exists.
    const supplied = digest(password);
    const reference = digest(expected ?? randomBytes(16).toString("hex"));
    const matches = timingSafeEqual(supplied, reference);
    return expected && principal && matches ? principal : null;
  }

  resolve(userId: string): Principal | null {
    for (const principal of this.load().values()) if (principal.id === userId) return principal;
    return null;
  }

  listLoginHints() {
    return [...this.load().values()].map((p) => ({ username: p.username, name: p.name, role: p.role, designation: p.designation }));
  }

  isEnabled(): boolean {
    return demoPassphrase() !== null;
  }
}

// ───────────────────────────── Sessions ─────────────────────────────

const SESSION_COOKIE = "adv_session";
const SESSION_HOURS = 8;

const globalSecret = globalThis as unknown as { __advaitSessionSecret?: string };

function sessionSecret(): string {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET (at least 32 characters) is required in production");
  }
  globalSecret.__advaitSessionSecret ??= randomBytes(32).toString("hex");
  return globalSecret.__advaitSessionSecret;
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export interface SessionCookie {
  name: string;
  value: string;
  maxAge: number;
}

export function createSession(principal: Principal, ip: string | null): SessionCookie {
  const sessionId = randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_HOURS * 3_600_000);
  getAppDb()
    .prepare("INSERT INTO sessions (session_id, user_id, created_at, expires_at, ip) VALUES (?,?,?,?,?)")
    .run(sessionId, principal.id, now.toISOString(), expires.toISOString(), ip);
  const payload = Buffer.from(JSON.stringify({ sid: sessionId, sub: principal.id, exp: expires.getTime() })).toString("base64url");
  return { name: SESSION_COOKIE, value: `${payload}.${sign(payload)}`, maxAge: SESSION_HOURS * 3600 };
}

export function revokeSession(sessionId: string): void {
  getAppDb().prepare("UPDATE sessions SET revoked_at = ? WHERE session_id = ?").run(new Date().toISOString(), sessionId);
}

export interface SessionInfo {
  sessionId: string;
  principal: Principal;
}

export function readSession(cookieHeader: string | null, provider: IdentityProvider): SessionInfo | null {
  if (!cookieHeader) return null;
  const raw = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  const token = raw.slice(SESSION_COOKIE.length + 1);
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let data: { sid: string; sub: string; exp: number };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data.sid || data.exp < Date.now()) return null;
  const row = getAppDb().prepare("SELECT user_id, expires_at, revoked_at FROM sessions WHERE session_id = ?").get(data.sid) as
    | { user_id: string; expires_at: string; revoked_at: string | null }
    | undefined;
  if (!row || row.revoked_at || row.user_id !== data.sub || Date.parse(row.expires_at) < Date.now()) return null;
  const principal = provider.resolve(row.user_id);
  return principal ? { sessionId: data.sid, principal } : null;
}

export function sessionCookieHeader(cookie: SessionCookie): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cookie.maxAge}${secure}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ───────────────────────────── Login throttling ─────────────────────────────

const attempts = new Map<string, { count: number; resetAt: number }>();

export function loginThrottled(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) return false;
  return entry.count >= 5;
}

export function noteLoginFailure(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) attempts.set(key, { count: 1, resetAt: now + 5 * 60_000 });
  else entry.count += 1;
}

export function clearLoginFailures(key: string): void {
  attempts.delete(key);
}

const globalProvider = globalThis as unknown as { __advaitIdentity?: IdentityProvider };

export function getIdentityProvider(): IdentityProvider {
  globalProvider.__advaitIdentity ??= new DemoIdentityProvider();
  return globalProvider.__advaitIdentity;
}

/** Host integration point: replace the provider (for example with console SSO). */
export function setIdentityProvider(provider: IdentityProvider): void {
  globalProvider.__advaitIdentity = provider;
}

export { AuthenticationError };
