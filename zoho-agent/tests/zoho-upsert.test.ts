import test from "node:test";
import assert from "node:assert/strict";
import { upsertZohoRecords, type MirrorDbClient } from "../lib/records/zoho-upsert";

type Row = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class FakeTable {
  constructor(
    private readonly table: string,
    private readonly rows: Record<string, Row[]>
  ) {}

  select(_columns: string) {
    return {
      in: async (column: string, values: string[]) => ({
        data: (this.rows[this.table] ?? []).filter((row) => values.includes(String(row[column]))).map(clone),
        error: null
      })
    };
  }

  upsert(rows: Row[], options: { onConflict: string }) {
    return {
      select: async (_columns: string) => {
        const tableRows = this.rows[this.table] ?? [];
        this.rows[this.table] = tableRows;
        const out: Row[] = [];
        for (const row of rows) {
          const key = row[options.onConflict];
          const existingIndex = tableRows.findIndex((candidate) => candidate[options.onConflict] === key);
          if (existingIndex === -1) {
            const inserted = { id: `${this.table}-${tableRows.length + 1}`, ...clone(row) };
            tableRows.push(inserted);
            out.push(clone(inserted));
          } else {
            tableRows[existingIndex] = { ...tableRows[existingIndex], ...clone(row) };
            out.push(clone(tableRows[existingIndex]));
          }
        }
        return { data: out, error: null };
      }
    };
  }
}

function fakeDb(seed: Record<string, Row[]>): { db: MirrorDbClient; rows: Record<string, Row[]> } {
  const rows = clone(seed);
  return {
    rows,
    db: {
      from(table: string) {
        return new FakeTable(table, rows);
      }
    }
  };
}

test("inserts live Zoho accounts and preserves raw data", async () => {
  const { db, rows } = fakeDb({ accounts: [] });
  const result = await upsertZohoRecords({
    db,
    module: "accounts",
    records: [
      {
        id: "1001",
        Account_Name: "Q3 Prospect",
        Website: "https://example.com",
        Phone: "555-0100",
        Industry: "Manufacturing",
        Owner: { id: "owner-1", name: "Aryan Dhamani" },
        Tag: [{ name: "Q3 Prospects" }]
      }
    ]
  });

  assert.deepEqual(result.inserted, [{ zoho_id: "1001", name: "Q3 Prospect" }]);
  assert.deepEqual(result.updated, []);
  assert.equal(result.unchanged_count, 0);
  assert.equal(rows.accounts[0].account_name, "Q3 Prospect");
  assert.equal((rows.accounts[0].raw_data as Row).Account_Name, "Q3 Prospect");
  assert.equal(rows.accounts[0].zoho_url, "https://crm.zoho.com/crm/org890324941/tab/Accounts/1001");
});

test("classifies unchanged and updated rows idempotently", async () => {
  const account = {
    id: "accounts-1",
    zoho_account_id: "1001",
    zoho_url: "https://crm.zoho.com/crm/org890324941/tab/Accounts/1001",
    account_name: "Q3 Prospect",
    website: null,
    phone: null,
    industry: null,
    owner: "Aryan Dhamani",
    source: "zoho_live",
    raw_data: { id: "1001", Account_Name: "Q3 Prospect", Owner: { name: "Aryan Dhamani" } }
  };
  const { db } = fakeDb({ accounts: [account] });

  const unchanged = await upsertZohoRecords({
    db,
    module: "accounts",
    records: [{ id: "1001", Account_Name: "Q3 Prospect", Owner: { name: "Aryan Dhamani" } }]
  });
  assert.equal(unchanged.unchanged_count, 1);
  assert.deepEqual(unchanged.updated, []);

  const updated = await upsertZohoRecords({
    db,
    module: "accounts",
    records: [{ id: "1001", Account_Name: "Q3 Prospect", Phone: "555-0199", Owner: { name: "Aryan Dhamani" } }]
  });
  assert.deepEqual(updated.updated, [{ zoho_id: "1001", name: "Q3 Prospect" }]);
});

test("resolves contact account foreign keys and warns on missing accounts", async () => {
  const { db, rows } = fakeDb({
    accounts: [{ id: "account-uuid", zoho_account_id: "acct-1", account_name: "Acme" }],
    contacts: []
  });

  const result = await upsertZohoRecords({
    db,
    module: "contacts",
    records: [
      {
        id: "contact-1",
        Full_Name: "Jane Buyer",
        Email: "jane@example.com",
        Account_Name: { id: "acct-1", name: "Acme" }
      },
      {
        id: "contact-2",
        Full_Name: "No Account",
        Account_Name: { id: "acct-missing", name: "Missing" }
      }
    ]
  });

  assert.equal(result.inserted.length, 2);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /acct-missing/);
  assert.equal(rows.contacts[0].account_id, "account-uuid");
  assert.equal(rows.contacts[1].account_id, null);
});

test("resolves deal account and contact foreign keys", async () => {
  const { db, rows } = fakeDb({
    accounts: [{ id: "account-uuid", zoho_account_id: "acct-1", account_name: "Acme" }],
    contacts: [{ id: "contact-uuid", zoho_contact_id: "contact-1", full_name: "Jane Buyer" }],
    deals: []
  });

  const result = await upsertZohoRecords({
    db,
    module: "deals",
    records: [
      {
        id: "deal-1",
        Deal_Name: "Acme | SAP Cloud ERP",
        Stage: "Follow-Up",
        Next_Step: "Call",
        Amount: "12,500",
        Closing_Date: "2026-08-31",
        Account_Name: { id: "acct-1", name: "Acme" },
        Contact_Name: { id: "contact-1", name: "Jane Buyer" }
      }
    ]
  });

  assert.deepEqual(result.inserted, [{ zoho_id: "deal-1", name: "Acme | SAP Cloud ERP" }]);
  assert.equal(rows.deals[0].account_id, "account-uuid");
  assert.equal(rows.deals[0].primary_contact_id, "contact-uuid");
  assert.equal(rows.deals[0].amount, 12500);
});

test("rejects records without ids and module-shape mismatches", async () => {
  const { db } = fakeDb({ deals: [] });
  await assert.rejects(
    () => upsertZohoRecords({ db, module: "deals", records: [{ Deal_Name: "Missing id" }] }),
    /string id/
  );
  await assert.rejects(
    () => upsertZohoRecords({ db, module: "deals", records: [{ id: "contact-1", Full_Name: "Jane Buyer" }] }),
    /Deal_Name/
  );
});
