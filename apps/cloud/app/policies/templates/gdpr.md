# GDPR — Policy Scope Principles

Planning guidance for an AI assistant, not legal advice.

Applies when a project processes personal data of individuals in the
EU/EEA, or is offered by a controller/processor established there, under
the General Data Protection Regulation (Regulation (EU) 2016/679).

## Data Handling & Classification

- Classify personal data by GDPR category: ordinary personal data vs.
  "special category" data (Article 9: health, biometric, genetic,
  racial/ethnic origin, religious/political beliefs, sexual orientation) —
  special categories require an Article 9(2) condition on top of a lawful
  basis.
- Maintain a Record of Processing Activities (ROPA, Article 30) mapping
  each processing activity to purpose, category, lawful basis, recipients,
  and retention.
- Apply data minimization and purpose limitation (Article 5) — collect
  only what the stated purpose requires.

## Consent & Lawful Basis

- Identify one of six Article 6 lawful bases per processing activity:
  consent, contract, legal obligation, vital interest, public task, or
  legitimate interest.
- Where consent is the basis, it must be freely given, specific, informed,
  unambiguous, and as easy to withdraw as to give (Article 7).
- Special category data needs an explicit Article 9(2) condition
  (typically explicit consent) in addition to the Article 6 basis.

## Retention & Deletion

- Define a documented retention period per data category, justified by the
  processing purpose; do not retain "just in case."
- Implement the right to erasure ("right to be forgotten," Article 17) and
  right to restriction (Article 18), including propagation to backups and
  processors within a bounded timeframe.
- Support data portability (Article 20) — export in a structured,
  machine-readable format on request.

## Cross-Border Transfer

- Transfers outside the EEA require an adequacy decision, appropriate
  safeguards (Standard Contractual Clauses, Binding Corporate Rules), or a
  narrow Article 49 derogation.
- Document the transfer mechanism per third country / vendor, and
  re-verify it if the vendor's hosting region changes.

## Security Controls

- Implement Article 32 "appropriate technical and organizational
  measures": encryption/pseudonymization, confidentiality/integrity/
  availability/resilience of processing systems, and a tested ability to
  restore availability after an incident.
- Apply privacy by design and by default (Article 25) — default
  configurations must be the most privacy-protective option.
- Data Protection Impact Assessments (DPIA, Article 35) are required for
  high-risk processing (e.g. large-scale special-category processing,
  systematic monitoring).

## Audit, Logging & Breach Notification

- Maintain logs sufficient to demonstrate accountability (Article 5(2)) —
  who accessed or modified personal data, and when.
- A personal data breach must be notified to the supervisory authority
  within 72 hours of becoming aware of it (Article 33), unless unlikely to
  result in risk to individuals; high-risk breaches also require notifying
  affected data subjects (Article 34) without undue delay.
- Maintain an incident response runbook with named roles for breach
  assessment, DPA notification, and subject notification.

## Implications for System Design

- The system MUST record, per data field, its GDPR category, Article 6
  lawful basis, and retention period.
- The system MUST support consent capture, granular withdrawal, and an
  auditable consent history where consent is the basis.
- The system MUST implement erasure and restriction workflows reaching
  primary storage, backups, and processors within a bounded window.
- The system MUST support structured data export for portability requests.
- The system MUST gate any transfer outside the EEA behind a documented
  Article 44-49 mechanism.
- The system MUST default new features/configurations to the most
  privacy-protective settings (privacy by default).
- The system MUST maintain access/audit logs sufficient to demonstrate
  accountability on request.
- The system MUST support a breach-detection-to-notification path capable
  of meeting the 72-hour DPA window.
