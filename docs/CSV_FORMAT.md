# CSV format

Download templates from the wizard or `GET /api/csv/template?kind=payroll|recipients`.

## Payroll CSV

```csv
name,email,wallet_address,amount,description,department
Alice,alice@example.com,0x1111111111111111111111111111111111111111,500,January Salary,Engineering
```

| Column | Required | Rules |
|---|---|---|
| `name` | yes | plain text, no control characters |
| `wallet_address` | yes | 0x + 40 hex; normalized to checksum; zero address rejected |
| `amount` | yes | MUSD, > 0, at most 18 decimals, ≤ 1,000,000 per row by default |
| `email` | no | valid format if present |
| `description` | no | stays off-chain |
| `department` | no | stays off-chain |

Unknown columns produce a warning.

## Recipient CSV

`name,email,wallet_address,department,external_id,payment_category,payment_frequency`. Only name and wallet are required.
Category is one of salary, contractor, bounty, reward, grant, custom. Frequency is one of one_time, weekly, biweekly, monthly.
Import is all-or-nothing: if any row is invalid, nothing is imported and the full report is returned.

## Validation report

Every row is listed with its issues. **Rows are never dropped silently.** The summary shows the total rows, valid rows,
duplicate wallets, invalid wallets, payable recipients, total payable MUSD and, when a balance is supplied, whether the
employer's MUSD balance covers the total. The wizard lets you fix rows inline, or explicitly exclude them, before continuing.

| Code | Meaning |
|---|---|
| `missing_column`, `unknown_column` | header problems |
| `empty_value` | required cell empty |
| `invalid_wallet` | not a valid address |
| `invalid_amount`, `non_positive_amount`, `too_many_decimals`, `amount_too_large` | amount problems |
| `invalid_email` | bad email |
| `duplicate_wallet` | the same wallet appears again (every later occurrence is flagged, with the row number of the first) |
| `duplicate_row` | an identical row |
| `unsupported_characters` | control characters |
| `too_many_rows` (> 5,000), `file_too_large` (> 1 MB), `not_csv` (binary / NUL bytes) | file problems |

## Security

- Content is checked, not the file extension. Nothing uploaded is ever executed.
- The same validator runs in the browser for instant feedback and again on the server before anything is saved.
- Exports neutralize spreadsheet formulas: cells starting with `= + - @`, tab or CR get a leading `'`.
