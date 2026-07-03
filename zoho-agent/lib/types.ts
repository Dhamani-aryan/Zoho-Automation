export type UserRole = "admin" | "operator" | "reviewer";

export type RunStatus =
  | "draft"
  | "validating"
  | "preview_ready"
  | "approved"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export type RunItemStatus =
  | "pending"
  | "running"
  | "success"
  | "skipped"
  | "failed"
  | "needs_review";

export type DashboardStats = {
  connected: boolean;
  accounts: number;
  contacts: number;
  deals: number;
  runs: number;
  fieldMeta: number;
};

export type RecentRun = {
  id: string;
  status: RunStatus;
  run_kind: "read" | "write";
  created_at: string;
  totals: Record<string, number>;
};

export type RecordListRow = {
  id: string;
  zoho_id: string | null;
  name: string;
  owner: string | null;
  zoho_url: string | null;
  updated_at: string | null;
  extra?: string | null;
};
