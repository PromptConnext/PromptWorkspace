/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Feature flag for the desktop identity + membership gate (ADR 0015, plan
  // 0006 G3). Off by default for staged rollout; set to "1" / "true" / "on" at
  // build time to enforce the gate. Baked in at build (Vite), so a cohort build
  // can flip it without touching runtime config.
  readonly VITE_MEMBERSHIP_GATE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
