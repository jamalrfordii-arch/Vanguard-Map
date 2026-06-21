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

## Charter — what may enter the brain (read before writing here)

Prevention beats cleanup. A small, accurate brain is the goal; a bloated or stale one misleads.
The bar to get *in* is high on purpose.

**Admit:** durable decisions (with the reason), hard-won gotchas / scar tissue, doctrine, and stable
preferences — facts that will still be true and useful next session.

**Reject:** transient state ("currently debugging X"), anything cheaply re-derivable from the code,
speculative ideas not yet decided, and duplicates of something already recorded.

**Rules of hygiene:**
1. Every entry is dated.
2. One fact lives in ONE place.
3. On contradiction, **fix the existing entry in place — never append a rival version.**
   (The usual rot isn't wrong facts; it's the same fact drifting into three versions.)
4. Keep each file scannable. If a file stops being read at session start, it's failed — cut it.
5. New durable lesson → add to the right file; update this index only if the read order changes.

**Pruning:** trigger by condition, not calendar — when a file grows unwieldy or every few sessions,
run a consolidation pass that *proposes* merges for Jamal to glance at. Never delete silently.

_Last updated: 2026-06-20_
