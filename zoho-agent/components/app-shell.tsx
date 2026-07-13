import {
  BotMessageSquare,
  ChartNoAxesColumnIncreasing,
  ClipboardList,
  Database,
  FileUp,
  LayoutDashboard,
  Settings,
  Settings2
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { ZOHO_CRM_DOMAIN, ZOHO_ORG_ID } from "@/lib/constants";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/types";

const navItems: Array<{
  href: string;
  label: string;
  icon: LucideIcon;
  roles?: UserRole[];
}> = [
  { href: "/agent", label: "Agent", icon: BotMessageSquare },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/records", label: "Records", icon: Database },
  { href: "/imports", label: "Imports", icon: FileUp },
  { href: "/runs", label: "Runs", icon: ClipboardList },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/admin/agent-activity", label: "Agent Activity", icon: ChartNoAxesColumnIncreasing, roles: ["admin"] },
  { href: "/admin/field-meta", label: "Field Meta", icon: Settings2, roles: ["admin"] }
];

export async function AppShell({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();
  let email: string | null = null;
  let role: UserRole | null = null;

  if (supabase) {
    const {
      data: { user }
    } = await supabase.auth.getUser();

    if (user) {
      const { data: profile } = await supabase
        .from("users")
        .select("email,role")
        .eq("id", user.id)
        .single();

      email = profile?.email ?? user.email ?? null;
      role = (profile?.role as UserRole | undefined) ?? null;
    }
  }

  const visibleNavItems = navItems.filter((item) => !item.roles || (role && item.roles.includes(role)));

  return (
    <div className="min-h-screen bg-surface text-ink">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-line bg-white lg:block">
        <div className="flex h-16 items-center border-b border-line px-5">
          <div>
            <div className="text-sm font-semibold tracking-[0]">Zoho Agent</div>
            <div className="text-xs text-muted">V2 agent pilot</div>
          </div>
        </div>
        <nav className="space-y-1 p-3">
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex h-10 items-center gap-3 rounded-md px-3 text-sm text-ink hover:bg-surface"
              >
                <Icon className="h-4 w-4 text-muted" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 border-b border-line bg-white/95 backdrop-blur">
          <div className="flex min-h-16 flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between lg:px-8">
            <div>
              <div className="text-sm font-semibold">KloudData sales operations</div>
              <div className="text-xs text-muted">
                Zoho org {ZOHO_ORG_ID} on {ZOHO_CRM_DOMAIN}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 lg:hidden">
              {visibleNavItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md border border-line bg-white px-3 py-2 text-xs"
                >
                  {item.label}
                </Link>
              ))}
            </div>
            <div className="hidden items-center gap-3 sm:flex">
              {email ? <div className="max-w-64 truncate text-sm text-muted">{email}</div> : null}
              <SignOutButton />
            </div>
          </div>
        </header>
        <main className="px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
