# Scar Tissue — gotchas that cost real time. Read before debugging.

- **Mount-sync lag (sandbox bash).** The Linux bash mount frequently serves a stale/truncated
  copy of files just written via Edit/Write → false `node --check` "Unexpected end of input"
  syntax errors (e.g. equasis-lookup.js showed 139 lines in bash vs 207 real). The Read/Edit/Write
  tools read the REAL disk and are the source of truth. Don't trust bash file reads right after a write.

- **⚠ DO NOT `git commit`/`push` from the sandbox after editing.** Git in bash reads the working
  tree from the SAME stale mount, so it will commit truncated/old file contents (observed:
  `git diff --numstat` showed NO change for equasis-lookup.js despite a full rewrite, because the
  mount served a 129-line stale copy). Pushing from here can publish broken code. Verify logic with
  inline `/tmp` tests, but do the actual `git add/commit/push` from Jamal's real terminal where the
  file tools' writes are intact. Safe push: `git add -A && git commit -m "..." && git push`.

- **Background-tab pause.** Chrome freezes `requestAnimationFrame` in non-foreground tabs. Any
  verification that depends on the render loop fails silently in automation. Check
  `document.visibilityState === 'visible'` first.

- **Service worker is network-first.** New ES modules require a hard refresh to load; otherwise the
  old cached module runs and edits appear to "do nothing."

- **Bloom threshold is a hairpin.** `bloomPass.threshold = 0.95`. Lowering below ~0.90, or adding an
  emissive material with emissiveIntensity > 1.0, makes the whole scene bloom white. Only
  `bloomPass.strength` is written by the animation loop; everything else is set once in sceneSetup.js.

- **Never hardcode light intensities.** `ambientLight`/`dirLight` are recomputed every frame from
  solar elevation. New lights must stay < 0.5 intensity or they wash out the continent mesh.

- **Mercator, not linear.** Vessel/flight coords use `lonLatToScene()` (Mercator). Terrain workers use
  linear XZ — the high-latitude mismatch is intentional. Don't "fix" it.

- **simClock, not wall clock.** Anything time-of-world must call `simClock.now()`/`.date()`, never
  `Date.now()`/`new Date()`. Live mode = wall clock by default but supports pause/scrub/rate.

- **Node require cache.** `flight-proxy.js` caches `require('./equasis-lookup.js')`. Editing the
  lookup module does nothing until the proxy process is restarted.

- **Equasis endpoints (no API — web session scrape).** Login: GET `/EquasisWeb/public/HomePage` →
  POST `/EquasisWeb/authen/HomePage` (follow 302 with cookies). Ship data is a **GET**:
  `/EquasisWeb/restricted/ShipInfo?fs=ShipInfo&P_IMO=<imo>` (and `ShipInspection` for detentions).
  Name→IMO is a **POST** to `/EquasisWeb/restricted/Search?fs=Search` with
  `P_ENTREE_ENTETE`/`P_ENTREE_ENTETE_HIDDEN=<name>`. Credentials live server-side in `.env` only
  (gitignored) — never sent to the browser, never committed.

_Last updated: 2026-06-14._
