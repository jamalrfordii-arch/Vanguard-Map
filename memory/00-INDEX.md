# VANGUARD1 — Memory Index ("the brain")

This folder is persistent memory. At the **start** of a session, read this index, then the
files it points to. At the **end** of a session, write what changed back here so the next
session doesn't re-derive it. `CLAUDE.md` (repo root) stays the canonical *architecture* doc;
this folder holds *doctrine, decisions, scar tissue, and working relationship*.

## Read order
1. `doctrine-osint-cycle.md` — WHY the modules exist. The 5-phase maritime OSINT cycle
   (Nasr et al., IEEE Access 2026) that VANGUARD1 implements module-for-module.
2. `decisions.md` — standing choices we've made and the reasons (append-only log).
3. `scar-tissue.md` — hard-won gotchas that cost real time. Read before debugging.
4. `working-with-jamal.md` — preferences, cadence, how we collaborate.
5. `performance-load.md` — the load-time-vs-capability gap and the fix surface (open work).

## Maintenance
- Keep entries short and dated. Prune duplicates. If a fact goes stale, fix it in place.
- New durable lesson → add to the right file AND note it here if it changes the read order.

_Last updated: 2026-06-14_
