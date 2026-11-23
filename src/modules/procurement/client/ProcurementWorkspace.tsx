"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Building2, FolderSearch, LayoutDashboard, LogOut, Settings2, Sparkles, UserRound } from "lucide-react";
import type { ProcurementApi, SessionUser } from "../shared/types";
import { HttpProcurementApi } from "./api";
import { WorkspaceProvider } from "./context";
import { BASE_PATH } from "./base-path";
import { BrandName } from "./BrandName";
import { FloatingTattva } from "./FloatingTattva";
import { ThemeToggle } from "./ThemeToggle";
import { DetailDrawer, type DrawerEntry } from "./DetailDrawer";
import { LANDING_ORDER, NAV, type ViewId } from "./roles";
import { useAsync } from "./useAsync";
import { AdminPanel } from "./views/AdminPanel";
import { CaseRegister } from "./views/CaseRegister";
import { DocumentLibrary } from "./views/DocumentLibrary";
import { LoginScreen } from "./views/LoginScreen";
import { LoadingBlock, ModulePanel } from "./views/ModulePanel";
import { TattvaChat, type TattvaSeed } from "./views/TattvaChat";
import "./workspace.css";

export interface ProcurementWorkspaceProps {
  /** Backend adapter. Defaults to the HTTP API mounted at `basePath`. */
  api?: ProcurementApi;
  basePath?: string;
  initialView?: ViewId;
  /** CSS height of the workspace; use "100%" when the host gives it a sized container. */
  height?: string;
  /**
   * When the host application owns sign-in (for example console SSO), pass the
   * signed-in user here and the built-in login screen is skipped. The backend
   * still authenticates every request itself; this only avoids a second prompt.
   */
  user?: SessionUser | null;
}

const GROUP_ICONS = { Intelligence: LayoutDashboard, Records: FolderSearch, Assistant: Bot, Administration: Settings2 } as const;

export function ProcurementWorkspace({ api: providedApi, basePath = `${BASE_PATH}/api/procurement`, initialView, height = "100vh", user: hostUser }: ProcurementWorkspaceProps) {
  const api = useMemo(() => providedApi ?? new HttpProcurementApi(basePath), [providedApi, basePath]);
  const [user, setUser] = useState<SessionUser | null | undefined>(hostUser === undefined ? undefined : hostUser);

  useEffect(() => {
    if (hostUser !== undefined) return;
    let active = true;
    api.me().then((u) => active && setUser(u)).catch(() => active && setUser(null));
    return () => {
      active = false;
    };
  }, [api, hostUser]);

  if (user === undefined) return <div className="adv-root adv-center" style={{ height }}><LoadingBlock label="Checking your session" /></div>;
  if (user === null) return <div className="adv-root adv-root-login" style={{ height }}><LoginScreen api={api} onSignedIn={setUser} /></div>;
  return <Workspace api={api} user={user} initialView={initialView} height={height} onSignedOut={() => setUser(null)} />;
}

function Workspace({ api, user, initialView, height, onSignedOut }: { api: ProcurementApi; user: SessionUser; initialView?: ViewId; height: string; onSignedOut: () => void }) {
  const allowed = useMemo(() => new Set(user.views), [user.views]);
  const landing = (initialView && allowed.has(initialView) ? initialView : LANDING_ORDER.find((id) => allowed.has(id))) ?? "overview";
  const [view, setView] = useState<ViewId>(landing as ViewId);
  const [drill, setDrill] = useState<string | undefined>();
  const [stack, setStack] = useState<DrawerEntry[]>([]);
  const [seed, setSeed] = useState<TattvaSeed | null>(null);
  const [chatOpened, setChatOpened] = useState(view === "tattva");
  const info = useAsync(() => (allowed.has("overview") || allowed.has("cases") || allowed.has("tenders") ? api.info() : Promise.resolve(null)), [api]);

  const go = useCallback((next: ViewId) => {
    setView(next);
    if (next === "tattva") setChatOpened(true);
    if (next !== "cases") setDrill(undefined);
  }, []);

  const push = useCallback((entry: DrawerEntry) => {
    setStack((previous) => {
      const top = previous[previous.length - 1];
      return top && top.kind === entry.kind && top.id === entry.id && top.page === entry.page ? previous : [...previous, entry];
    });
  }, []);

  const selectedCaseId = [...stack].reverse().find((entry) => entry.kind === "case")?.id ?? null;

  const actions = useMemo(
    () => ({
      api,
      selectedCaseId,
      openCase: (id: string) => push({ kind: "case", id }),
      openVendor: (id: string) => push({ kind: "vendor", id }),
      openDocument: (id: string, page?: number) => push({ kind: "document", id, page }),
      openRegister: (key: string) => {
        setStack([]);
        setDrill(key);
        setView("cases");
      },
      askTattva: (question: string, caseId?: string) => {
        setStack([]);
        setSeed({ question, caseId, nonce: Date.now() });
        setChatOpened(true);
        setView("tattva");
      },
    }),
    [api, push, selectedCaseId],
  );

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    onSignedOut();
  };

  const groups = (["Intelligence", "Records", "Assistant", "Administration"] as const).map((group) => ({ group, items: NAV.filter((item) => item.group === group && allowed.has(item.id)) }));
  const current = NAV.find((item) => item.id === view);

  return (
    <WorkspaceProvider value={actions}>
      <div className="adv-root" style={{ height }}>
        <aside className="adv-sidebar">
          <div className="adv-brand">
            <img className="adv-brand-mark" src={`${BASE_PATH}/advaitsi-icon.png`} alt="" width={36} height={36} />
            <div>
              <div className="adv-brand-name"><BrandName /></div>
              <div className="adv-brand-caption">TENDER &amp; PROCUREMENT</div>
            </div>
          </div>

          <div className="adv-role">
            <span className="adv-role-icon"><UserRound size={15} /></span>
            <span className="adv-role-body">
              <strong>{user.name}</strong>
              <em>{user.roleLabel}</em>
              <small>{user.scopeSummary}</small>
            </span>
            <button type="button" className="adv-icon-button" onClick={() => void signOut()} title="Sign out" aria-label="Sign out"><LogOut size={14} /></button>
          </div>

          <nav className="adv-nav" aria-label="Procurement workspace">
            {groups.map(({ group, items }) => {
              if (!items.length) return null;
              const Icon = GROUP_ICONS[group];
              return (
                <div key={group} className="adv-nav-group">
                  <div className="adv-nav-heading"><Icon size={12} /> {group}</div>
                  {items.map((item) => (
                    <button key={item.id} type="button" className={view === item.id ? "active" : ""} onClick={() => go(item.id)}>
                      <span>{item.label}</span>
                      <small>{item.caption}</small>
                    </button>
                  ))}
                </div>
              );
            })}
          </nav>

          <div className="adv-side-foot">
            <Building2 size={13} />
            <span>Your access and data scope are decided by the server from your sign-in, and each query is audited.</span>
          </div>
        </aside>

        <div className="adv-main">
          <div className="adv-topbar">
            <div className="adv-crumb">Advait <span>/</span> Tender &amp; Procurement <span>/</span> <strong>{current?.label}</strong></div>
            <div className="adv-top-right">
              {info.data && <span className="adv-asof">As of {info.data.asOf}</span>}
              <span className="adv-synthetic"><i /> Synthetic demo data</span>
              <ThemeToggle />
              {allowed.has("tattva") && <button type="button" className="adv-ask" onClick={() => go("tattva")}><Sparkles size={14} /> Ask TattvaAI</button>}
            </div>
          </div>
          {info.data && <div className="adv-banner">{info.data.disclaimer}{!info.data.documentsOnDisk && " Source PDFs are not available on this server."}</div>}

          <main className="adv-content">
            {view === "cases" && <CaseRegister drill={drill} onClearDrill={() => setDrill(undefined)} />}
            {view === "documents" && <DocumentLibrary />}
            {view === "admin" && <AdminPanel />}
            {chatOpened && <div hidden={view !== "tattva"}><TattvaChat seed={seed} active={view === "tattva"} /></div>}
            {!["cases", "documents", "tattva", "admin"].includes(view) && <ModulePanel key={view} moduleId={view} />}
          </main>
        </div>

        {allowed.has("tattva") && view !== "tattva" && <FloatingTattva onOpenFull={() => go("tattva")} />}
        <DetailDrawer stack={stack} onBack={() => setStack((s) => s.slice(0, -1))} onClose={() => setStack([])} />
      </div>
    </WorkspaceProvider>
  );
}
