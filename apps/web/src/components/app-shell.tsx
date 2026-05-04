"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Bot, LayoutDashboard, LogOut, RadioTower, User } from "lucide-react";

import { clearAuthToken, getMe } from "@/lib/api";
import type { AccountInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/channels", label: "Channels", icon: RadioTower },
  { href: "/agents", label: "Agents", icon: Bot },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [account, setAccount] = useState<AccountInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getMe().then((me) => {
      if (!cancelled) setAccount(me);
    });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  function handleLogout() {
    clearAuthToken();
    setAccount(null);
    router.push("/login");
  }

  return (
    <div className="flex min-h-screen">
        <aside className="hidden w-64 shrink-0 border-r border-border bg-card px-4 py-5 md:block">
          <Link href="/" className="mb-8 flex items-center gap-3 px-2">
            <span className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <RadioTower className="size-4" />
            </span>
            <span>
              <span className="block text-sm font-semibold">A2A Channels</span>
              <span className="block text-xs text-muted-foreground">
                Gateway Admin
              </span>
            </span>
          </Link>
          <nav className="space-y-1">
            {navItems.map((item) => {
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                    active && "bg-accent text-accent-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* User info + logout */}
          <div className="mt-auto pt-6">
            {account ? (
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <User className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">{account.username}</span>
                </div>
                <button
                  aria-label="Log out"
                  className="ml-2 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  onClick={handleLogout}
                  type="button"
                >
                  <LogOut className="size-4" />
                </button>
              </div>
            ) : (
              <Link
                href="/login"
                className="flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <User className="size-4" />
                Sign In
              </Link>
            )}
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 items-center gap-2 border-b border-border bg-card px-4 md:hidden">
            {navItems.map((item) => {
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex h-9 flex-1 items-center justify-center gap-2 rounded-md text-xs font-medium text-muted-foreground",
                    active && "bg-accent text-accent-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  {item.label}
                </Link>
              );
            })}
            {/* Mobile logout */}
            {account && (
              <button
                aria-label="Log out"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground"
                onClick={handleLogout}
                type="button"
              >
                <LogOut className="size-4" />
              </button>
            )}
          </header>
          <main className="flex-1 p-4 sm:p-6">{children}</main>
        </div>
    </div>
  );
}
