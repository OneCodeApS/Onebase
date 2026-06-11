"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { logout } from "../logout/actions";
import type { UserRole } from "@/lib/session";
import { version as APP_VERSION } from "@/package.json";

type NavLink = {
  href: string;
  label: string;
  // Match this path as the active route start (e.g. "/tables" matches "/tables/todos").
  match?: string;
  adminOnly?: boolean;
};

// A collapsible parent that reveals a secondary list when clicked.
type NavCollapsible = {
  label: string;
  adminOnly?: boolean;
  items: NavLink[];
};

type NavEntry = NavLink | NavCollapsible;

function isCollapsible(e: NavEntry): e is NavCollapsible {
  return "items" in e;
}

type NavGroup = {
  heading: string;
  items: NavEntry[];
};

const GROUPS: NavGroup[] = [
  {
    heading: "Database",
    items: [
      { href: "/tables", label: "Tables", match: "/tables" },
      { href: "/sql", label: "SQL Editor", match: "/sql" },
      {
        label: "Schema",
        items: [
          { href: "/admin/policies", label: "RLS policies", match: "/admin/policies" },
          { href: "/admin/db-functions", label: "DB functions", match: "/admin/db-functions" },
          { href: "/admin/grants", label: "Grants", match: "/admin/grants" },
          { href: "/admin/realtime", label: "Realtime", match: "/admin/realtime", adminOnly: true },
          { href: "/admin/enums", label: "Enums", match: "/admin/enums" },
        ],
      },
    ],
  },
  {
    heading: "Functions",
    items: [
      { href: "/admin/functions", label: "Edge functions", match: "/admin/functions" },
      { href: "/admin/cron", label: "Cron jobs", match: "/admin/cron" },
    ],
  },
  {
    heading: "Storage",
    items: [{ href: "/storage", label: "Buckets", match: "/storage" }],
  },
  {
    heading: "Authentication",
    items: [
      { href: "/admin/auth-providers", label: "Auth providers", match: "/admin/auth-providers", adminOnly: true },
      { href: "/admin/cors", label: "CORS origins", match: "/admin/cors", adminOnly: true },
      { href: "/admin/api-keys", label: "API keys", match: "/admin/api-keys", adminOnly: true },
      { href: "/admin/access-tokens", label: "Access tokens (MCP)", match: "/admin/access-tokens", adminOnly: true },
      { href: "/admin/rate-limits", label: "Rate limits", match: "/admin/rate-limits", adminOnly: true },
      { href: "/admin/end-users", label: "End users", match: "/admin/end-users", adminOnly: true },
      { href: "/admin/users", label: "Dashboard users", match: "/admin/users", adminOnly: true },
    ],
  },
  {
    heading: "Settings",
    items: [
      { href: "/admin/audit", label: "Audit log", match: "/admin/audit", adminOnly: true },
      { href: "/admin/settings", label: "Audit settings", match: "/admin/settings", adminOnly: true },
      { href: "/admin/system", label: "Versions", match: "/admin/system", adminOnly: true },
    ],
  },
];

function NavLinkRow({ item, active }: { item: NavLink; active: boolean }) {
  return (
    <Link
      href={item.href}
      className={`block rounded px-2 py-1.5 text-sm ${
        active
          ? "bg-neutral-800 text-neutral-100"
          : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
      }`}
    >
      {item.label}
    </Link>
  );
}

function CollapsibleNav({
  label,
  items,
  isActive,
}: {
  label: string;
  items: NavLink[];
  isActive: (i: NavLink) => boolean;
}) {
  const anyActive = items.some(isActive);
  const [open, setOpen] = useState(anyActive);
  // Auto-open when navigating to one of its children (e.g. via a deep link).
  useEffect(() => {
    if (anyActive) setOpen(true);
  }, [anyActive]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm ${
          anyActive
            ? "text-neutral-200"
            : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
        }`}
      >
        <span>{label}</span>
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M6 3.5 L11 8 L6 12.5 Z" />
        </svg>
      </button>
      {open && (
        <div className="ml-3 mt-0.5 space-y-0.5 border-l border-neutral-800 pl-2">
          {items.map((item) => (
            <NavLinkRow key={item.href} item={item} active={isActive(item)} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar({ email, role }: { email: string; role: UserRole }) {
  const pathname = usePathname();
  const isAdmin = role === "admin";

  function isActive(item: NavLink): boolean {
    const m = item.match ?? item.href;
    return pathname === m || pathname.startsWith(m + "/");
  }

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
      <div className="flex items-baseline gap-2 border-b border-neutral-800 px-4 py-4">
        <Link href="/" className="text-sm font-semibold text-neutral-100 hover:text-white">
          Onebase
        </Link>
        <span className="font-mono text-[10px] text-neutral-500">v{APP_VERSION}</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-4">
        <Link
          href="/"
          className={`block rounded px-2 py-1.5 text-sm ${
            pathname === "/"
              ? "bg-neutral-800 text-neutral-100"
              : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
          }`}
        >
          Home
        </Link>

        {GROUPS.map((group) => {
          // Filter to entries the current role may see. A collapsible is shown
          // only if it has at least one visible child.
          const visible = group.items.filter((e) => {
            if (isCollapsible(e)) {
              if (e.adminOnly && !isAdmin) return false;
              return e.items.some((c) => !c.adminOnly || isAdmin);
            }
            return !e.adminOnly || isAdmin;
          });
          if (visible.length === 0) return null;
          return (
            <div key={group.heading} className="mt-5">
              <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
                {group.heading}
              </div>
              {visible.map((entry) =>
                isCollapsible(entry) ? (
                  <CollapsibleNav
                    key={entry.label}
                    label={entry.label}
                    items={entry.items.filter((c) => !c.adminOnly || isAdmin)}
                    isActive={isActive}
                  />
                ) : (
                  <NavLinkRow key={entry.href} item={entry} active={isActive(entry)} />
                ),
              )}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-neutral-800 px-4 py-3 text-xs">
        <div className="truncate font-mono text-neutral-200" title={email}>
          {email}
        </div>
        <div className="mt-0.5 text-neutral-500">{role}</div>
        <form action={logout} className="mt-2">
          <button
            type="submit"
            className="w-full rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
