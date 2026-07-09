import Link from "next/link";
import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-4 py-10">
      <section className="w-full max-w-md rounded-md border border-line bg-white p-6 shadow-soft">
        <div className="mb-6">
          <Link href="/agent" className="text-xs font-semibold uppercase tracking-[0.08em] text-accent">
            Zoho Agent
          </Link>
          <h1 className="mt-3 text-2xl font-semibold tracking-[0]">Sign in</h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            Supabase email/password auth will be active when the cloud project values are set.
          </p>
        </div>
        <LoginForm />
      </section>
    </main>
  );
}
