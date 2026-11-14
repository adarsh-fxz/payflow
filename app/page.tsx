import Link from "next/link";
import { ArrowRight, ArrowDown } from "lucide-react";
import { contracts, explorerAddress, isDeployed } from "@/lib/chain/config";
import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";
import { PaymentLookup } from "@/components/landing/payment-lookup";
import { Reveal } from "@/components/landing/reveal";
import { HeroRise } from "@/components/landing/hero-motion";
import { Button } from "@/components/ui/button";

const EMPLOYER_STEPS = [
  {
    title: "Create your organization",
    body: "Register it on Mezo with your wallet. Add teammates as operators, approvers or admins.",
  },
  {
    title: "Build a run",
    body: "Upload a CSV or pick saved recipients. PayFlow checks every wallet and amount before anything goes on-chain.",
  },
  {
    title: "Approve and fund",
    body: "An approver confirms the exact list recorded on-chain. An admin then moves the total MUSD into escrow.",
  },
  {
    title: "Publish and track",
    body: "Each recipient gets a claim link. You see who has claimed, and can refund what is left once the claim window closes.",
  },
];

const RECIPIENT_STEPS = [
  { title: "Open your claim link", body: "It shows who paid you, how much, and whether it is ready." },
  { title: "Connect your wallet", body: "Use the wallet the payment was sent to. No account or email needed." },
  { title: "Claim", body: "MUSD moves from the escrow straight to your wallet. You pay a small network fee in BTC." },
];

const USE_CASES = [
  { term: "Salaries", body: "Monthly payroll for a remote team, from one CSV or a saved schedule." },
  { term: "Contractors", body: "Pay invoices in batches without sending one transfer per person." },
  { term: "Bounties", body: "Pay out a finished bounty round to every winner at once." },
  { term: "Rewards", body: "Community and contributor rewards with a clear record of who claimed." },
  { term: "Grants", body: "Grant tranches that recipients collect when they are ready." },
];

const GUARANTEES = [
  {
    title: "Each run has its own ledger",
    body: "All runs share one escrow contract, but each run tracks its own funded, claimed and refunded totals. One run can never spend another run's MUSD.",
  },
  {
    title: "Only the named wallet can claim",
    body: "The contract checks the caller. Sharing or editing a claim link does not let anyone else take the payment.",
  },
  {
    title: "Approvers sign what they saw",
    body: "An approval includes a fingerprint of the exact payment list on-chain. If anything changed after review, the approval fails.",
  },
  {
    title: "Owed money stays owed",
    body: "After publishing, payments stay claimable until the window ends. Only then can unclaimed MUSD be refunded, and only to the wallet that funded it.",
  },
];

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="flex-1">
        {/* Hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pt-14 pb-16 sm:px-6 md:pt-20 md:pb-24 lg:grid-cols-[1.15fr_1fr] lg:gap-14">
          <HeroRise>
            <h1 className="max-w-[20ch] text-[2.25rem] leading-[1.08] font-semibold tracking-[-0.025em] sm:text-5xl lg:text-[3.25rem]">
              Run payroll, distribute bounties, and pay contributors globally using MUSD.
            </h1>
            <p className="mt-5 max-w-[48ch] text-lg text-muted-foreground">
              Upload a CSV, get it approved, fund one escrow. Each person claims their own payment with their wallet.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button asChild size="lg">
                <Link href="/app">
                  Create an organization <ArrowRight data-icon="inline-end" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="ghost" className="lg:hidden">
                <a href="#lookup">
                  View a payment <ArrowDown data-icon="inline-end" />
                </a>
              </Button>
            </div>
          </HeroRise>
          <HeroRise delay={0.08}>
            <PaymentLookup id="lookup" />
            <p className="mt-3 px-1 text-[0.8125rem] text-muted-foreground">
              Already paid through PayFlow?{" "}
              <Link href="/payments" className="font-medium text-foreground underline-offset-4 hover:underline">
                See all your payments
              </Link>
            </p>
          </HeroRise>
        </section>

        {/* How it works */}
        <section id="how" className="scroll-mt-16 border-t bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-24">
            <Reveal>
              <h2 className="max-w-[24ch] text-3xl font-semibold tracking-[-0.02em]">How a payroll run works</h2>
              <p className="mt-3 max-w-[60ch] text-muted-foreground">
                Your team prepares and approves the run. The escrow holds the money. Recipients collect it themselves.
              </p>
            </Reveal>
            <div className="mt-12 grid gap-12 lg:grid-cols-[1.35fr_1fr] lg:gap-16">
              <Reveal>
                <h3 className="text-sm font-semibold">If you pay people</h3>
                <ol className="mt-5 space-y-6">
                  {EMPLOYER_STEPS.map((s, i) => (
                    <li key={s.title} className="grid grid-cols-[2rem_1fr] gap-3">
                      <span className="num flex size-7 items-center justify-center rounded-full border bg-background text-[0.8125rem] font-medium">{i + 1}</span>
                      <div>
                        <p className="font-medium">{s.title}</p>
                        <p className="mt-1 max-w-[56ch] text-sm text-muted-foreground">{s.body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Reveal>
              <Reveal delay={0.06} className="lg:border-l lg:pl-12">
                <h3 className="text-sm font-semibold">If you get paid</h3>
                <ol className="mt-5 space-y-6">
                  {RECIPIENT_STEPS.map((s, i) => (
                    <li key={s.title} className="grid grid-cols-[2rem_1fr] gap-3">
                      <span className="num flex size-7 items-center justify-center rounded-full bg-brand text-[0.8125rem] font-semibold text-[oklch(0.2_0.01_60)]">{i + 1}</span>
                      <div>
                        <p className="font-medium">{s.title}</p>
                        <p className="mt-1 max-w-[44ch] text-sm text-muted-foreground">{s.body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Reveal>
            </div>
          </div>
        </section>

        {/* Use cases */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-24">
          <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr] lg:gap-16">
            <Reveal>
              <h2 className="max-w-[16ch] text-3xl font-semibold tracking-[-0.02em]">One flow for every kind of payout</h2>
              <p className="mt-3 max-w-[44ch] text-muted-foreground">
                Pick a payment type when you start a run. The steps, checks and records are the same.
              </p>
            </Reveal>
            <Reveal delay={0.05}>
              <dl className="divide-y border-y">
                {USE_CASES.map((u) => (
                  <div key={u.term} className="grid gap-1 py-4 sm:grid-cols-[10rem_1fr] sm:gap-6">
                    <dt className="font-medium">{u.term}</dt>
                    <dd className="text-muted-foreground">{u.body}</dd>
                  </div>
                ))}
              </dl>
            </Reveal>
          </div>
        </section>

        {/* Mezo + MUSD */}
        <section className="border-y bg-surface">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 md:py-20 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <h2 className="text-3xl font-semibold tracking-[-0.02em]">Built on Mezo. Paid in MUSD.</h2>
              <p className="mt-4 max-w-[52ch] text-muted-foreground">
                MUSD is a dollar stablecoin on Mezo, backed by bitcoin. PayFlow holds each run&apos;s MUSD in an escrow contract on Mezo, and network fees are paid in BTC.
              </p>
              <p className="mt-4 max-w-[52ch] text-muted-foreground">
                PayFlow currently runs on Mezo Testnet, where MUSD has no real-world value. Use it to try the full flow end to end.
              </p>
            </Reveal>
            <Reveal delay={0.05}>
              <dl className="divide-y rounded-lg border bg-background text-sm">
                {[
                  { label: "MUSD token", addr: contracts.musd, live: true },
                  { label: "PayFlow escrow", addr: contracts.escrow, live: isDeployed },
                  { label: "Organization registry", addr: contracts.registry, live: isDeployed },
                ].map((c) => (
                  <div key={c.label} className="flex flex-col gap-1 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                    <dt className="text-muted-foreground">{c.label}</dt>
                    <dd className="font-mono text-[0.8125rem]">
                      {c.live ? (
                        <a href={explorerAddress(c.addr)} target="_blank" rel="noreferrer" className="break-all underline-offset-4 hover:underline">
                          {c.addr}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">Not deployed yet</span>
                      )}
                    </dd>
                  </div>
                ))}
                <div className="flex flex-col gap-1 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                  <dt className="text-muted-foreground">Network</dt>
                  <dd>Mezo Testnet, chain 31611</dd>
                </div>
              </dl>
            </Reveal>
          </div>
        </section>

        {/* Safety */}
        <section id="safety" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-16 sm:px-6 md:py-24">
          <Reveal>
            <h2 className="max-w-[26ch] text-3xl font-semibold tracking-[-0.02em]">What the escrow protects, and what it doesn&apos;t</h2>
          </Reveal>
          <div className="mt-10 grid gap-12 lg:grid-cols-[1.5fr_1fr] lg:gap-16">
            <Reveal>
              <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
                {GUARANTEES.map((g) => (
                  <li key={g.title}>
                    <p className="font-medium">{g.title}</p>
                    <p className="mt-1.5 text-sm text-muted-foreground">{g.body}</p>
                  </li>
                ))}
              </ul>
            </Reveal>
            <Reveal delay={0.06}>
              <div className="rounded-lg border border-warn/50 bg-warn/[0.06] p-5">
                <p className="font-medium">This is not private payroll</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Amounts and wallet addresses are public on Mezo. Anyone can look up the escrow and see which wallet was paid how much.
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Names, emails and payment notes stay in PayFlow&apos;s database and are never written on-chain. If amounts must stay confidential, don&apos;t use PayFlow for them.
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* Closing CTA */}
        <section className="border-t bg-surface">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-5 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-[-0.02em]">Set up your first run in a few minutes.</h2>
              <p className="mt-1 text-muted-foreground">You need a wallet on Mezo Testnet with a little BTC for fees.</p>
            </div>
            <Button asChild size="lg">
              <Link href="/app">
                Create an organization <ArrowRight data-icon="inline-end" />
              </Link>
            </Button>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
