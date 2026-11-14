"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { explorerAddress, explorerTx } from "@/lib/chain/config";
import { shortAddress, shortHash } from "@/lib/client/format";
import { cn } from "@/lib/client/utils";
import { checksum } from "@/lib/client/run-gates";

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
      className={cn("inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", className)}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function Address({ value: raw, full = false, link = true, copy = true, className }: { value: string; full?: boolean; link?: boolean; copy?: boolean; className?: string }) {
  // Wallets are stored lowercase; show them EIP-55 checksummed so people can compare them by eye.
  const value = checksum(raw);
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {link ? (
        <a href={explorerAddress(value)} target="_blank" rel="noreferrer" className="font-mono text-[0.8125rem] hover:underline" title={value}>
          {full ? value : shortAddress(value)}
        </a>
      ) : (
        <span className="font-mono text-[0.8125rem]" title={value}>
          {full ? value : shortAddress(value)}
        </span>
      )}
      {copy ? <CopyButton value={value} label="Copy address" /> : null}
    </span>
  );
}

export function TxLink({ hash, className, label }: { hash: string; className?: string; label?: string }) {
  return (
    <a
      href={explorerTx(hash)}
      target="_blank"
      rel="noreferrer"
      className={cn("inline-flex items-center gap-1 font-mono text-[0.8125rem] text-brand-ink hover:underline", className)}
      title={hash}
    >
      {label ?? shortHash(hash)}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}
