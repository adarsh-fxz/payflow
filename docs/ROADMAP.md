# Roadmap

## Next

1. **Merkle distribution for large runs.** Commit `root`, `total`, token, run id and funding amount in one call.
   Leaves are `keccak256(abi.encode(chainId, escrow, orgId, runId, index, recipient, amount, token))`, with a claimed bitmap.
   The employer cost becomes O(1) per run. Keep on-chain records for small runs.
2. **Gas-sponsored claims.** A relayer submits `claimFor(paymentId, sig)` with an EIP-712 signature from the
   recipient. Funds still go only to the recipient.
3. **Weekly and biweekly runs on-chain.** The schedule engine already supports them. The run model is labelled
   one-time / monthly in the wizard for the MVP.
4. **Telegram notifications.**
5. **Separation of duties.** An org setting that prevents the run creator from approving their own run.

## Later

- Public API + webhooks for platforms (bounty sites, gig platforms)
- Fee option (explicit, shown at funding, off by default)
- Multi-token runs (other Mezo stablecoins once verified on testnet/mainnet)
- Accounting exports (Xero/QuickBooks CSV formats)
- Mainnet deployment after an external audit
