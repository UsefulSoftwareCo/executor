"use client";

import {
  ArrowLeft,
  Bot,
  Cable,
  LogOut,
  Menu,
  Settings as SettingsIcon,
  ShieldAlert,
  SlidersHorizontal,
  Trophy,
  User,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { SWRConfig } from "swr";
import { signOut } from "@/lib/auth/actions";
import { useSession } from "@/hooks/use-session";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { SessionUserInfo } from "@/lib/session/types";

const baseSidebarItems = [
  {
    id: "profile",
    label: "Profile",
    href: "/settings/profile",
    icon: User,
  },
  {
    id: "preferences",
    label: "Preferences",
    href: "/settings/preferences",
    icon: SettingsIcon,
  },
  {
    id: "connections",
    label: "Connections",
    href: "/settings/connections",
    icon: Cable,
  },
  {
    id: "models",
    label: "Models",
    href: "/settings/models",
    icon: SlidersHorizontal,
  },
  {
    id: "agents",
    label: "Agents",
    href: "/settings/agents",
    icon: Bot,
  },
  {
    id: "executor",
    label: "Executor",
    href: "/settings/executor",
    icon: Wrench,
  },
  {
    id: "leaderboard",
    label: "Leaderboard",
    href: "/settings/leaderboard",
    icon: Trophy,
  },
];

const adminSidebarItem = {
  id: "admin",
  label: "Admin",
  href: "/settings/admin",
  icon: ShieldAlert,
};

function SettingsLayout({
  children,
  pathname,
  isAdmin,
}: {
  children: React.ReactNode;
  pathname: string;
  isAdmin: boolean;
}) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const sidebarItems = isAdmin ? [...baseSidebarItems, adminSidebarItem] : baseSidebarItems;
  const activeItem = sidebarItems.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
  const isExecutorSection = pathname.startsWith("/settings/executor");

  const navItems = (
    <ul className="space-y-1">
      {sidebarItems.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.id}>
            <Link
              href={item.href}
              onClick={() => setMobileSidebarOpen(false)}
              className={cn(
                "flex w-full items-center gap-3 rounded-md px-4 py-2 text-left text-sm transition-colors",
                isActive
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 border-r border-border md:flex">
        <div className="flex h-full w-full flex-col overflow-y-auto">
          <div className="flex items-center gap-4 px-6 py-4">
            <Link
              href="/sessions"
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
          </div>
          <nav className="flex-1 px-2 py-2">
            <div className="mb-2 px-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Settings
            </div>
            {navItems}
          </nav>
          <div className="border-t border-border px-2 py-3">
            <button
              type="button"
              onClick={signOut}
              className="flex w-full items-center gap-3 rounded-md px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent side="left" className="flex w-64 flex-col p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Settings navigation</SheetTitle>
          </SheetHeader>
          <div className="flex items-center gap-4 px-6 py-4">
            <Link
              href="/sessions"
              onClick={() => setMobileSidebarOpen(false)}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
          </div>
          <nav className="flex-1 px-2 py-2">
            <div className="mb-2 px-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Settings
            </div>
            {navItems}
          </nav>
          <div className="border-t border-border px-2 py-3">
            <button
              type="button"
              onClick={signOut}
              className="flex w-full items-center gap-3 rounded-md px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </SheetContent>
      </Sheet>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3 md:hidden">
          <button
            type="button"
            onClick={() => setMobileSidebarOpen(true)}
            className="text-muted-foreground hover:text-foreground"
          >
            <Menu className="h-4 w-4" />
          </button>
          <span className="flex-1 truncate text-sm font-medium">
            {activeItem?.label ?? "Settings"}
          </span>
        </div>
        <div
          className={cn(
            "mx-auto space-y-6 px-3 py-8 md:px-4 md:py-10",
            isExecutorSection ? "max-w-7xl" : "max-w-5xl",
          )}
        >
          {children}
        </div>
      </main>
    </div>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { isAdmin } = useSession();

  return (
    <SettingsLayout pathname={pathname} isAdmin={isAdmin}>
      {children}
    </SettingsLayout>
  );
}

export function SettingsLayoutClient({
  children,
  sessionInfo,
}: {
  children: React.ReactNode;
  sessionInfo: SessionUserInfo;
}) {
  return (
    <SWRConfig value={{ fallback: { "/api/auth/info": sessionInfo } }}>
      <Layout>{children}</Layout>
    </SWRConfig>
  );
}
