"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function SettingsNav({
  items,
}: {
  items: { href: string; label: string }[];
}) {
  const pathname = usePathname();
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "block rounded-md bg-background px-3 py-2 text-sm font-medium"
                  : "block rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-background hover:text-foreground"
              }
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
