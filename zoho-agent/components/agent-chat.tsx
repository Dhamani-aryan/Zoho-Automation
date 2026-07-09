"use client";

import { Check, Plus, Send, ShieldAlert, Trash2, Wrench, X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type AgentSession = {
  id: string;
  title: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type AgentMessageRow = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_name: string | null;
  tool_args: unknown;
  tool_result: unknown;
  tool_tier: number | null;
  created_at: string;
};

type ApprovalSummaryRecord = {
  zoho_id: string;
  name: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

type ApprovalRow = {
  id: string;
  tool_name: string;
  summary: ApprovalSummaryRecord[] | null;
  status: string;
  created_at: string;
  decided_at?: string | null;
};

type TimelineItem =
  | { id: string; kind: "user" | "assistant"; content: string }
  | {
      id: string;
      kind: "tool";
      name: string;
      args: unknown;
      result?: unknown;
      ok?: boolean;
      tier?: number | null;
      status?: string;
    }
  | {
      id: string; // approval_id
      kind: "approval";
      toolName: string;
      summary: ApprovalSummaryRecord[];
      status: string; // pending | approved | rejected | expired | executed | failed
    };

function buildTimeline(rows: AgentMessageRow[], approvals: ApprovalRow[]): TimelineItem[] {
  type Stamped = { at: string; seq: number; item: TimelineItem };
  const stamped: Stamped[] = [];
  let seq = 0;

  for (const row of rows) {
    if (row.role === "user" || (row.role === "assistant" && row.content)) {
      stamped.push({ at: row.created_at, seq: seq++, item: { id: row.id, kind: row.role, content: row.content ?? "" } });
      continue;
    }
    if (row.tool_name) {
      stamped.push({
        at: row.created_at,
        seq: seq++,
        item: {
          id: row.id,
          kind: "tool",
          name: row.tool_name,
          args: row.tool_args,
          result: row.role === "tool" ? row.tool_result : undefined,
          ok: row.role === "tool" ? !row.content : undefined,
          tier: row.tool_tier
        }
      });
    }
  }

  for (const approval of approvals) {
    stamped.push({
      at: approval.created_at,
      seq: seq++,
      item: {
        id: approval.id,
        kind: "approval",
        toolName: approval.tool_name,
        summary: Array.isArray(approval.summary) ? approval.summary : [],
        status: approval.status
      }
    });
  }

  stamped.sort((a, b) => (a.at === b.at ? a.seq - b.seq : a.at < b.at ? -1 : 1));
  return stamped.map((entry) => entry.item);
}

function shortJson(value: unknown) {
  if (value == null) return "";
  const text = JSON.stringify(value, null, 2);
  return text.length > 900 ? `${text.slice(0, 900)}\n...` : text;
}

function titleFor(session: AgentSession) {
  return session.title || "New agent chat";
}

export function AgentChat({
  initialSessions,
  initialMessages
}: {
  initialSessions: AgentSession[];
  initialMessages: AgentMessageRow[];
}) {
  const [sessions, setSessions] = useState(initialSessions);
  const [activeSessionId, setActiveSessionId] = useState(initialSessions[0]?.id ?? "");
  const [timeline, setTimeline] = useState<TimelineItem[]>(buildTimeline(initialMessages, []));
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline, loading]);

  // Hydrate the active session on mount so approval cards rebuild from the DB
  // after a reload/reconnect.
  useEffect(() => {
    if (activeSessionId) {
      loadSession(activeSessionId).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function decideApproval(approvalId: string, decision: "approve" | "reject") {
    setTimeline((current) =>
      current.map((item) =>
        item.kind === "approval" && item.id === approvalId
          ? { ...item, status: decision === "approve" ? "approved" : "rejected" }
          : item
      )
    );
    const response = await fetch(`/api/agent/approvals/${approvalId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision })
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? "Could not record your decision.");
      setTimeline((current) =>
        current.map((item) =>
          item.kind === "approval" && item.id === approvalId ? { ...item, status: "pending" } : item
        )
      );
    }
  }

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions]
  );

  async function refreshSessions() {
    const response = await fetch("/api/agent/sessions");
    const payload = (await response.json().catch(() => ({}))) as { sessions?: AgentSession[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Could not load agent sessions.");
    setSessions(payload.sessions ?? []);
  }

  async function loadSession(sessionId: string) {
    if (!sessionId) {
      setTimeline([]);
      return;
    }
    const response = await fetch(`/api/agent/sessions/${sessionId}`);
    const payload = (await response.json().catch(() => ({}))) as {
      messages?: AgentMessageRow[];
      approvals?: ApprovalRow[];
      error?: string;
    };
    if (!response.ok) throw new Error(payload.error ?? "Could not load agent session.");
    setTimeline(buildTimeline(payload.messages ?? [], payload.approvals ?? []));
  }

  async function createSession() {
    const response = await fetch("/api/agent/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const payload = (await response.json().catch(() => ({}))) as { session?: AgentSession; error?: string };
    if (!response.ok || !payload.session) throw new Error(payload.error ?? "Could not create agent session.");
    setSessions((current) => [payload.session!, ...current]);
    setActiveSessionId(payload.session.id);
    setPendingDeleteSessionId(null);
    setTimeline([]);
    return payload.session.id;
  }

  async function deleteSession(sessionId: string) {
    if (loading) return;
    setError(null);
    const response = await fetch(`/api/agent/sessions/${sessionId}`, { method: "DELETE" });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Could not delete chat.");

    const remaining = sessions.filter((item) => item.id !== sessionId);
    setSessions(remaining);
    setPendingDeleteSessionId(null);
    if (activeSessionId !== sessionId) return;

    const nextSessionId = remaining[0]?.id ?? "";
    setActiveSessionId(nextSessionId);
    if (nextSessionId) {
      await loadSession(nextSessionId);
    } else {
      setTimeline([]);
    }
  }

  function handleStreamEvent(eventName: string, data: unknown) {
    const object = data as Record<string, unknown>;
    if (eventName === "assistant_delta") {
      const text = typeof object.text === "string" ? object.text : "";
      if (!text) return;
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: "assistant", content: text }]);
      return;
    }
    if (eventName === "tool_call") {
      const call = object.call as { id?: string; name?: string; args?: unknown } | undefined;
      const id = call?.id;
      const name = call?.name;
      if (!id || !name) return;
      setTimeline((current) => [
        ...current,
        { id, kind: "tool", name, args: call.args ?? {}, tier: Number(object.tier ?? 0), status: "called" }
      ]);
      return;
    }
    if (eventName === "tool_status") {
      const callId = typeof object.call_id === "string" ? object.call_id : "";
      const status = typeof object.status === "string" ? object.status : "";
      setTimeline((current) =>
        current.map((item) => (item.kind === "tool" && item.id === callId ? { ...item, status } : item))
      );
      return;
    }
    if (eventName === "approval_required") {
      const approvalId = typeof object.approval_id === "string" ? object.approval_id : "";
      const toolName = typeof object.tool_name === "string" ? object.tool_name : "";
      const summary = Array.isArray(object.summary) ? (object.summary as ApprovalSummaryRecord[]) : [];
      if (!approvalId) return;
      setTimeline((current) => [
        ...current,
        { id: approvalId, kind: "approval", toolName, summary, status: "pending" }
      ]);
      return;
    }
    if (eventName === "tool_result") {
      const callId = typeof object.call_id === "string" ? object.call_id : "";
      const result = object.result as { approval_id?: unknown; status?: unknown } | null;
      const approvalId = result && typeof result.approval_id === "string" ? result.approval_id : "";
      const approvalStatus = result && typeof result.status === "string" ? result.status : "";
      setTimeline((current) =>
        current.map((item) => {
          if (item.kind === "tool" && item.id === callId) {
            return { ...item, result: object.result, ok: object.ok === true, status: object.ok === true ? "done" : "failed" };
          }
          if (item.kind === "approval" && approvalId && item.id === approvalId) {
            return { ...item, status: approvalStatus || item.status };
          }
          return item;
        })
      );
      return;
    }
    if (eventName === "error") {
      setError(typeof object.error === "string" ? object.error : "Agent turn failed.");
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = input.trim();
    if (!content || loading) return;
    setInput("");
    setError(null);
    setLoading(true);

    try {
      const sessionId = activeSessionId || (await createSession());
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: "user", content }]);

      const response = await fetch(`/api/agent/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });
      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Agent request failed.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const eventLine = part.split("\n").find((line) => line.startsWith("event:"));
          const dataLine = part.split("\n").find((line) => line.startsWith("data:"));
          if (!eventLine || !dataLine) continue;
          const eventName = eventLine.slice(6).trim();
          const data = JSON.parse(dataLine.slice(5).trim()) as unknown;
          handleStreamEvent(eventName, data);
        }
      }
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent request failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid h-[calc(100vh-12rem)] min-h-[520px] gap-5 overflow-hidden xl:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-hidden border border-line bg-white">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-sm font-semibold">Chats</div>
          <button
            type="button"
            onClick={() => createSession().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not create chat."))}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line bg-white text-ink hover:bg-surface"
            title="New chat"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {sessions.length === 0 ? (
            <div className="px-2 py-8 text-sm text-muted">No agent chats yet.</div>
          ) : (
            sessions.map((session) => {
              const active = session.id === activeSessionId;
              const confirmingDelete = pendingDeleteSessionId === session.id;
              return (
                <div
                  key={session.id}
                  className={`mb-1 grid ${
                    confirmingDelete ? "grid-cols-[minmax(0,1fr)_68px]" : "grid-cols-[minmax(0,1fr)_32px]"
                  } items-center rounded-md ${
                    active ? "bg-ink text-white" : "hover:bg-surface"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveSessionId(session.id);
                      setPendingDeleteSessionId(null);
                      setError(null);
                      loadSession(session.id).catch((err: unknown) => {
                        setError(err instanceof Error ? err.message : "Could not load agent session.");
                      });
                    }}
                    className="min-w-0 px-3 py-2 text-left text-sm"
                  >
                    <div className="truncate">{titleFor(session)}</div>
                    <div className={`mt-1 text-xs ${active ? "text-white/70" : "text-muted"}`}>{session.status}</div>
                  </button>
                  {confirmingDelete ? (
                    <div className="mr-1 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setPendingDeleteSessionId(null)}
                        className={`inline-flex h-8 w-8 items-center justify-center rounded-md ${
                          active ? "text-white/70 hover:bg-white/10 hover:text-white" : "text-muted hover:bg-white hover:text-ink"
                        }`}
                        aria-label="Cancel delete"
                        title="Cancel delete"
                      >
                        <X className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => {
                          deleteSession(session.id).catch((err: unknown) => {
                            setError(err instanceof Error ? err.message : "Could not delete chat.");
                          });
                        }}
                        className={`inline-flex h-8 w-8 items-center justify-center rounded-md ${
                          active ? "text-red-200 hover:bg-white/10 hover:text-red-100" : "text-red-600 hover:bg-red-50"
                        } disabled:cursor-not-allowed disabled:opacity-40`}
                        aria-label={`Confirm delete ${titleFor(session)}`}
                        title="Confirm delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => setPendingDeleteSessionId(session.id)}
                      className={`mr-1 inline-flex h-8 w-8 items-center justify-center rounded-md ${
                        active ? "text-white/70 hover:bg-white/10 hover:text-white" : "text-muted hover:bg-white hover:text-ink"
                      } disabled:cursor-not-allowed disabled:opacity-40`}
                      aria-label={`Delete ${titleFor(session)}`}
                      title="Delete chat"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </aside>

      <section className="flex min-h-0 flex-col overflow-hidden border border-line bg-white">
        <div className="shrink-0 border-b border-line px-5 py-4">
          <div className="text-sm font-semibold">{activeSession ? titleFor(activeSession) : "Agent chat"}</div>
          <div className="text-xs text-muted">Phase D: local DB tools, live Zoho reads, mirror sync, and approval-gated writes.</div>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          {timeline.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted">
              Ask about mirrored Zoho records or request a missing capability.
            </div>
          ) : (
            timeline.map((item) => {
              if (item.kind === "tool") {
                return (
                  <div key={item.id} className="border border-line bg-surface p-3">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0] text-muted">
                      <Wrench className="h-3.5 w-3.5" />
                      Tier {item.tier ?? 0} tool: {item.name}
                      {item.status ? <span className="text-[11px] normal-case text-muted">({item.status})</span> : null}
                    </div>
                    <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap text-xs text-ink">
                      {shortJson(item.result ?? item.args)}
                    </pre>
                  </div>
                );
              }
              if (item.kind === "approval") {
                // NOT gated on `loading`: the agent turn is intentionally still
                // running (blocked waiting on this decision), so disabling the
                // card while loading would deadlock approvals forever.
                return <ApprovalCard key={item.id} item={item} onDecide={decideApproval} />;
              }
              return (
                <div
                  key={item.id}
                  className={`max-w-3xl whitespace-pre-wrap rounded-md px-4 py-3 text-sm ${
                    item.kind === "user" ? "ml-auto bg-ink text-white" : "bg-surface text-ink"
                  }`}
                >
                  {item.content}
                </div>
              );
            })
          )}
          {loading ? <div className="text-sm text-muted">Agent is working...</div> : null}
          {error ? <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
        </div>

        <form onSubmit={sendMessage} className="shrink-0 border-t border-line p-4">
          <div className="flex gap-3">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={2}
              className="min-h-12 flex-1 resize-none rounded-md border border-line px-3 py-2 text-sm outline-none focus:border-ink"
              placeholder="Ask about a deal, contact, account, tag, or missing tool... (Enter to send, Shift+Enter for a new line)"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-ink text-white disabled:cursor-not-allowed disabled:opacity-50"
              title="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function renderValue(value: unknown) {
  if (value == null) return "(empty)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

type FieldChange = { recordName: string; field: string; before: unknown; after: unknown };

function toFieldChanges(summary: ApprovalSummaryRecord[]): FieldChange[] {
  const rows: FieldChange[] = [];
  for (const record of summary) {
    const name = record.name || record.zoho_id;
    const keys = [...new Set([...Object.keys(record.after ?? {}), ...Object.keys(record.before ?? {})])];
    if (keys.length === 0) {
      rows.push({ recordName: name, field: "-", before: record.before, after: record.after });
      continue;
    }
    for (const key of keys) {
      rows.push({ recordName: name, field: key, before: record.before?.[key], after: record.after?.[key] });
    }
  }
  return rows;
}

function ApprovalCard({
  item,
  onDecide
}: {
  item: { id: string; toolName: string; summary: ApprovalSummaryRecord[]; status: string };
  onDecide: (approvalId: string, decision: "approve" | "reject") => Promise<void> | void;
}) {
  // Per-card double-click guard; the buttons unmount once the optimistic
  // status flip lands, and the server 409s a second decision regardless.
  const [deciding, setDeciding] = useState(false);
  async function decide(decision: "approve" | "reject") {
    setDeciding(true);
    try {
      await onDecide(item.id, decision);
    } finally {
      setDeciding(false);
    }
  }
  const changes = toFieldChanges(item.summary);
  const pending = item.status === "pending";
  const statusLabel: Record<string, string> = {
    pending: "Awaiting your approval",
    approved: "Approved - executing",
    executed: "Approved and written (verified)",
    rejected: "Rejected",
    expired: "Expired (not written)",
    failed: "Approved, but the write failed"
  };
  const tone =
    item.status === "executed" || item.status === "approved"
      ? "border-emerald-300 bg-emerald-50"
      : item.status === "rejected" || item.status === "expired" || item.status === "failed"
        ? "border-amber-300 bg-amber-50"
        : "border-line bg-white";

  return (
    <div className={`border ${tone} p-4`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0] text-muted">
        <ShieldAlert className="h-3.5 w-3.5" />
        Approval required: {item.toolName}
        <span className="text-[11px] normal-case text-muted">({statusLabel[item.status] ?? item.status})</span>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-muted">
              <th className="py-1 pr-3 font-medium">Record</th>
              <th className="py-1 pr-3 font-medium">Field</th>
              <th className="py-1 pr-3 font-medium">Before</th>
              <th className="py-1 pr-3 font-medium">After</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((change, index) => (
              <tr key={index} className="border-t border-line align-top">
                <td className="py-1 pr-3">{change.recordName}</td>
                <td className="py-1 pr-3 font-mono">{change.field}</td>
                <td className="py-1 pr-3 text-muted">{renderValue(change.before)}</td>
                <td className="py-1 pr-3 font-medium text-ink">{renderValue(change.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pending ? (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={deciding}
            onClick={() => decide("approve")}
            className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" /> Approve
          </button>
          <button
            type="button"
            disabled={deciding}
            onClick={() => decide("reject")}
            className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" /> Reject
          </button>
        </div>
      ) : null}
    </div>
  );
}
