"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Categories of the Settings area. Mirrors the Functions sub-sidebar pattern:
// the main sidebar's "Settings" entry lands here, and this secondary nav splits
// the page into API / Database / Logs. All of /admin/settings is admin-gated by
// middleware, so there's no per-item role filtering.
const ITEMS = [
  { href: "/admin/settings/api", label: "API" },
  { href: "/admin/settings/database", label: "Database" },
  { href: "/admin/settings/logs", label: "Logs" },
];

export function SettingsSubSidebar() {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
      <div className="border-b border-neutral-800 px-3 py-3">
        <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Settings
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`block rounded px-2 py-1.5 text-sm ${
              isActive(item.href)
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
