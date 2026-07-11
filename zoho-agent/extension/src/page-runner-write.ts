export type WritePageResult =
  | { ok: true; result: unknown }
  | { ok: false; error_message: string; error_code?: string; result?: unknown };

// Executed via chrome.scripting.executeScript({ world: "MAIN" }) in the real
// crm.zoho.com page context. MUST stay fully self-contained: no imports, no
// closures over module scope (it is serialized with toString()).
//
// This is the ONLY code path that issues Zoho WRITES. It is reached only for a
// job the server created from an approved pending_approvals row (approval_id
// present) or an approved task_orders row (task_order_id present), and
// extension/src/jobs.ts refuses to call it otherwise. Per record it: reads
// current values, aborts on an identity mismatch, skips no-op writes
// (idempotent resume), PUTs in chunks of <=100 requiring per-record SUCCESS,
// then re-reads to VERIFY before reporting verified:true.
export async function zohoWritePageRunner(job: {
  tool_name: string;
  args: Record<string, unknown>;
}): Promise<WritePageResult> {
  const ZOHO_BASE = "https://crm.zoho.com";
  const ORG_ID = "890324941";
  const REQUEST_TIMEOUT_MS = 30000;
  const JOB_DEADLINE = Date.now() + 120000;
  const LOGGED_OUT = "zoho_logged_out";

  function token() {
    const value = (document.getElementById("token") as HTMLInputElement | null)?.value;
    if (!value) {
      const error = new Error("Zoho login token was not found. Refresh or sign back into crm.zoho.com.");
      (error as Error & { errorCode?: string }).errorCode = LOGGED_OUT;
      throw error;
    }
    return value;
  }

  function loggedOut(message: string) {
    const error = new Error(message);
    (error as Error & { errorCode?: string }).errorCode = LOGGED_OUT;
    return error;
  }

  function checkDeadline() {
    if (Date.now() > JOB_DEADLINE) throw new Error("Write job exceeded its 120s cap before completing.");
  }

  function nameField(moduleName: string) {
    if (moduleName === "Accounts") return "Account_Name";
    if (moduleName === "Contacts") return "Full_Name";
    return "Deal_Name";
  }

  function norm(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "object") {
      const named = value as { name?: unknown; id?: unknown };
      if (typeof named.name === "string") return named.name.trim();
      if (typeof named.id === "string") return named.id.trim();
      return JSON.stringify(value);
    }
    return String(value).trim();
  }

  function valuesEqual(a: unknown, b: unknown) {
    return norm(a) === norm(b);
  }

  async function request(method: string, path: string, params: Record<string, string>, body?: unknown) {
    checkDeadline();
    const url = new URL(path, ZOHO_BASE);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), {
        method,
        credentials: "include",
        headers: {
          "X-ZCSRF-TOKEN": `crmcsrfparam=${token()}`,
          "X-CRM-ORG": ORG_ID,
          "X-Requested-With": "XMLHttpRequest",
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (response.status === 204) return { data: [] as Array<Record<string, unknown>> };
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.redirected ||
        !contentType.includes("json")
      ) {
        throw loggedOut("Zoho returned a login/auth response instead of JSON. Sign back into crm.zoho.com.");
      }

      const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const code = typeof parsed.code === "string" ? parsed.code : "";
      if (code === "INVALID_TICKET" || code === "AUTHENTICATION_FAILURE") {
        throw loggedOut(`Zoho authentication failed: ${code}.`);
      }
      if (!response.ok) {
        const message = [code, typeof parsed.message === "string" ? parsed.message : ""].filter(Boolean).join(": ");
        throw new Error(message || `Zoho ${method} failed with ${response.status}.`);
      }
      return parsed;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`Zoho ${method} timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function getRecord(moduleName: string, id: string, fields: string[]) {
    return request("GET", `/crm/v3/${moduleName}/${id}`, { fields: fields.join(",") });
  }

  function firstRecord(body: Record<string, unknown>): Record<string, unknown> | null {
    const data = body.data;
    return Array.isArray(data) && data[0] && typeof data[0] === "object"
      ? (data[0] as Record<string, unknown>)
      : null;
  }

  function identityMismatch(id: string, expected: unknown, actual: unknown): WritePageResult {
    return {
      ok: false,
      error_code: "identity_mismatch",
      error_message: `Record ${id} is "${norm(actual) || "(missing)"}" but the approved change targeted "${norm(
        expected
      )}". Aborted before writing; nothing was changed for this or the remaining records.`
    };
  }

  function responseRowId(row: Record<string, unknown>) {
    const details = row.details;
    if (details && typeof details === "object" && typeof (details as { id?: unknown }).id === "string") {
      return (details as { id: string }).id;
    }
    return typeof row.id === "string" ? row.id : null;
  }

  function failureResult(tool: string, moduleName: string, records: RecordResult[], extra: Record<string, unknown> = {}) {
    return { tool, module: moduleName, records, ...extra };
  }

  function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  type RecordResult = {
    zoho_id: string;
    name: string | null;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    verified: boolean;
    code: string;
  };

  async function runUpdateFields(args: Record<string, unknown>): Promise<WritePageResult> {
    const moduleName = String(args.module ?? "");
    const updates = (args.updates ?? []) as Array<{
      zoho_id: string;
      expected_name: string | null;
      fields: Record<string, unknown>;
    }>;

    const results: RecordResult[] = [];
    const toPut: Array<Record<string, unknown>> = [];
    const putIndex = new Map<string, RecordResult>();

    // Pass 1: read current, identity check, skip-if-equal.
    for (const update of updates) {
      const fieldNames = Object.keys(update.fields);
      const body = await getRecord(moduleName, update.zoho_id, [nameField(moduleName), ...fieldNames]);
      const record = firstRecord(body);
      if (!record) throw new Error(`Record ${update.zoho_id} was not found.`);

      const actualName = record[nameField(moduleName)];
      if (update.expected_name != null && !valuesEqual(actualName, update.expected_name)) {
        return identityMismatch(update.zoho_id, update.expected_name, actualName);
      }

      const before: Record<string, unknown> = {};
      for (const field of fieldNames) before[field] = record[field] ?? null;
      const changed = fieldNames.filter((field) => !valuesEqual(record[field], update.fields[field]));

      const result: RecordResult = {
        zoho_id: update.zoho_id,
        name: typeof actualName === "string" ? actualName : null,
        before,
        after: { ...update.fields },
        verified: changed.length === 0, // already-equal is verified true
        code: changed.length === 0 ? "UNCHANGED" : "PENDING"
      };
      results.push(result);
      if (changed.length > 0) {
        const payload: Record<string, unknown> = { id: update.zoho_id };
        for (const field of changed) payload[field] = update.fields[field];
        toPut.push(payload);
        putIndex.set(update.zoho_id, result);
      }
    }

    // Pass 2: PUT in chunks of <=100; require per-record SUCCESS.
    for (const group of chunk(toPut, 100)) {
      const body = await request("PUT", `/crm/v2.2/${moduleName}`, {}, { data: group });
      const rows = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
      const rowsById = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const id = responseRowId(row);
        if (id) rowsById.set(id, row);
      }
      for (const entry of group) {
        const id = String(entry.id);
        const row = rowsById.get(id) ?? {};
        const code = typeof row.code === "string" ? row.code : "UNKNOWN";
        const target = putIndex.get(id);
        if (target) target.code = code;
        if (code !== "SUCCESS") {
          return {
            ok: false,
            error_code: "write_failed",
            error_message: `Zoho did not accept the write for ${id} (code ${code}).`,
            result: failureResult("zoho_update_fields", moduleName, results, { failed_record_id: id, failed_code: code })
          };
        }
      }
    }

    // Pass 3: read-back verify.
    for (const result of results) {
      if (result.code === "UNCHANGED") continue;
      const body = await getRecord(moduleName, result.zoho_id, [nameField(moduleName), ...Object.keys(result.after)]);
      const record = firstRecord(body) ?? {};
      const verified = Object.keys(result.after).every((field) => valuesEqual(record[field], result.after[field]));
      result.verified = verified;
      if (!verified) {
        return {
          ok: false,
          error_code: "verify_failed",
          error_message: `Read-back verification failed for ${result.zoho_id}; the field did not hold the new value.`,
          result: failureResult("zoho_update_fields", moduleName, results, { failed_record_id: result.zoho_id })
        };
      }
    }

    return { ok: true, result: { tool: "zoho_update_fields", module: moduleName, records: results } };
  }

  async function runChangeOwner(args: Record<string, unknown>): Promise<WritePageResult> {
    const moduleName = String(args.module ?? "");
    const owner = (args.owner ?? {}) as { id: string; name: string };
    const records = (args.records ?? []) as Array<{ zoho_id: string; expected_name: string | null }>;
    const results: RecordResult[] = [];

    for (const entry of records) {
      const body = await getRecord(moduleName, entry.zoho_id, [nameField(moduleName), "Owner"]);
      const record = firstRecord(body);
      if (!record) throw new Error(`Record ${entry.zoho_id} was not found.`);
      const actualName = record[nameField(moduleName)];
      if (entry.expected_name != null && !valuesEqual(actualName, entry.expected_name)) {
        return identityMismatch(entry.zoho_id, entry.expected_name, actualName);
      }

      const currentOwner = record.Owner as { id?: string; name?: string } | undefined;
      const result: RecordResult = {
        zoho_id: entry.zoho_id,
        name: typeof actualName === "string" ? actualName : null,
        before: { Owner: currentOwner?.name ?? null },
        after: { Owner: owner.name },
        verified: false,
        code: "PENDING"
      };

      if (currentOwner?.id && valuesEqual(currentOwner.id, owner.id)) {
        result.verified = true;
        result.code = "UNCHANGED";
        results.push(result);
        continue;
      }

      results.push(result);

      const putBody = await request("PUT", `/crm/v2.2/${moduleName}`, {}, { data: [{ id: entry.zoho_id, Owner: { id: owner.id } }] });
      const row = (Array.isArray(putBody.data) ? putBody.data[0] : {}) as Record<string, unknown>;
      const code = typeof row.code === "string" ? row.code : "UNKNOWN";
      result.code = code;
      if (code !== "SUCCESS") {
        return {
          ok: false,
          error_code: "write_failed",
          error_message: `Zoho did not accept the owner change for ${entry.zoho_id} (code ${code}).`,
          result: failureResult("zoho_change_owner", moduleName, results, {
            failed_record_id: entry.zoho_id,
            failed_code: code
          })
        };
      }

      const verifyBody = await getRecord(moduleName, entry.zoho_id, [nameField(moduleName), "Owner"]);
      const verifyRecord = firstRecord(verifyBody) ?? {};
      const newOwner = verifyRecord.Owner as { id?: string } | undefined;
      result.verified = Boolean(newOwner?.id && valuesEqual(newOwner.id, owner.id));
      if (!result.verified) {
        return {
          ok: false,
          error_code: "verify_failed",
          error_message: `Read-back verification failed for ${entry.zoho_id}; owner did not update.`,
          result: failureResult("zoho_change_owner", moduleName, results, { failed_record_id: entry.zoho_id })
        };
      }
    }

    return { ok: true, result: { tool: "zoho_change_owner", module: moduleName, records: results } };
  }

  async function runTags(args: Record<string, unknown>, add: boolean): Promise<WritePageResult> {
    const moduleName = String(args.module ?? "");
    const tags = ((args.tags ?? []) as string[]).map((tag) => String(tag));
    const records = (args.records ?? []) as Array<{ zoho_id: string; expected_name: string | null }>;
    const action = add ? "add_tags" : "remove_tags";
    const results: RecordResult[] = [];

    function tagNames(record: Record<string, unknown>): string[] {
      const tag = record.Tag;
      if (!Array.isArray(tag)) return [];
      return tag
        .map((entry) => (entry && typeof entry === "object" ? String((entry as { name?: unknown }).name ?? "") : String(entry)))
        .filter(Boolean);
    }

    for (const entry of records) {
      const body = await getRecord(moduleName, entry.zoho_id, [nameField(moduleName), "Tag"]);
      const record = firstRecord(body);
      if (!record) throw new Error(`Record ${entry.zoho_id} was not found.`);
      const actualName = record[nameField(moduleName)];
      if (entry.expected_name != null && !valuesEqual(actualName, entry.expected_name)) {
        return identityMismatch(entry.zoho_id, entry.expected_name, actualName);
      }

      const before = tagNames(record);
      const result: RecordResult = {
        zoho_id: entry.zoho_id,
        name: typeof actualName === "string" ? actualName : null,
        before: { tags: before },
        after: add ? { add: tags } : { remove: tags },
        verified: false,
        code: "PENDING"
      };
      results.push(result);

      const putBody = await request(
        "POST",
        `/crm/v2.2/${moduleName}/${entry.zoho_id}/actions/${action}`,
        {},
        { tags: tags.map((name) => ({ name })) }
      );
      const row = (Array.isArray(putBody.data) ? putBody.data[0] : putBody) as Record<string, unknown>;
      const code = typeof row.code === "string" ? row.code : "SUCCESS";
      result.code = code;
      if (code !== "SUCCESS") {
        return {
          ok: false,
          error_code: "write_failed",
          error_message: `Zoho did not accept the tag change for ${entry.zoho_id} (code ${code}).`,
          result: failureResult(action, moduleName, results, { failed_record_id: entry.zoho_id, failed_code: code })
        };
      }

      const verifyBody = await getRecord(moduleName, entry.zoho_id, [nameField(moduleName), "Tag"]);
      const after = tagNames(firstRecord(verifyBody) ?? {});
      const lower = after.map((tag) => tag.toLowerCase());
      const verified = add
        ? tags.every((tag) => lower.includes(tag.toLowerCase()))
        : tags.every((tag) => !lower.includes(tag.toLowerCase()));
      result.verified = verified;
      (result.after as Record<string, unknown>).tags_after = after;
      if (!verified) {
        return {
          ok: false,
          error_code: "verify_failed",
          error_message: `Read-back verification failed for ${entry.zoho_id}; tags did not update as expected.`,
          result: failureResult(action, moduleName, results, { failed_record_id: entry.zoho_id })
        };
      }
    }

    return { ok: true, result: { tool: action, module: moduleName, records: results } };
  }

  type TaskRow = Record<string, unknown> & { id?: string; Subject?: string; Status?: string; Due_Date?: string };

  function lookupId(value: unknown) {
    return value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
      ? (value as { id: string }).id
      : "";
  }

  function taskRows(body: Record<string, unknown>): TaskRow[] {
    if (!Array.isArray(body.data)) return [];
    return (body.data as TaskRow[]).filter((row) => {
      const moduleName = typeof row.$module === "string" ? row.$module : "Tasks";
      return moduleName === "Tasks" && typeof row.id === "string";
    });
  }

  async function getDealTasks(dealId: string, history: boolean) {
    const relation = history ? "Activities_Chronological_View_History" : "Activities_Chronological_View";
    const body = await request("GET", `/crm/v3/Deals/${dealId}/${relation}`, {
      fields: "Subject,Status,Due_Date,What_Id,Who_Id,Owner"
    });
    return taskRows(body);
  }

  async function verifyTask(
    taskId: string,
    expected: { subject: string; status: string; due_date?: string; deal_id: string; contact_id: string }
  ) {
    const body = await getRecord("Tasks", taskId, ["Subject", "Status", "Due_Date", "What_Id", "Who_Id"]);
    const row = firstRecord(body);
    const verified = Boolean(
      row &&
        valuesEqual(row.Subject, expected.subject) &&
        valuesEqual(row.Status, expected.status) &&
        (!expected.due_date || valuesEqual(row.Due_Date, expected.due_date)) &&
        lookupId(row.What_Id) === expected.deal_id &&
        (!expected.contact_id || lookupId(row.Who_Id) === expected.contact_id)
    );
    return { verified, row };
  }

  async function runPrepareTasks(args: Record<string, unknown>): Promise<WritePageResult> {
    const dealId = String(args.deal_zoho_id ?? "");
    const dealName = String(args.deal_name ?? "");
    const contactId = String(args.contact_zoho_id ?? "");
    const newTasks = (Array.isArray(args.new_tasks) ? args.new_tasks : []) as Array<{
      subject?: unknown;
      due_date?: unknown;
    }>;
    const tasksToComplete = (Array.isArray(args.tasks_to_complete) ? args.tasks_to_complete : []) as Array<{
      subject?: unknown;
    }>;
    if (!dealId || !dealName) return { ok: false, error_code: "invalid_args", error_message: "Task preparation needs a deal id and name." };

    const dealBody = await getRecord("Deals", dealId, ["Deal_Name"]);
    const deal = firstRecord(dealBody);
    if (!deal) return { ok: false, error_code: "not_found", error_message: `Deal ${dealId} was not found.` };
    if (!valuesEqual(deal.Deal_Name, dealName)) return identityMismatch(dealId, dealName, deal.Deal_Name);

    let openTasks = await getDealTasks(dealId, false);
    const created: Array<Record<string, unknown>> = [];
    const alreadyOpen: Array<Record<string, unknown>> = [];
    const completed: Array<Record<string, unknown>> = [];

    for (const raw of newTasks) {
      const subject = String(raw.subject ?? "").trim();
      const dueDate = String(raw.due_date ?? "").trim();
      if (!subject || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        return { ok: false, error_code: "invalid_args", error_message: "Every new task needs a subject and YYYY-MM-DD due date." };
      }
      const matches = openTasks.filter((task) => valuesEqual(task.Subject, subject));
      if (matches.length > 1) {
        return { ok: false, error_code: "ambiguous_task", error_message: `Open task "${subject}" is ambiguous (${matches.length} exact matches).` };
      }
      if (matches.length === 1) {
        const checked = await verifyTask(String(matches[0].id), {
          subject,
          status: String(matches[0].Status ?? "Not Started"),
          deal_id: dealId,
          contact_id: contactId
        });
        if (!checked.verified) return { ok: false, error_code: "verify_failed", error_message: `Existing task "${subject}" failed read-back verification.` };
        alreadyOpen.push({ id: matches[0].id, subject, status: matches[0].Status, verified: true });
        continue;
      }

      const createBody = await request("POST", "/crm/v2.2/Tasks", {}, {
        data: [
          {
            Subject: subject,
            Due_Date: dueDate,
            Status: "Not Started",
            What_Id: { id: dealId },
            ...(contactId ? { Who_Id: { id: contactId } } : {}),
            $se_module: "Deals"
          }
        ]
      });
      const createRow = (Array.isArray(createBody.data) ? createBody.data[0] : {}) as Record<string, unknown>;
      const code = typeof createRow.code === "string" ? createRow.code : "UNKNOWN";
      const taskId = responseRowId(createRow);
      if (code !== "SUCCESS" || !taskId) {
        return { ok: false, error_code: "write_failed", error_message: `Zoho did not create task "${subject}" (code ${code}).` };
      }
      const checked = await verifyTask(taskId, {
        subject,
        status: "Not Started",
        due_date: dueDate,
        deal_id: dealId,
        contact_id: contactId
      });
      if (!checked.verified) return { ok: false, error_code: "verify_failed", error_message: `Created task "${subject}" failed API read-back verification.` };
      const result = { id: taskId, subject, due_date: dueDate, status: "Not Started", verified: true };
      created.push(result);
      openTasks.push({ id: taskId, Subject: subject, Due_Date: dueDate, Status: "Not Started" });
    }

    for (const raw of tasksToComplete) {
      const subject = String(raw.subject ?? "").trim();
      if (!subject) return { ok: false, error_code: "invalid_args", error_message: "Every task completion needs a subject." };
      const matches = openTasks.filter((task) => valuesEqual(task.Subject, subject));
      if (matches.length !== 1) {
        return {
          ok: false,
          error_code: matches.length ? "ambiguous_task" : "task_not_found",
          error_message: matches.length
            ? `Open task "${subject}" is ambiguous (${matches.length} exact matches).`
            : `Open task "${subject}" was not found.`
        };
      }
      const taskId = String(matches[0].id);
      const updateBody = await request("PUT", "/crm/v2.2/Tasks", {}, { data: [{ id: taskId, Status: "Completed" }] });
      const updateRow = (Array.isArray(updateBody.data) ? updateBody.data[0] : {}) as Record<string, unknown>;
      const code = typeof updateRow.code === "string" ? updateRow.code : "UNKNOWN";
      if (code !== "SUCCESS") {
        return { ok: false, error_code: "write_failed", error_message: `Zoho did not complete task "${subject}" (code ${code}).` };
      }
      const checked = await verifyTask(taskId, {
        subject,
        status: "Completed",
        deal_id: dealId,
        contact_id: contactId
      });
      if (!checked.verified) return { ok: false, error_code: "verify_failed", error_message: `Completed task "${subject}" failed API read-back verification.` };
      completed.push({ id: taskId, subject, before_status: matches[0].Status ?? null, status: "Completed", verified: true });
      openTasks = openTasks.filter((task) => task.id !== taskId);
    }

    const closedTasks = tasksToComplete.length > 0 ? await getDealTasks(dealId, true) : [];
    for (const entry of completed) {
      if (!closedTasks.some((task) => task.id === entry.id && valuesEqual(task.Status, "Completed"))) {
        return { ok: false, error_code: "verify_failed", error_message: `Completed task "${entry.subject}" was not found in activity history.` };
      }
    }

    return { ok: true, result: { tool: "zoho_prepare_tasks", deal_id: dealId, created, already_open: alreadyOpen, completed, verified: true } };
  }

  try {
    if (job.tool_name === "zoho_update_fields") return await runUpdateFields(job.args);
    if (job.tool_name === "zoho_change_owner") return await runChangeOwner(job.args);
    if (job.tool_name === "zoho_add_tags") return await runTags(job.args, true);
    if (job.tool_name === "zoho_remove_tags") return await runTags(job.args, false);
    if (job.tool_name === "zoho_prepare_tasks") return await runPrepareTasks(job.args);
    return { ok: false, error_message: `Write tool ${job.tool_name} is not supported by this extension version.` };
  } catch (error) {
    return {
      ok: false,
      error_message: error instanceof Error ? error.message : "Zoho write failed.",
      error_code:
        error instanceof Error && (error as Error & { errorCode?: string }).errorCode === LOGGED_OUT
          ? LOGGED_OUT
          : undefined
    };
  }
}
