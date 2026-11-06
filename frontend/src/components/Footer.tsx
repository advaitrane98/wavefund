import Link from "next/link";
import { deployedContracts } from "@/config/contracts";
import { explorerAddressUrl } from "@/lib/chain";
import { Eyebrow } from "./ui";

export function Footer() {
  return (
    <footer className="mt-24 border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <Eyebrow>Contracts · verified on Arc Explorer</Eyebrow>
        {deployedContracts.length > 0 ? (
          <ul className="mt-5 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {deployedContracts.map((c) => (
              <li
                key={c.name}
                className="flex items-baseline justify-between gap-4 border-b border-border pb-3"
              >
                <span className="text-sm text-muted">{c.name}</span>
                <a
                  href={explorerAddressUrl(c.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="num truncate text-sm text-green hover:underline"
                >
                  {c.address}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-5 max-w-xl text-sm text-muted">
            No deployed contracts are listed yet. Addresses appear here once they are added
            to <span className="num">contracts/deployments/current.json</span> and synced.
          </p>
        )}

        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 text-sm text-faint">
          <span className="font-display text-lg text-text">
            wave<span className="text-green">fund</span>
          </span>
          <div className="flex gap-5">
            <Link href="/demo" className="hover:text-text">
              Demo
            </Link>
            <Link href="/demo/how-it-works" className="hover:text-text">
              How it works
            </Link>
          </div>
          <span>Runs on Arc testnet. Testnet USDC has no value.</span>
        </div>
      </div>
    </footer>
  );
}
