"use client";

import { useState } from "react";
import { LogIn } from "lucide-react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    const supabase = createBrowserSupabaseClient();
    if (!supabase) {
      setLoading(false);
      setMessage("Supabase env values are not configured yet.");
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    window.location.href = "/dashboard";
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Email</span>
        <input
          className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Password</span>
        <input
          className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      {message ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {message}
        </div>
      ) : null}
      <button
        type="submit"
        disabled={loading}
        className="focus-ring inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-white disabled:opacity-60"
      >
        <LogIn className="h-4 w-4" aria-hidden="true" />
        {loading ? "Signing in" : "Sign in"}
      </button>
    </form>
  );
}
