import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getEnv, hasServerSupabaseEnv } from "@/lib/env";

export async function createServerSupabaseClient() {
  const url = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  if (!url || !key) {
    return null;
  }

  const cookieStore = await cookies();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot always write cookies; middleware refreshes them.
        }
      }
    }
  });
}

export function createServiceSupabaseClient() {
  if (!hasServerSupabaseEnv()) {
    return null;
  }

  return createClient(
    getEnv("NEXT_PUBLIC_SUPABASE_URL")!,
    getEnv("SUPABASE_SERVICE_ROLE_KEY")!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  );
}
