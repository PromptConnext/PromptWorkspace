# SOC 2 — Policy Scope Principles

Planning guidance for an AI assistant, not legal advice.

Applies when a project must support a SOC 2 Type I/II attestation under the
AICPA Trust Services Criteria (TSC): Security (the mandatory "common
criteria"), plus the optional Availability, Processing Integrity,
Confidentiality, and Privacy categories, selected per the service
commitments the system makes to customers.

## Data Handling & Classification

- Classify data by confidentiality commitment (public, internal,
  confidential, customer-restricted) to scope the Confidentiality
  criterion (if selected) and to drive access-control design (CC6 series).
- Identify which data the organization has committed to customers as
  "Confidential Information" under contract — that commitment, not just
  internal preference, defines the Confidentiality boundary.

## Consent & Lawful Basis

- If the Privacy criterion is in scope, map data collection/use/disclosure
  against the organization's published privacy notice (the Privacy
  criterion tests conformance to *stated* commitments, not a specific law)
  — pair with "GDPR" / "Thai PDPA" for the underlying legal basis.

## Retention & Deletion

- Retention and disposal practices must match what is stated in the
  privacy notice / customer contract (Privacy criterion) and support the
  Confidentiality criterion's "information is disposed of to meet
  objectives" control.
- Document backup retention separately from primary-data retention — a
  common gap auditors probe.

## Cross-Border Transfer

- Where customer data crosses regions (e.g. subprocessors, multi-region
  infra), document the subprocessor list and data-flow map — required
  evidence under both Confidentiality and Privacy criteria when a
  customer's contract restricts data location.

## Security Controls — Trust Services Criteria mapping

- **CC1 Control Environment**: governance, org structure, accountability
  for security.
- **CC2 Communication & Information**: security policies communicated
  internally/externally.
- **CC3 Risk Assessment**: documented risk assessment process, including
  for new features.
- **CC4 Monitoring Activities**: ongoing control monitoring, periodic
  evaluation.
- **CC5 Control Activities**: policies translated into technical/
  procedural controls.
- **CC6 Logical & Physical Access Controls**: authentication,
  authorization, least privilege, physical security.
- **CC7 System Operations**: vulnerability detection, incident response,
  change monitoring.
- **CC8 Change Management**: controlled, reviewed, tested changes to
  production systems.
- **CC9 Risk Mitigation**: vendor/subprocessor risk management, business
  continuity.
- **Availability (A1)**, **Processing Integrity (PI1)**, **Confidentiality
  (C1)**, **Privacy (P1-P8)**: apply only the categories the service
  commitment actually covers.

## Audit, Logging & Breach Notification

- Maintain audit logs covering authentication, authorization changes, and
  data access sufficient for a Type II auditor to sample evidence over the
  review period (commonly 6-12 months).
- Maintain a documented, tested incident response plan (CC7.3-CC7.5);
  customer/breach notification timing follows the underlying legal
  obligation in scope (e.g. GDPR's 72 hours) plus any contractual SLA —
  SOC 2 itself requires the *process* to exist and be followed, not a
  fixed clock.
- Evidence must be retrievable for the full audit period — logging/
  retention configuration should assume Type II evidence sampling, not
  just point-in-time compliance.

## Implications for System Design

- The system MUST enforce role-based least-privilege access control with
  periodic access reviews (CC6).
- The system MUST log authentication, authorization changes, and access
  to confidential data, retained for the audit period.
- The system MUST route all production changes through a reviewed, tested
  change-management process (CC8).
- The system MUST support a documented incident-response workflow with
  defined roles and timelines (CC7).
- The system MUST maintain an up-to-date subprocessor/data-flow map when
  customer data leaves the primary environment.
- The system MUST align retention and disposal behavior with the
  organization's published privacy notice and customer contracts.
