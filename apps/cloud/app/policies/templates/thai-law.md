# Thai Law (General) — Policy Scope Principles

Planning guidance for an AI assistant, not legal advice.

Applies to projects operating in Thailand or serving Thai users where
obligations beyond the PDPA are in scope: the Electronic Transactions Act
B.E. 2544, the Computer-Related Crime Act B.E. 2550 (as amended), consumer
protection law, and sector-specific regulation (e.g. financial services
under the Bank of Thailand, or e-commerce registration). Select this
alongside "Thai PDPA" when personal data is also involved — this template
does not duplicate PDPA-specific rules.

## Data Handling & Classification

- Distinguish regulated record types the business must retain for
  legal/tax purposes (transaction records, e-signatures, accounting
  documents) from data governed purely by internal policy.
- Classify system logs and traffic data subject to the Computer-Related
  Crime Act's retention duty separately from personal data.

## Consent & Lawful Basis

- Electronic transactions and e-signatures must meet the Electronic
  Transactions Act's reliability requirements (identifiable signatory,
  integrity of the signed record) to be enforceable.
- Terms of service and consumer-facing agreements must be presented in a
  way that satisfies Thai consumer protection disclosure requirements
  (clear pricing, cancellation terms, dispute contact).

## Retention & Deletion

- Traffic/log data covered by the Computer-Related Crime Act must be
  retained for at least 90 days (longer on official request), distinct
  from — and not overridden by — any shorter PDPA-driven deletion schedule
  for personal data.
- Financial/accounting records generally carry a multi-year statutory
  retention period under Thai tax and accounting law; confirm the
  applicable duration before implementing auto-deletion.

## Cross-Border Transfer

- Sector-specific rules (e.g. financial data, gambling-adjacent products)
  may restrict hosting or processing outside Thailand independent of
  PDPA's transfer regime — verify against the applicable regulator before
  choosing an infrastructure region.

## Security Controls

- Systems handling regulated transactions should support tamper-evident
  audit trails sufficient to prove transaction integrity under the
  Electronic Transactions Act.
- Apply access controls and monitoring proportionate to the
  Computer-Related Crime Act's unauthorized-access provisions — the system
  itself must not become a vector for an offense committed through it.

## Audit, Logging & Breach Notification

- Retain traffic data logs (source, destination, timestamp, volume — not
  necessarily content) for the statutory minimum window, in a form
  producible to authorities on lawful request.
- Where a breach also constitutes a personal data breach, follow the PDPA
  notification track (see the "Thai PDPA" template); this template covers
  the general regulatory logging duty, not personal-data-specific
  notification.

## Implications for System Design

- The system MUST retain traffic/log data for the statutory minimum period
  independent of any personal-data deletion schedule.
- The system MUST produce tamper-evident audit trails for regulated
  transactions (e-signatures, payments, contracts).
- The system MUST retain financial/accounting records for their statutory
  duration before any deletion is permitted.
- The system MUST present consumer-facing terms (pricing, cancellation,
  dispute contact) in a compliant, accessible format.
- The system MUST restrict and log administrative access in a way that
  supports an unauthorized-access investigation.
