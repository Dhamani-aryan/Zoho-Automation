export function getEnv(name: string) {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export function hasServerSupabaseEnv() {
  return Boolean(
    getEnv("NEXT_PUBLIC_SUPABASE_URL") && getEnv("SUPABASE_SERVICE_ROLE_KEY")
  );
}

export function hasBrowserSupabaseEnv() {
  return Boolean(
    getEnv("NEXT_PUBLIC_SUPABASE_URL") && getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
  );
}
