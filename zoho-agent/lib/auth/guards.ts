import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/types";

export type AuthorizedUser = {
  id: string;
  email: string | null;
  role: UserRole;
};

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

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("role,email")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
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
      role: profile.role as UserRole
    } satisfies AuthorizedUser
  };
}
