# Privacy

**PayFlow is not confidential payroll.** Anything on Mezo is public.

## What is public (on-chain)

- Organization id, owner wallet, member wallets and their role bits
- A hash of the organization profile (not the profile itself)
- For each run: run id, a hash of the internal run id (`runRef`), totals, status, timestamps, funder wallet
- For each payment: **recipient wallet and amount**, claim status and time

Anyone can see that wallet X received Y MUSD from run Z of organization N. Organizations must tell their
recipients this before paying them through PayFlow. The app says it on the landing page and in the payroll wizard.

## What stays off-chain (PayFlow database)

Names, emails, departments, employee/contributor ids, payment descriptions, organization name/logo/description,
schedules, notifications and the audit log.

- Only members of the organization (verified wallet sessions) can read its recipients, runs and reports.
- The public claim page shows the organization name, run name and amount, which are already derivable on-chain.
  The payment **description** is returned only when the signed-in wallet is the recipient.
- Manifests stored for audit contain index, wallet and amount only.
- Emails are contact details only. Logging in with an email never grants access to a payment.

## Data minimization

- Only the fields the CSV template asks for are stored, plus optional email for notifications.
- Exports neutralize spreadsheet formulas.
- Deleting a recipient marks them inactive so past payment history stays consistent. A hard delete is a database
  operation an operator can run on request.
