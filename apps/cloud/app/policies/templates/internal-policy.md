# Internal Policy — Policy Scope Principles

Planning guidance for an AI assistant, not legal advice.

This template is a lightweight scaffold, not a regulatory framework. Select
it when the project's compliance requirements are entirely defined by the
organization's own internal policy rather than an external law or standard.
The custom free-text policy scope the user provides alongside this
selection is authoritative — treat it as the primary source of constitution
principles, and use the section prompts below only to check nothing was
left unaddressed.

## Data Handling & Classification

- If the custom text defines data classification tiers, apply them;
  otherwise default to a simple public/internal/confidential split and
  flag the gap for the user to fill in.

## Consent & Lawful Basis

- Apply whatever consent or authorization model the custom text specifies.
  If none is given and the project handles personal data, flag that a
  lawful-basis policy is missing rather than inventing one.

## Retention & Deletion

- Apply the retention windows the custom text specifies. If none are
  given, default to "retain only as long as operationally necessary" and
  note that a concrete duration should be set.

## Cross-Border Transfer

- Apply any data-residency or transfer restriction stated in the custom
  text. If none is given, treat cross-border transfer as unrestricted but
  flag it as an open decision.

## Security Controls

- Apply the specific controls the custom text calls out (e.g. "all admin
  access requires SSO + hardware key"). Where the text is silent, fall
  back to reasonable defaults: least-privilege access, encryption in
  transit and at rest.

## Audit, Logging & Breach Notification

- Apply any logging/audit/incident-notification expectations stated in
  the custom text. Where the text is silent, default to standard access
  logging and a documented (even if informal) incident escalation
  contact.

## Implications for System Design

- The system MUST implement whatever concrete rules the custom text
  states as "MUST" or "must" verbatim — these take precedence over every
  default in this scaffold.
- The system MUST flag, in the generated constitution, any section above
  where the custom text gave no guidance, so the user can fill the gap
  explicitly rather than have the model invent policy.
- The system MUST apply baseline security hygiene (least privilege,
  encryption in transit/at rest, access logging) even when the custom
  text is silent on security.
