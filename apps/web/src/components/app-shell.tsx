"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, LayoutDashboard, RadioTower } from "lucide-react";

import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/channels", label: "Channels", icon: RadioTower },
  { href: "/agents", label: "Agents", icon: Bot },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

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
          </header>
          <main className="flex-1 p-4 sm:p-6">{children}</main>
        </div>
    </div>
  );
}
