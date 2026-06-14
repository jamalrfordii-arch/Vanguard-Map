# Doctrine — The Maritime OSINT Cycle VANGUARD1 Implements

**Source:** Ahmed Nagi Nasr, Aybars Oruç, Ricardo Lugo, Inga Zaitseva-Pärnaste, Pentti Kujala —
"A Proactive Defense: An Open-Source Intelligence (OSINT) Framework for Maritime Cybersecurity."
*IEEE Access*, Vol. 14 (2026). Open access, CC-BY. https://ieeexplore.ieee.org/document/11432833

**Why this is in the brain:** VANGUARD1 was built feature-by-feature, but this paper states the
*doctrine* the codebase already follows. It is the "why" behind the module map. When deciding
where a new capability belongs, place it by which phase of this cycle it serves.

---

## The five-phase intelligence cycle → VANGUARD1 modules

| Phase | Paper's definition (paraphrased) | VANGUARD1 owns it in |
|-------|----------------------------------|----------------------|
| **1. Identification** | Survey available data streams (AIS, satellite imagery, registries, port/cyber DBs); decide which sources are credible/relevant; build a tailored collection plan. Iterative. | `dataSource.js` (pluggable feeds), `layerManager` (which streams are live) |
| **2. Collection** | Concurrently harvest terrestrial+satellite AIS, vessel registration / flag-state DBs, port-call records, imagery, compliance filings. Breadth + methodical capture. | `aisManager.ingest()`, `flightManager`, `satelliteManager`/`instancedSatManager`, proxy feeds, **Equasis dossier** (`equasis-lookup.js`) |
| **3. Processing** | Clean, normalize, validate. Decode & integrate feeds; remove duplicates; **synchronize timestamps to a common standard**; **flag corrupted/anomalous records such as impossible vessel speeds or locations**. | `invariants.js` (IMPOSSIBLE_SPEED reject, SOG_MISMATCH, TIME_REGRESSION…), `simClock.js` (single time source; dual `lastEventTime` vs `lastSeen`), `aisManager` dedup |
| **4. Analysis** | Correlate AIS track vs port calls vs ownership; reconstruct timelines; establish behavioral baselines; detect deviations (loitering, **spoofed positional data**, AIS blackouts). | `aiCopilot.js` (anomaly detection), `alertsManager`, `watchlist`, `contextCardManager`, dark-vessel marker |
| **5. Dissemination** | Share insights with stakeholders; build awareness of AIS vulnerabilities & exposure; enable proactive defense. | `sitrepManager.js` (SITREP), `feedManager`, `alertsManager`, HUD (`uiController`), archive/replay export |

The mapping is near 1:1. Treat it as the project's spine.

## Specific claims in the paper that VANGUARD1 already validates
- **"Impossible vessel speeds or locations… flagged for review"** → `invariants.js` IMPOSSIBLE_SPEED gate.
- **"Timestamps synchronized to a common standard"** → `simClock` is the single source of sim time;
  managers must use `simClock.now()`, never `Date.now()`.
- **AIS blackouts / "spoofed positional data"** → dark-vessel marker + SOG_MISMATCH invariant.
- **Equasis CLI for bulk owner/manager data** → our `equasis-lookup.js` dossier (owner, ISM manager,
  flag, class, detentions). The paper independently names the same tool we reverse-engineered.

## Hard boundary — passive vs active OSINT (keep VANGUARD1 passive)
The paper separates **passive OSINT** (AIS, public registries, Equasis — legal, GDPR purpose-limited,
data-minimized) from **active OSINT** (probing systems, querying exposed APIs, scraping crew data for
phishing, testing shipboard Wi-Fi creds — higher legal/operational risk, needs authorization).
**VANGUARD1 stays entirely passive.** Active-OSINT techniques belong only in *adversary modeling*
(what a threat actor could do), never as a feature we operationalize. This is an ethics guardrail,
not a nice-to-have.

## Threat-actor taxonomy (for adversary modeling / scenario design)
State-sponsored (strategic/economic/military targets), plus other tiers the paper details. Primary
attack vectors named: network intrusion, satcom compromise, **social engineering**, supply-chain.
Useful when authoring synthetic scenarios in `scenarios/` — model the adversary, defend passively.

## Ideas this paper seeds for future VANGUARD1 work (not yet built)
- A visible "intelligence-cycle" framing in the UI (which phase produced an alert).
- Cross-source correlation view (AIS track ⨝ ownership ⨝ port calls) — the Analysis phase's core move.
- Provenance / source-credibility scoring at Identification (rank feeds by reliability).

_Absorbed & written: 2026-06-14._
