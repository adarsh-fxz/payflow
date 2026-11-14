import Link from "next/link";
import { contracts, explorerAddress, isDeployed } from "@/lib/chain/config";
import { LogoMark } from "@/components/brand/logo";

export function SiteFooter() {
  return (
    <footer className="border-t bg-surface">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            <LogoMark className="size-5" /> PayFlow
          </div>
          <p className="mt-2 max-w-[40ch] text-muted-foreground">Payroll without borders. Payments powered by MUSD on Mezo Testnet.</p>
        </div>
        <nav aria-label="Product" className="flex flex-col gap-2 text-muted-foreground">
          <Link href="/app" className="hover:text-foreground">Create an organization</Link>
          <Link href="/payments" className="hover:text-foreground">My payments</Link>
          <Link href="/#safety" className="hover:text-foreground">How the escrow works</Link>
        </nav>
        <div className="flex flex-col gap-2 text-muted-foreground">
          <p className="font-medium text-foreground">Contracts on Mezo Testnet</p>
          <ContractLink label="MUSD token" address={contracts.musd} />
          {isDeployed ? (
            <>
              <ContractLink label="Payroll escrow" address={contracts.escrow} />
              <ContractLink label="Organization registry" address={contracts.registry} />
            </>
          ) : (
            <span>Escrow contract not deployed yet</span>
          )}
          <a href="https://mezo.org" target="_blank" rel="noreferrer" className="hover:text-foreground">About Mezo</a>
        </div>
      </div>
    </footer>
  );
}

function ContractLink({ label, address }: { label: string; address: string }) {
  return (
    <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className="group hover:text-foreground" title={address}>
      {label}
      <span className="ml-2 font-mono text-xs text-muted-foreground group-hover:text-foreground">
        {address.slice(0, 6)}…{address.slice(-4)}
      </span>
    </a>
  );
}
