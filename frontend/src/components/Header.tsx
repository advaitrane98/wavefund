"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./ConnectButton";
import { DataModeToggle } from "./DataModeToggle";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/demo/markets", label: "Markets" },
  { href: "/demo/vault", label: "Vault" },
  { href: "/demo/portfolio", label: "Portfolio" },
  { href: "/demo/agents", label: "Agents" },
  { href: "/demo/how-it-works", label: "How it works" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Header() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 sm:px-6">
        <Link
          href="/"
          className="font-display text-2xl tracking-tight text-text"
          aria-label="wavefund home"
        >
          wave<span className="text-green">fund</span>
        </Link>

        <nav
          aria-label="Primary"
          className="order-last -mx-1 flex w-full gap-1 overflow-x-auto lg:order-none lg:mx-0 lg:w-auto"
        >
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-11 items-center whitespace-nowrap rounded-full px-3 text-sm transition-colors ${
                  active
                    ? "bg-surface-2 text-text"
                    : "text-muted hover:text-text"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <span className="eyebrow hidden items-center gap-2 rounded-full border border-border px-3 py-2 xl:inline-flex">
            <span className="pulse-dot size-1.5 rounded-full bg-green" aria-hidden />
            Arc testnet · live
          </span>
          <DataModeToggle />
          <ThemeToggle />
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
