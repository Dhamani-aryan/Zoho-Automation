import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/types";

export type AuthorizedUser = {
  id: string;
  email: string | null;
  role: UserRole;
  approvals_enabled: boolean;
};

async function loadProfile(supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>, userId: string) {
  if (!supabase) return { profile: null };

  const withApprovals = await supabase
    .from("users")
    .select("role,email,approvals_enabled")
    .eq("id", userId)
    .single();
  if (!withApprovals.error && withApprovals.data) {
    return { profile: withApprovals.data as { role: string; email: string | null; approvals_enabled?: boolean | null } };
  }

  // Backward compatibility for a running app pointed at a cloud database before
  // the Phase G migration has been applied. Without this retry, every route
  // that requires a user profile fails with "User profile is not configured"
  // because PostgREST rejects the unknown approvals_enabled column.
  const legacy = await supabase
    .from("users")
    .select("role,email")
    .eq("id", userId)
    .single();
  if (!legacy.error && legacy.data) {
    return { profile: { ...(legacy.data as { role: string; email: string | null }), approvals_enabled: false } };
  }

  return { profile: null };
}

export async function requireApiRole(allowedRoles: UserRole[]) {
  const supabase = await createServerSupabaseClient();

  if (!supabase) {
    return {
      error: NextResponse.json({ error: "Supabase is not configured." }, { status: 401 })
    };
  }

  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return {
      error: NextResponse.json({ error: "Authentication required." }, { status: 401 })
    };
  }

  const { profile } = await loadProfile(supabase, user.id);

  if (!profile) {
    return {
      error: NextResponse.json({ error: "User profile is not configured." }, { status: 403 })
    };
  }

  if (!allowedRoles.includes(profile.role as UserRole)) {
    return {
      error: NextResponse.json({ error: "Insufficient permissions." }, { status: 403 })
    };
  }

  return {
    supabase,
    user: {
      id: user.id,
      email: profile.email ?? user.email ?? null,
      role: profile.role as UserRole,
      approvals_enabled: Boolean(profile.approvals_enabled)
    } satisfies AuthorizedUser
  };
}

export async function requirePageRole(allowedRoles: UserRole[]) {
  const supabase = await createServerSupabaseClient();
  if (!supabase) redirect("/login");

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { profile } = await loadProfile(supabase, user.id);

  if (!profile || !allowedRoles.includes(profile.role as UserRole)) {
    redirect("/agent");
  }

  return {
    supabase,
    user: {
      id: user.id,
      email: profile.email ?? user.email ?? null,
      role: profile.role as UserRole,
      approvals_enabled: Boolean(profile.approvals_enabled)
    } satisfies AuthorizedUser
  };
}
