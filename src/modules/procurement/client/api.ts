import type {
  AiAnswer,
  AiEvent,
  CaseFilters,
  CaseList,
  ConversationSummary,
  DatasetInfo,
  DocumentList,
  EntityDetail,
  ModuleView,
  ProcurementApi,
  SessionUser,
  StoredMessage,
} from "../shared/types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Default `ProcurementApi`: talks to the route mounted at `basePath`, using the session cookie. */
export class HttpProcurementApi implements ProcurementApi {
  constructor(private readonly basePath = "/api/procurement") {}

  private async read<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
      throw new ApiError(body?.error ?? `Request failed (${response.status})`, response.status, body?.code);
    }
    return (await response.json()) as T;
  }

  private get<T>(path: string): Promise<T> {
    return fetch(`${this.basePath}/${path}`, { cache: "no-store", credentials: "same-origin" }).then((r) => this.read<T>(r));
  }

  private send<T>(method: string, path: string, body?: unknown): Promise<T> {
    return fetch(`${this.basePath}/${path}`, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => this.read<T>(r));
  }

  info() {
    return this.get<DatasetInfo>("info");
  }

  module(id: string) {
    return this.get<ModuleView>(`modules/${encodeURIComponent(id)}`);
  }

  cases(filters: CaseFilters) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    return this.get<CaseList>(`cases?${params.toString()}`);
  }

  caseDetail(caseId: string) {
    return this.get<EntityDetail>(`cases/${encodeURIComponent(caseId)}`);
  }

  vendorDetail(vendorId: string) {
    return this.get<EntityDetail>(`vendors/${encodeURIComponent(vendorId)}`);
  }

  documents(params: { q?: string; type?: string; limit?: number; offset?: number }) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") search.set(key, String(value));
    }
    return this.get<DocumentList>(`documents?${search.toString()}`);
  }

  documentUrl(documentId: string) {
    return `${this.basePath}/documents/${encodeURIComponent(documentId)}/file`;
  }

  async me(): Promise<SessionUser | null> {
    return (await this.get<{ user: SessionUser | null }>("auth/me")).user;
  }

  async login(username: string, password: string): Promise<SessionUser> {
    return (await this.send<{ user: SessionUser }>("POST", "auth/login", { username, password })).user;
  }

  async logout(): Promise<void> {
    await this.send("POST", "auth/logout");
  }

  async loginHints() {
    return (await this.get<{ users: Array<{ username: string; name: string; role: string; designation: string }> }>("auth/hints")).users;
  }

  async conversations(): Promise<ConversationSummary[]> {
    return (await this.get<{ conversations: ConversationSummary[] }>("tattva/conversations")).conversations;
  }

  async messages(conversationId: string): Promise<StoredMessage[]> {
    return (await this.get<{ messages: StoredMessage[] }>(`tattva/conversations/${encodeURIComponent(conversationId)}/messages`)).messages;
  }

  admin(path: string): Promise<unknown> {
    return this.get<unknown>(`admin/${path}`);
  }

  async ask(
    question: string,
    options: { conversationId?: string; caseId?: string; onEvent?: (event: AiEvent) => void; signal?: AbortSignal },
  ): Promise<AiAnswer> {
    const response = await fetch(`${this.basePath}/tattva/stream`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, conversationId: options.conversationId, caseId: options.caseId }),
      signal: options.signal,
    });
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
      throw new ApiError(body?.error ?? `Request failed (${response.status})`, response.status, body?.code);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: AiAnswer | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (data) {
          const event = JSON.parse(data) as AiEvent;
          options.onEvent?.(event);
          if (event.type === "final") final = event.answer;
          if (event.type === "error") throw new ApiError(event.message, 502, event.code);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    if (!final) throw new ApiError("The answer stream ended without a result.", 502);
    return final;
  }
}
