# Thai PDPA — Policy Scope Principles

Planning guidance for an AI assistant, not legal advice.

Applies when a project collects, stores, or processes personal data of
individuals in Thailand, or is operated by a data controller/processor based
in Thailand, under the Personal Data Protection Act B.E. 2562 (2019) ("Thai
PDPA").

## Data Handling & Classification

- Classify data into ordinary personal data and "sensitive data" (Section
  26): health, race, religion, sexual behavior, criminal record, biometric
  data, and similar categories requiring explicit consent and stricter
  safeguards.
- Maintain a data inventory mapping each personal data field to its
  collection purpose, legal basis, and retention period.
- Minimize collection to what the stated purpose strictly requires.

## Consent & Lawful Basis

- Default lawful basis is informed, freely given, specific consent (Section
  19), collected separately from other terms and revocable at any time.
- Support non-consent legal bases where applicable — contractual necessity,
  legal obligation, vital interest, public task, or legitimate interest —
  each documented and justified per processing activity.
- Sensitive data (Section 26) requires explicit, opt-in consent; implied or
  bundled consent is not sufficient.

## Retention & Deletion

- Define and document a retention period for every data category, tied to
  its collection purpose.
- Implement deletion or anonymization triggered when the retention period
  lapses or consent is withdrawn (right to erasure, Section 33).
- Deletion must cover backups and derived/cached copies within a bounded,
  documented timeframe.

## Cross-Border Transfer

- Transfers of personal data outside Thailand require the receiving
  country/organization to have adequate data protection standards, or rely
  on an approved transfer mechanism (binding corporate rules, standard
  contractual clauses, or explicit consent — Section 28).
- Document the legal basis for every cross-border data flow (e.g. a foreign
  cloud region, a third-party SaaS vendor).

## Security Controls

- Apply technical and organizational measures appropriate to risk:
  encryption at rest and in transit, access control by least privilege, and
  network segmentation.
- Log and restrict access to personal data to named roles with a documented
  need.
- Vendor/sub-processor contracts must impose equivalent protection
  obligations (Section 40).

## Audit, Logging & Breach Notification

- Maintain audit logs of access to and modification of personal data,
  retained long enough to support an investigation.
- A personal data breach with material risk to data subjects must be
  notified to the Personal Data Protection Committee (PDPC) without delay
  and, where feasible, within 72 hours of becoming aware of it; affected
  data subjects must be notified without undue delay when the breach is
  likely to result in high risk.
- Maintain an incident response runbook naming who assesses, escalates, and
  files the notification.

## Implications for System Design

- The system MUST record, per data field, its classification, lawful basis,
  and retention period at design time.
- The system MUST support per-record consent capture, withdrawal, and an
  auditable consent history.
- The system MUST implement a deletion/anonymization workflow reachable
  within the documented retention window.
- The system MUST gate any cross-border data flow behind a documented
  transfer mechanism, not an implicit default.
- The system MUST encrypt personal data at rest and in transit, and restrict
  access by role.
- The system MUST emit access/audit logs for personal data reads and
  writes.
- The system MUST support a breach-detection-to-notification path capable
  of meeting the 72-hour PDPC window.
