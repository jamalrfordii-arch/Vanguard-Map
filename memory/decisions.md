# Decisions — standing choices and their reasons (append-only)

- **2026-06-14 — Full Equasis dossier SHIPPED & confirmed working by Jamal.** Parser rewritten to
  mirror rhinonix/equasis-cli structure (row/col grid + tableLS/tableLSDD tables); fetches 3 tabs
  (ShipInfo, ShipInspection, ShipHistory). Card shows collapsible sections: PARTICULARS, MANAGEMENT
  & OWNERSHIP (every role), INSPECTIONS (per-PSC DETAINED/clear + detention count, auto-opens on a
  detention), SHIP HISTORY (former names/flags). Cache bumped to `equasis-cache-v2.json` (gitignored).
  Verified via fixture test (`/tmp/eqparse_test.mjs`). Pushed from Jamal's terminal (sandbox git unsafe).

- **2026-06-14 — Adopt the Nasr et al. OSINT cycle as VANGUARD1's stated doctrine.** The 5-phase
  cycle (Identification→Collection→Processing→Analysis→Dissemination) is now the lens for placing
  new capabilities. See `doctrine-osint-cycle.md`.
- **2026-06-14 — VANGUARD1 stays passive-OSINT only.** No active probing/scraping-for-attack
  features. Active techniques live only in adversary modeling. Ethics + legal (GDPR) guardrail.
- **2026-06-14 — Equasis dossier resolves IMO from vessel name automatically.** Manual IMO box kept
  only as an optional override. (Per Jamal: "I don't think we should have to enter in that number.")
- **2026-06-14 — Name→IMO matching uses confidence tiers and refuses to guess.** `pickBest` returns
  high (name+flag) / medium (exact name, flag unmappable) / low (flag-only or sole result) / none.
  On `none` (multiple namesakes, no flag agreement) it returns candidate IMOs instead of picking [0].
  AIS flag is ISO alpha-3; Equasis lists country names → `FLAG_NAMES` map bridges them. Card shows a
  ⚠ "verify this is the right ship" badge for anything below a clean name+flag match.
- **Earlier — License is proprietary, All-Rights-Reserved** (changed from MIT).
- **Earlier — Honest AIS vessel classifier.** Civilian taxonomy only (CARGO/TANKER/PASSENGER/…),
  no fabricated military classification.

_Append new decisions at the top with a date._
