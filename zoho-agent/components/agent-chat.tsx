"use client";

import {
  ChevronRight,
  CheckCircle2,
  CircleDashed,
  FileText,
  GraduationCap,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  ShieldCheck,
  Square,
  Trash2,
  X,
  XCircle
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type AgentSession = {
  id: string;
  title: string | null;
  status: string;
  teach_mode: boolean;
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
    };

type AttachedContextFile = {
  id: string;
  name: string;
  size: number;
  text: string;
};

const ATTACHMENT_MAX_FILES = 4;
const ATTACHMENT_MAX_BYTES = 750_000;
const TEXTAREA_MAX_HEIGHT_PX = 220;
const ATTACHMENT_ALLOWED_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".csv", ".tsv"]);

function buildTimeline(rows: AgentMessageRow[]): TimelineItem[] {
  type Stamped = { at: string; seq: number; item: TimelineItem };
  const stamped: Stamped[] = [];
  let seq = 0;

  // Each tool call persists two rows: an assistant "marker" row (the call) and
  // a "tool" row (the result). Merge them by call id so a finished call renders
  // as ONE row with a resolved status, instead of two stuck-on-"Working" rows.
  const toolByCall = new Map<string, { item: Extract<TimelineItem, { kind: "tool" }> }>();
  const callId = (args: unknown, fallback: string) => {
    const value = (args as { _call_id?: unknown } | null)?._call_id;
    return typeof value === "string" ? value : fallback;
  };

  for (const row of rows) {
    if (row.role === "user" || (row.role === "assistant" && row.content)) {
      stamped.push({ at: row.created_at, seq: seq++, item: { id: row.id, kind: row.role, content: row.content ?? "" } });
      continue;
    }
    if (!row.tool_name) continue;

    const id = callId(row.tool_args, row.id);
    const existing = toolByCall.get(id);
    if (row.role === "tool") {
      const ok = !row.content;
      if (existing) {
        existing.item.result = row.tool_result;
        existing.item.ok = ok;
        existing.item.status = ok ? "done" : "failed";
      } else {
        const item: Extract<TimelineItem, { kind: "tool" }> = {
          id,
          kind: "tool",
          name: row.tool_name,
          args: row.tool_args,
          result: row.tool_result,
          ok,
          tier: row.tool_tier,
          status: ok ? "done" : "failed"
        };
        toolByCall.set(id, { item });
        stamped.push({ at: row.created_at, seq: seq++, item });
      }
      continue;
    }

    // assistant marker row = the call itself. Only add it if we haven't already
    // seen it; its status stays "running" until a tool result row resolves it.
    if (!existing) {
      const item: Extract<TimelineItem, { kind: "tool" }> = {
        id,
        kind: "tool",
        name: row.tool_name,
        args: row.tool_args,
        tier: row.tool_tier,
        status: "running"
      };
      toolByCall.set(id, { item });
      stamped.push({ at: row.created_at, seq: seq++, item });
    }
  }

  stamped.sort((a, b) => (a.at === b.at ? a.seq - b.seq : a.at < b.at ? -1 : 1));
  return stamped.map((entry) => entry.item);
}

function shortJson(value: unknown) {
  if (value == null) return "";
  const text = JSON.stringify(value, null, 2);
  return text.length > 900 ? `${text.slice(0, 900)}\n...` : text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArg(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function truncateLabel(value: string, max = 64) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function toolLabelFor(name: string, args: unknown) {
  const arg = asRecord(args);
  const action = stringArg(arg.action);
  const selector = stringArg(arg.selector);
  const query = stringArg(arg.query);
  const moduleName = stringArg(arg.module);
  const path = stringArg(arg.path);
  const subject = stringArg(arg.subject);
  const toEmail = stringArg(arg.to_email);
  const batchReference = stringArg(arg.batch_reference);

  if (name === "browser_input" && action) {
    const target = stringArg(arg.label) || selector || stringArg(arg.target) || stringArg(arg.value);
    return `browser_input · ${action}${target ? ` → ${truncateLabel(target)}` : ""}`;
  }
  if (name === "browser_observe") return "browser_observe · inspect page";
  if (name === "read_workspace_file" && path) return `read_workspace_file · ${truncateLabel(path)}`;
  if (name === "db_search_records" && query) return `db_search_records · ${truncateLabel(query)}`;
  if (name === "db_get_record" && moduleName) return `db_get_record · ${moduleName}`;
  if (name === "db_query" && query) return `db_query · ${truncateLabel(query)}`;
  if (name === "zoho_api" && moduleName) return `zoho_api · ${moduleName}`;
  if (name === "schedule_zoho_email" && (toEmail || subject)) {
    return `schedule_zoho_email · ${truncateLabel(toEmail || subject)}`;
  }
  if (name === "schedule_zoho_email_batch" && batchReference) {
    return `schedule_zoho_email_batch · ${truncateLabel(batchReference)}`;
  }
  return name;
}

function collectVerificationEvidence(result: unknown) {
  const evidence: string[] = [];
  const walk = (value: unknown, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (Array.isArray(value)) {
      value.slice(0, 12).forEach((item) => walk(item, depth + 1));
      return;
    }
    const object = asRecord(value);
    if (Object.keys(object).length === 0) return;
    if (object.verified === true) evidence.push("Verified read-back matched the request.");
    if (object.signature_present === true) evidence.push("Composer signature is present.");
    if (object.signature_after_body === true) evidence.push("Signature remains after the body.");
    if (object.schedule_confirmation) evidence.push("Schedule confirmation was observed.");
    if (object.scheduled_row_found === true) evidence.push("Scheduled email row was found.");
    if (object.receipt) evidence.push("Receipt captured.");
    for (const child of Object.values(object)) walk(child, depth + 1);
  };
  walk(result);
  return Array.from(new Set(evidence)).slice(0, 4);
}

function titleFor(session: AgentSession) {
  return session.title || "New agent chat";
}

// Splits message text into plain runs and clickable links. Bare http/https
// URLs become <a> links; trailing sentence punctuation is left out of the href.
const URL_RE = /(https?:\/\/[^\s<]+)/g;

function linkifyContent(text: string, linkClass: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    let url = match[0];
    // Don't swallow trailing punctuation that is almost certainly not part of
    // the URL (e.g. "see https://x.com/a." or "(https://x.com/a)").
    let trailing = "";
    const trailMatch = url.match(/[.,;:!?)\]}'"]+$/);
    if (trailMatch) {
      trailing = trailMatch[0];
      url = url.slice(0, url.length - trailing.length);
    }
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));
    nodes.push(
      <a
        key={`link-${key++}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
      >
        {url}
      </a>
    );
    if (trailing) nodes.push(trailing);
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.length > 0 ? nodes : [text];
}

// Collapsible execution timeline row. The default view is operational and
// readable; raw args/results stay behind details for debugging.
function ToolTrace({
  item
}: {
  item: { name: string; tier?: number | null; status?: string; result?: unknown; args: unknown };
}) {
  const status = item.status ?? "";
  const running = status === "" || status === "called" || status === "queued" || status === "running";
  const failed = status === "failed";
  const label = failed ? "Failed" : running ? "Running" : "Succeeded";
  const evidence = collectVerificationEvidence(item.result);
  const StatusIcon = failed ? XCircle : running ? Loader2 : CheckCircle2;

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-start gap-3 px-3 py-3">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-canvas">
          <StatusIcon
            className={`h-3.5 w-3.5 ${
              failed ? "text-danger" : running ? "animate-spin text-running" : "text-success"
            }`}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className={failed ? "font-semibold text-danger" : running ? "font-semibold text-running" : "font-semibold text-success"}>
              {label}
            </span>
            <span className="truncate text-ink">{toolLabelFor(item.name, item.args)}</span>
            <span className="text-xs text-muted">Tier {item.tier ?? 0}</span>
          </div>
          <details className="mt-2 text-xs text-muted">
            <summary className="inline-flex cursor-pointer items-center gap-1 hover:text-ink">
              <ChevronRight className="h-3 w-3" />
              View details
            </summary>
            <div className="mt-2 grid gap-2 lg:grid-cols-2">
              <div>
                <div className="mb-1 font-semibold text-muted">Args</div>
                <pre className="max-h-64 overflow-auto rounded-md border border-line bg-canvas p-3 text-xs text-ink">
                  {shortJson(item.args)}
                </pre>
              </div>
              <div>
                <div className="mb-1 font-semibold text-muted">Result</div>
                <pre className="max-h-64 overflow-auto rounded-md border border-line bg-canvas p-3 text-xs text-ink">
                  {shortJson(item.result)}
                </pre>
              </div>
            </div>
          </details>
        </div>
      </div>
      {evidence.length > 0 ? (
        <div className="border-t border-line bg-canvas px-3 py-2">
          <div className="flex items-start gap-3 text-xs text-muted">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <div>
              <div className="font-semibold text-ink">Verification evidence</div>
              <div className="mt-1 flex flex-wrap gap-2">
                {evidence.map((item) => (
                  <span key={item} className="rounded-md border border-success/30 bg-success/10 px-2 py-1 text-success">
                    {item}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : running ? (
        <div className="border-t border-line bg-canvas px-3 py-2 text-xs text-muted">
          <div className="flex items-center gap-2">
            <CircleDashed className="h-3.5 w-3.5 text-running" />
            Waiting for result...
          </div>
        </div>
      ) : null}
    </div>
  );
}

function resizeComposerTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  const nextHeight = Math.min(element.scrollHeight, TEXTAREA_MAX_HEIGHT_PX);
  element.style.height = `${nextHeight}px`;
  element.style.overflowY = element.scrollHeight > TEXTAREA_MAX_HEIGHT_PX ? "auto" : "hidden";
}

export function AgentChat({
  initialSessions,
  initialMessages,
  initialActiveSessionId,
  initialDraft = ""
}: {
  initialSessions: AgentSession[];
  initialMessages: AgentMessageRow[];
  initialActiveSessionId?: string;
  initialDraft?: string;
}) {
  const [sessions, setSessions] = useState(initialSessions);
  const [activeSessionId, setActiveSessionId] = useState(
    initialActiveSessionId ?? initialSessions[0]?.id ?? ""
  );
  const [timeline, setTimeline] = useState<TimelineItem[]>(buildTimeline(initialMessages));
  const [input, setInput] = useState(initialDraft);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<AttachedContextFile[]>([]);
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline, loading]);

  useEffect(() => {
    if (!initialDraft) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(initialDraft.length, initialDraft.length);
    resizeComposerTextarea(el);
  }, [initialDraft]);

  useEffect(() => {
    resizeComposerTextarea(textareaRef.current);
  }, [input]);

  // Hydrate the active session on mount so the persisted tool trace rebuilds
  // after a reload/reconnect.
  useEffect(() => {
    if (activeSessionId) {
      loadSession(activeSessionId).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      session?: AgentSession;
      messages?: AgentMessageRow[];
      error?: string;
    };
    if (!response.ok) throw new Error(payload.error ?? "Could not load agent session.");
    if (payload.session) {
      setSessions((current) =>
        current.map((session) => (session.id === payload.session?.id ? payload.session : session))
      );
    }
    setTimeline(buildTimeline(payload.messages ?? []));
  }

  function extensionFor(name: string) {
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.slice(dot).toLowerCase() : "";
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function attachContextFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    setError(null);
    try {
      const slots = ATTACHMENT_MAX_FILES - attachedFiles.length;
      if (slots <= 0) throw new Error(`You can attach up to ${ATTACHMENT_MAX_FILES} files per message.`);
      const nextFiles: AttachedContextFile[] = [];
      for (const file of files.slice(0, slots)) {
        const extension = extensionFor(file.name);
        if (!ATTACHMENT_ALLOWED_EXTENSIONS.has(extension)) {
          throw new Error(`Attach Markdown, text, CSV, or TSV files only. ${file.name} is not supported.`);
        }
        if (file.size > ATTACHMENT_MAX_BYTES) {
          throw new Error(`${file.name} is ${formatBytes(file.size)}. Keep chat attachments under ${formatBytes(ATTACHMENT_MAX_BYTES)}.`);
        }
        const text = await file.text();
        if (text.includes("\0")) throw new Error(`${file.name} looks like a binary file.`);
        nextFiles.push({ id: crypto.randomUUID(), name: file.name, size: file.size, text });
      }
      setAttachedFiles((current) => [...current, ...nextFiles]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not attach file.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function messageWithAttachments(content: string) {
    if (attachedFiles.length === 0) return content;
    const fileBlocks = attachedFiles.map((file) =>
      [
        `--- ATTACHED FILE: ${file.name} (${formatBytes(file.size)}) ---`,
        file.text.trimEnd(),
        `--- END ATTACHED FILE: ${file.name} ---`
      ].join("\n")
    );
    return [content, "Use the attached file context below for this request.", ...fileBlocks].join("\n\n");
  }

  function displayMessageWithAttachmentNames(content: string) {
    if (attachedFiles.length === 0) return content;
    return `${content}\n\nAttached: ${attachedFiles.map((file) => file.name).join(", ")}`;
  }

  async function toggleTeachMode() {
    const sessionId = activeSessionId || (await createSession());
    const next = !sessions.find((session) => session.id === sessionId)?.teach_mode;
    const response = await fetch(`/api/agent/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teach_mode: next })
    });
    const payload = (await response.json().catch(() => ({}))) as { session?: AgentSession; error?: string };
    if (!response.ok || !payload.session) throw new Error(payload.error ?? "Could not update teach mode.");
    setSessions((current) =>
      current.map((session) => (session.id === payload.session?.id ? payload.session : session))
    );
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
    if (eventName === "tool_result") {
      const callId = typeof object.call_id === "string" ? object.call_id : "";
      setTimeline((current) =>
        current.map((item) => {
          if (item.kind === "tool" && item.id === callId) {
            return { ...item, result: object.result, ok: object.ok === true, status: object.ok === true ? "done" : "failed" };
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

  async function runTurn(rawContent: string, displayContent = rawContent) {
    const content = rawContent.trim();
    if (!content || loading) return;
    setError(null);
    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const sessionId = activeSessionId || (await createSession());
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: "user", content: displayContent.trim() }]);

      const response = await fetch(`/api/agent/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        signal: controller.signal
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
      // A user-initiated stop aborts the fetch; that is not an error.
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (!aborted) setError(err instanceof Error ? err.message : "Agent request failed.");
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = input.trim();
    if ((!content && attachedFiles.length === 0) || loading) return;
    const finalContent = messageWithAttachments(content || "Use the attached file context.");
    const displayContent = displayMessageWithAttachmentNames(content || "Use the attached file context.");
    setInput("");
    setAttachedFiles([]);
    await runTurn(finalContent, displayContent);
  }

  // Stop the active task order, then stop watching the current stream.
  async function stopStreaming() {
    if (activeSessionId) {
      await fetch(`/api/agent/sessions/${activeSessionId}/stop`, { method: "POST" }).catch(() => undefined);
    }
    abortRef.current?.abort();
  }

  // Resend an earlier message as a new turn (ChatGPT-style regenerate).
  function resend(content: string) {
    if (loading) return;
    void runTurn(content);
  }

  // Load a message back into the composer to edit and send again.
  function editMessage(content: string) {
    if (loading) return;
    setInput(content);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(content.length, content.length);
    }
  }

  return (
    <div className="grid h-[calc(100vh-12rem)] min-h-[520px] gap-5 overflow-hidden xl:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-hidden border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-sm font-semibold">Chats</div>
          <button
            type="button"
            onClick={() => createSession().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not create chat."))}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line bg-surface text-ink hover:bg-surface"
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
                    active ? "border border-accent/40 bg-accent/10 text-ink" : "hover:bg-line"
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
                    <div className={`mt-1 text-xs ${active ? "text-accent" : "text-muted"}`}>{session.status}</div>
                  </button>
                  {confirmingDelete ? (
                    <div className="mr-1 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setPendingDeleteSessionId(null)}
                        className={`inline-flex h-8 w-8 items-center justify-center rounded-md ${
                          active ? "text-muted hover:bg-line hover:text-ink" : "text-muted hover:bg-line hover:text-ink"
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
                          active ? "text-danger hover:bg-line" : "text-danger hover:bg-danger/10"
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
                        active ? "text-muted hover:bg-line hover:text-ink" : "text-muted hover:bg-line hover:text-ink"
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

      <section className="flex min-h-0 flex-col overflow-hidden border border-line bg-surface">
        <div className="shrink-0 border-b border-line px-5 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-sm font-semibold">{activeSession ? titleFor(activeSession) : "Agent chat"}</div>
              <div className="text-xs text-muted">
                Agent-guided Zoho work with live browser tools, skill guides, and verified CRM writes.
              </div>
            </div>
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                toggleTeachMode().catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : "Could not update teach mode.");
                });
              }}
              className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs font-semibold ${
                activeSession?.teach_mode
                  ? "border-pending/40 bg-pending/10 text-pending"
                  : "border-line bg-surface text-ink hover:bg-surface"
              } disabled:cursor-not-allowed disabled:opacity-50`}
              title="Teach a workflow"
            >
              <GraduationCap className="h-4 w-4" aria-hidden="true" />
              {activeSession?.teach_mode ? "Teaching" : "Teach a workflow"}
            </button>
          </div>
          {activeSession?.teach_mode ? (
            <div className="mt-3 rounded-md border border-pending/40 bg-pending/10 px-3 py-2 text-xs text-pending">
              Teach mode is on. The agent will do one live action per instruction, verify it, and distill the method into a skill guide when you ask it to remember.
            </div>
          ) : null}
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          {timeline.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted">
              Ask about mirrored Zoho records or request a missing capability.
            </div>
          ) : (
            timeline.map((item) => {
              if (item.kind === "tool") {
                return <ToolTrace key={item.id} item={item} />;
              }
              if (item.kind === "user") {
                return (
                  <div key={item.id} className="group flex flex-col items-end gap-1">
                    <div className="max-w-3xl whitespace-pre-wrap rounded-md border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-ink">
                      {linkifyContent(item.content, "underline underline-offset-2 hover:opacity-80 break-all")}
                    </div>
                    <div className="flex gap-1 opacity-0 transition group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => editMessage(item.content)}
                        disabled={loading}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                        title="Edit message"
                        aria-label="Edit message"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => resend(item.content)}
                        disabled={loading}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                        title="Resend message"
                        aria-label="Resend message"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={item.id}
                  className="max-w-3xl whitespace-pre-wrap rounded-md bg-surface px-4 py-3 text-sm text-ink"
                >
                  {linkifyContent(
                    item.content,
                    "text-accent underline underline-offset-2 hover:text-accent/80 break-all"
                  )}
                </div>
              );
            })
          )}
          {loading ? <div className="text-sm text-muted">Agent is working...</div> : null}
          {error ? <div className="border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div> : null}
        </div>

        <form onSubmit={sendMessage} className="shrink-0 border-t border-line p-4">
          <div className="rounded-2xl border border-line bg-surface p-3 transition-colors focus-within:border-accent">
            {attachedFiles.length > 0 ? (
              <div className="mb-3 flex flex-wrap gap-2">
                {attachedFiles.map((file) => (
                  <div
                    key={file.id}
                    className="inline-flex max-w-full items-center gap-2 rounded-xl border border-line bg-canvas px-2 py-1 text-xs text-ink"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                    <span className="max-w-64 truncate font-medium">{file.name}</span>
                    <span className="shrink-0 text-muted">{formatBytes(file.size)}</span>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => setAttachedFiles((current) => current.filter((item) => item.id !== file.id))}
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-line hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                      title={`Remove ${file.name}`}
                      aria-label={`Remove ${file.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".md,.markdown,.txt,.csv,.tsv,text/markdown,text/plain,text/csv"
              className="hidden"
              onChange={(event) => {
                attachContextFiles(event.target.files).catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : "Could not attach file.");
                });
              }}
            />
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                resizeComposerTextarea(event.target);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (!loading) event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={1}
              className="min-h-8 w-full resize-none bg-transparent px-1 py-1 text-sm text-ink outline-none placeholder:text-muted"
              placeholder="Ask about a deal, contact, account, tag, or missing tool... (Enter to send, Shift+Enter for a new line)"
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <button
                type="button"
                disabled={loading || attachedFiles.length >= ATTACHMENT_MAX_FILES}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink hover:bg-line disabled:cursor-not-allowed disabled:opacity-50"
                title="Attach context files"
                aria-label="Attach context files"
              >
                <Plus className="h-4 w-4" />
              </button>
              {loading ? (
                <button
                  type="button"
                  onClick={() => {
                    stopStreaming().catch((err: unknown) => {
                      setError(err instanceof Error ? err.message : "Could not stop the active task.");
                    });
                  }}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger text-white hover:bg-danger/90"
                  title="Stop the active task"
                  aria-label="Stop the active task"
                >
                  <Square className="h-4 w-4" fill="currentColor" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim() && attachedFiles.length === 0}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-white disabled:cursor-not-allowed disabled:opacity-50"
                  title="Send"
                  aria-label="Send message"
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}


