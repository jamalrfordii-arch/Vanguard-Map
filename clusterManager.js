// clusterManager.js — Vessel + aircraft clustering with significance encoding.
//
// ── Build Plan 01: Three-variable cluster differentiation ────────────────────
//   Variable 01 — Size         logarithmic scale with vessel count (unchanged)
//   Variable 02 — Color temp   anomaly ratio drives hue from cyan → red
//   Variable 03 — Pulse rate   urgency drives animation cycle speed
//
// Anomaly color tiers (by % of flagged vessels in region):
//   0–10%   Cyan   #00D4FF   Normal ops
//   11–20%  Teal   #40D4AA   Elevated
//   21–30%  Amber  #FF8C00   Watch
//   31–50%  Orange #FF4400   Alert
//   51%+    Red    #FF2244   Critical
//
// Pulse modes:
//   low   (4.0 s cycle) — no recent anomaly, or stale dark (> 6 h)
//   high  (1.2 s cycle) — active anomaly within last 10 min
//   ping  — one sharp flash (0.5 s) when cluster first becomes flagged

import * as THREE from 'three';
import { detectRegion } from './uiController.js';
import { CLUSTER } from './config.js';

// ── Color temperature ─────────────────────────────────────────────────────────
function _getAnomalyColor(ratio) {
    if (ratio > 0.50) return '#FF2244';   // Critical
    if (ratio > 0.30) return '#FF4400';   // Alert
    if (ratio > 0.20) return '#FF8C00';   // Watch
    if (ratio > 0.10) return '#40D4AA';   // Elevated
    return '#00D4FF';                      // Normal
}

// ── Shared cluster shadow texture ─────────────────────────────────────────────
let _clusterShadowTex = null;
function _getClusterShadowTex() {
    if (_clusterShadowTex) return _clusterShadowTex;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx  = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 60);
    grad.addColorStop(0.0, 'rgba(0,0,0,0.50)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.18)');
    grad.addColorStop(1.0, 'rgba(0,0,0,0.00)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(64, 64, 60, 0, Math.PI * 2);
    ctx.fill();
    _clusterShadowTex = new THREE.CanvasTexture(canvas);
    return _clusterShadowTex;
}

// ── Canvas sprite texture ─────────────────────────────────────────────────────
function makeClusterTexture(count, color = '#00D4FF') {
    const size   = 128;
    const canvas = document.createElement('canvas');
    canvas.width  = size;
    canvas.height = size;
    const ctx    = canvas.getContext('2d');

    // Soft radial neon halo — fills the disc, fades to transparent at the rim
    const halo = ctx.createRadialGradient(64, 64, 28, 64, 64, 62);
    halo.addColorStop(0.0, color + 'cc');
    halo.addColorStop(0.5, color + '44');
    halo.addColorStop(1.0, color + '00');
    ctx.beginPath();
    ctx.arc(64, 64, 62, 0, Math.PI * 2);
    ctx.fillStyle = halo;
    ctx.fill();

    // Outer neon ring
    ctx.beginPath();
    ctx.arc(64, 64, 52, 0, Math.PI * 2);
    ctx.strokeStyle = color + 'cc';
    ctx.lineWidth   = 6;
    ctx.stroke();

    // Inner ring
    ctx.beginPath();
    ctx.arc(64, 64, 44, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 3;
    ctx.stroke();

    // Subtle backing so the count stays legible over busy terrain — kept tight
    // and translucent so the bubble no longer reads as a black hole on the map.
    ctx.beginPath();
    ctx.arc(64, 64, 30, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(1, 10, 20, 0.34)';
    ctx.fill();

    // Count number — glow shadow pass then crisp solid pass on top
    const fontSize = count >= 100 ? 28 : 34;
    ctx.font         = `bold ${fontSize}px Courier New`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = color;
    ctx.shadowBlur   = 10;
    ctx.fillStyle    = color;
    ctx.fillText(String(count), 64, 62);
    ctx.shadowBlur   = 0;
    ctx.fillText(String(count), 64, 62);

    return new THREE.CanvasTexture(canvas);
}

// ── Sprite factory ────────────────────────────────────────────────────────────
function makeSprite(scene) {
    const spriteMat = new THREE.SpriteMaterial({
        transparent:     true,
        depthTest:       false,
        sizeAttenuation: true,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(16, 16, 1);
    sprite.renderOrder = 999;
    scene.add(sprite);

    // Ground shadow — size proportional to cluster count, set each tick
    const shadowMat = new THREE.SpriteMaterial({
        map:        _getClusterShadowTex(),
        transparent: true,
        opacity:     0.55,
        depthWrite:  false,
        depthTest:   true,
    });
    const shadow = new THREE.Sprite(shadowMat);
    shadow.renderOrder = -1;
    shadow.visible = false;   // ground shadows disabled — read as black holes on bright terrain
    scene.add(shadow);

    return {
        sprite, spriteMat, shadow,
        lastCount:    -1,
        lastColor:    '',
        pulseMode:    'low',   // 'low' | 'high'
        pingStartMs:  0,       // ms timestamp — 0 = no active ping
        prevFlagged:  false,   // was cluster flagged (ratio > 10%) last tick?
        bloomAt:      0,       // ms timestamp when bloom starts (0 = no bloom)
        fadeOutAt:    0,       // ms timestamp when fade-out starts (0 = no fade)
    };
}

// ── ClusterManager ────────────────────────────────────────────────────────────
export class ClusterManager {
    constructor(scene) {
        this.scene         = scene;
        this._shipsEnabled = true;   // AIS-vessels layer toggle — gates ship clustering only
        this._shipActive   = false;
        this._flightActive = false;
        this._shipClusters   = new Map(); // region → sprite state (far zoom combined)
        this._flightClusters = new Map();
        this._darkClusters   = new Map(); // region → sprite state (mid zoom dark)
        this._activeClusters = new Map(); // region → sprite state (mid zoom active)

        // Plan 02: bloom + fade support
        this._lastVesselPos = null;   // set by TransitionManager.onUnlock
        this._pendingBloom  = false;  // fires startBloom on next _updateClusters pass
    }

    // ── startBloom — radiating bloom from vessel region ───────────────────────
    // Sorts all active clusters by distance from originPos and staggers their
    // bloom-in animation by 60 ms each (closest first = inside-out bloom).
    startBloom(originPos) {
        const all = [
            ...this._shipClusters.values(),
            ...this._flightClusters.values(),
        ];
        // Only bloom clusters that have a valid position (have been placed this tick)
        all.sort((a, b) =>
            a.sprite.position.distanceTo(originPos) -
            b.sprite.position.distanceTo(originPos)
        );
        const nowMs = Date.now();
        all.forEach((c, i) => {
            c.bloomAt   = nowMs + i * 60;  // 60 ms stagger
            c.fadeOutAt = 0;               // cancel any pending fade
        });
    }

    // ── fadeDistantClusters — called by TransitionManager at 300 ms into lock ─
    // Marks clusters farther than `thresh` scene units from vesselPos for fade-out.
    fadeDistantClusters(vesselPos, thresh = 80) {
        const nowMs = Date.now();
        [this._shipClusters, this._flightClusters].forEach(map => {
            map.forEach(c => {
                if (c.sprite.position.distanceTo(vesselPos) > thresh) {
                    c.fadeOutAt = nowMs;
                    c.bloomAt   = 0;
                }
            });
        });
    }

    // AIS-vessels layer on/off — gates SHIP clustering (vessels) only; aircraft untouched.
    // When off, hides all ship/dark/active cluster sprites so the vessel layer fully disappears.
    setShipsEnabled(on) {
        this._shipsEnabled = !!on;
        if (!on) {
            [this._shipClusters, this._darkClusters, this._activeClusters].forEach(map =>
                map.forEach(c => { c.sprite.visible = false; if (c.shadow) c.shadow.visible = false; }));
        }
    }

    // elapsed — seconds since app start (for smooth sine-wave pulse animation)
    tick(aisShips, camera, elapsed = 0) {
        if (this._shipsEnabled) this._tickShips(aisShips, camera, elapsed);
        this._tickFlights(aisShips, camera, elapsed);
    }

    // ── Ship clustering — three-tier LOD ─────────────────────────────────────
    // Far   (camera.y > 150):  combined count, one sprite per region
    // Mid   (camera.y 90–150): split — red dark count + green non-dark count
    // Close (camera.y < 80):   no clusters, individual markers visible
    _tickShips(aisShips, camera, elapsed) {
        const camY       = camera.position.y;
        const isFar      = camY > CLUSTER.SHIP_THRESHOLD;
        const isMid      = !isFar && camY > CLUSTER.SPLIT_THRESHOLD;
        const isClose    = camY <= CLUSTER.SPLIT_THRESHOLD;
        const wasActive  = this._shipActive;
        const nowMs      = Date.now();

        // ── Close zoom — hide all cluster sprites, show individual vessels ────
        if (isClose) {
            if (this._shipActive) {
                this._shipActive = false;
                aisShips.forEach(ship => {
                    if (ship.userData.isRealAIS && !ship.userData.isDark)
                        ship.visible = !ship.userData._classHidden;  // honor class filter
                });
                this._shipClusters.forEach(c => { c.sprite.visible = false; c.shadow.visible = false; });
                this._darkClusters.forEach(c   => { c.sprite.visible = false; c.shadow.visible = false; });
                this._activeClusters.forEach(c => { c.sprite.visible = false; c.shadow.visible = false; });
            }
            return;
        }

        this._shipActive = true;

        // Build per-region data
        const regionData      = new Map(); // for far-zoom combined
        const regionDarkData  = new Map(); // for mid-zoom dark sub-cluster
        const regionActiveData = new Map(); // for mid-zoom active sub-cluster

        aisShips.forEach(ship => {
            if (!ship.userData.isRealAIS) return;
            if (!ship.userData.isDark) ship.visible = false;

            const lat = ship.userData.latDeg;
            const lon = ship.userData.lonDeg;
            if (lat == null) return;

            const region = detectRegion(lat, lon);
            const isDark   = ship.userData.isDark === true;
            const isActive = !isDark; // all non-dark vessels count for green cluster

            const anomLvl = window.aiCopilot
                ? window.aiCopilot.getVesselAnomalyLevel(ship.userData.mmsi ?? ship.userData.id) ?? 0
                : 0;

            // Combined (far zoom)
            if (!regionData.has(region)) {
                regionData.set(region, { cx: 0, cy: 0, cz: 0, count: 0,
                    anomalyCount: 0, oldestDarkMs: Infinity, newestAnomalyMs: 0 });
            }
            const d = regionData.get(region);
            d.cx += ship.position.x; d.cy += ship.position.y; d.cz += ship.position.z;
            d.count++;
            if (isDark) {
                d.anomalyCount++;
                const since = ship.userData.darkSinceMs ?? nowMs;
                if (since < d.oldestDarkMs) d.oldestDarkMs = since;
            } else if (anomLvl > 0) {
                d.anomalyCount++;
                d.newestAnomalyMs = Math.max(d.newestAnomalyMs, nowMs);
            }

            // Dark sub-cluster (mid zoom)
            if (isDark) {
                if (!regionDarkData.has(region)) {
                    regionDarkData.set(region, { cx: 0, cy: 0, cz: 0, count: 0,
                        anomalyCount: 0, oldestDarkMs: Infinity, newestAnomalyMs: 0 });
                }
                const dd = regionDarkData.get(region);
                dd.cx += ship.position.x; dd.cy += ship.position.y; dd.cz += ship.position.z;
                dd.count++;
                dd.anomalyCount++;
                const since = ship.userData.darkSinceMs ?? nowMs;
                if (since < dd.oldestDarkMs) dd.oldestDarkMs = since;
            }

            // Active sub-cluster (mid zoom)
            if (isActive) {
                if (!regionActiveData.has(region)) {
                    regionActiveData.set(region, { cx: 0, cy: 0, cz: 0, count: 0,
                        anomalyCount: 0, oldestDarkMs: Infinity, newestAnomalyMs: 0 });
                }
                const da = regionActiveData.get(region);
                da.cx += ship.position.x; da.cy += ship.position.y; da.cz += ship.position.z;
                da.count++;
            }
        });

        // ── Far zoom — one combined sprite per region ─────────────────────────
        if (isFar) {
            this._darkClusters.forEach(c   => { c.sprite.visible = false; c.shadow.visible = false; });
            this._activeClusters.forEach(c => { c.sprite.visible = false; c.shadow.visible = false; });
            this._updateClusters(regionData, this._shipClusters, 4, elapsed, nowMs, false);
            this._shipClusters.forEach((c, region) => {
                if (!regionData.has(region)) { c.sprite.visible = false; c.shadow.visible = false; c.lastCount = -1; }
            });
            if (!wasActive && this._lastVesselPos) this.startBloom(this._lastVesselPos);
        }

        // ── Mid zoom — split dark (red) + active (green) sprites ─────────────
        if (isMid) {
            this._shipClusters.forEach(c => { c.sprite.visible = false; c.shadow.visible = false; });
            // Dark sub-clusters — force red
            this._updateClusters(regionDarkData, this._darkClusters, 5, elapsed, nowMs, false);
            this._darkClusters.forEach((c, region) => {
                if (!regionDarkData.has(region)) {
                    c.sprite.visible = false; c.shadow.visible = false; c.lastCount = -1;
                } else {
                    const cnt = regionDarkData.get(region)?.count ?? 0;
                    if (c.lastColor !== '#FF2244' || c.lastCount !== cnt) {
                        const tex = makeClusterTexture(cnt, '#FF2244');
                        if (c.spriteMat.map) c.spriteMat.map.dispose();
                        c.spriteMat.map         = tex;
                        c.spriteMat.needsUpdate = true;
                        c.lastColor             = '#FF2244';
                        c.lastCount             = cnt;
                    }
                }
            });
            // Active sub-clusters — green (isFlight=true skips anomaly coloring, we override color below)
            this._updateClusters(regionActiveData, this._activeClusters, 3, elapsed, nowMs, true);
            this._activeClusters.forEach((c, region) => {
                if (!regionActiveData.has(region)) { c.sprite.visible = false; c.shadow.visible = false; c.lastCount = -1; }
                else {
                    // Override color to green for active vessel clusters
                    const cnt = regionActiveData.get(region)?.count ?? 0;
                    if (c.lastColor !== '#00ff88' || c.lastCount !== cnt) {
                        const tex = makeClusterTexture(cnt, '#00ff88');
                        if (c.spriteMat.map) c.spriteMat.map.dispose();
                        c.spriteMat.map = tex;
                        c.spriteMat.needsUpdate = true;
                        c.lastColor = '#00ff88';
                        c.lastCount = cnt;
                    }
                }
            });
        }
    }

    // ── Flight clustering ─────────────────────────────────────────────────────
    _tickFlights(aisShips, camera, elapsed) {
        const shouldCluster = camera.position.y > CLUSTER.FLIGHT_THRESHOLD;

        if (!shouldCluster) {
            if (this._flightActive) {
                this._flightActive = false;
                aisShips.forEach(ship => {
                    if (!ship.userData.isRealFlight) return;
                    ship.visible = true;
                    // The altitude glow is a sibling sprite in laneGroup, not
                    // a child of the aircraft mesh (see entityBuilder.js —
                    // a child would inherit the mesh's tiny scale and shrink
                    // to near-invisible), so its visibility must be toggled
                    // explicitly here rather than following ship.visible
                    // automatically. Trail (full position history) stays
                    // hidden here on purpose: forcing it visible for every
                    // aircraft on cluster-split undid the selection-only
                    // gating from task #48 and produced the long
                    // crossing-line spaghetti across the whole map. Trail
                    // visibility is owned exclusively by the lockedShip sync
                    // in the main animation loop now.
                    if (ship.userData.altitudeGlow) ship.userData.altitudeGlow.visible = true;
                });
                this._flightClusters.forEach(c => {
                    c.sprite.visible = false;
                    c.shadow.visible = false;
                });
            }
            return;
        }

        this._flightActive = true;
        const nowMs      = Date.now();
        const regionData = new Map();

        aisShips.forEach(ship => {
            if (!ship.userData.isRealFlight) return;
            ship.visible = false;
            if (ship.userData.trail) ship.userData.trail.visible = false;
            if (ship.userData.altitudeGlow) ship.userData.altitudeGlow.visible = false;
            // Emergency ring (Task #1, flightIntegrityManager EMERGENCY flag)
            // — same sibling-sprite visibility gotcha as altitudeGlow above:
            // it doesn't follow ship.visible automatically, so without this
            // it would stay visible (stuck on whatever the per-frame sync in
            // main.js last set) even while clustered/hidden.
            if (ship.userData.emergencyRing) ship.userData.emergencyRing.visible = false;

            const lat = ship.userData.latDeg;
            const lon = ship.userData.lonDeg;
            if (lat == null) return;

            const region = detectRegion(lat, lon);
            if (!regionData.has(region)) {
                regionData.set(region, {
                    cx: 0, cy: 0, cz: 0,
                    count: 0, anomalyCount: 0,
                    oldestDarkMs: Infinity, newestAnomalyMs: 0,
                });
            }
            const d = regionData.get(region);
            d.cx += ship.position.x;
            d.cy += ship.position.y;
            d.cz += ship.position.z;
            d.count++;
        });

        // Flights use fixed amber — no anomaly color temperature
        this._updateClusters(regionData, this._flightClusters, 6, elapsed, nowMs, true);

        this._flightClusters.forEach((c, region) => {
            if (!regionData.has(region)) {
                c.sprite.visible = false;
                c.shadow.visible = false;
                c.lastCount      = -1;
            }
        });
    }

    // ── Shared centroid → sprite updater ──────────────────────────────────────
    _updateClusters(regionData, clusterMap, yOffset, elapsed, nowMs, isFlight) {
        regionData.forEach((d, region) => {
            d.cx /= d.count;
            d.cy /= d.count;
            d.cz /= d.count;

            if (!clusterMap.has(region)) {
                clusterMap.set(region, makeSprite(this.scene));
            }
            const cluster = clusterMap.get(region);

            // ── Significance: color temperature ──────────────────────────────
            const anomalyRatio = d.count > 0 ? d.anomalyCount / d.count : 0;
            const color = isFlight ? '#ffaa00' : _getAnomalyColor(anomalyRatio);

            // ── Significance: pulse mode ──────────────────────────────────────
            // high  — recent anomaly within last 10 min (fast 1.2 s cycle)
            // low   — stale dark (> 6 h) or no anomaly (slow 4 s cycle)
            const isFlagged     = !isFlight && anomalyRatio > 0.10;
            const recentAnomaly = (nowMs - d.newestAnomalyMs) < CLUSTER.ANOMALY_HIGH_RECENCY;
            const staleDark     = d.oldestDarkMs !== Infinity &&
                                  (nowMs - d.oldestDarkMs) > CLUSTER.DARK_STALE;

            let pulseMode = 'low';
            if (isFlagged && recentAnomaly && !staleDark) pulseMode = 'high';

            // Ping flash — fires once when cluster first becomes flagged
            if (isFlagged && !cluster.prevFlagged) {
                cluster.pingStartMs = nowMs;
            }
            cluster.prevFlagged = isFlagged;
            cluster.pulseMode   = pulseMode;

            // ── Rebuild texture only when state or count changes ──────────────
            if (cluster.lastCount !== d.count || cluster.lastColor !== color) {
                const tex = makeClusterTexture(d.count, color);
                if (cluster.spriteMat.map) cluster.spriteMat.map.dispose();
                cluster.spriteMat.map         = tex;
                cluster.spriteMat.needsUpdate = true;
                cluster.lastCount             = d.count;
                cluster.lastColor             = color;
            }

            // ── Pulse animation — modulate opacity via Three.js each frame ────
            const pingAgeS = cluster.pingStartMs
                ? (nowMs - cluster.pingStartMs) / 1000
                : null;

            if (pingAgeS !== null && pingAgeS < 0.5) {
                // Ping: 0→0.25 s ramp up, 0.25→0.5 s settle back to base
                cluster.spriteMat.opacity = pingAgeS < 0.25
                    ? 0.70 + (pingAgeS / 0.25) * 0.30      // 0.70 → 1.00
                    : 1.00 - ((pingAgeS - 0.25) / 0.25) * 0.22; // 1.00 → 0.78
            } else {
                if (pingAgeS !== null && pingAgeS >= 0.5) cluster.pingStartMs = 0;
                const cycle = pulseMode === 'high' ? 1.2 : 4.0;
                const wave  = Math.sin((elapsed / cycle) * Math.PI * 2);
                cluster.spriteMat.opacity = pulseMode === 'high'
                    ? 0.72 + wave * 0.15   // 0.57 – 0.87
                    : 0.60 + wave * 0.20;  // 0.40 – 0.80
            }

            // ── Plan 02: Bloom-in override ────────────────────────────────────
            // Fade opacity from 0 → full over 300 ms, starting at bloomAt.
            // bloomAt == 0 means no active bloom — skip.
            if (cluster.bloomAt > 0) {
                const age = nowMs - cluster.bloomAt;
                if (age < 0) {
                    // Stagger delay not yet reached — hold invisible
                    cluster.spriteMat.opacity = 0;
                } else if (age < 300) {
                    // Ease-out bloom: scale opacity + inject CSS scale via opacity proxy
                    cluster.spriteMat.opacity *= Math.pow(age / 300, 0.55);
                } else {
                    cluster.bloomAt = 0;   // bloom complete, resume normal pulse
                }
            }

            // ── Plan 02: Fade-out override ────────────────────────────────────
            // Fade opacity to 0 over 200 ms starting at fadeOutAt.
            if (cluster.fadeOutAt > 0) {
                const age = nowMs - cluster.fadeOutAt;
                if (age < 200) {
                    cluster.spriteMat.opacity *= Math.max(0, 1 - age / 200);
                } else {
                    // Fade complete — hide until cluster becomes relevant again
                    cluster.spriteMat.opacity = 0;
                    cluster.sprite.visible    = false;
                    cluster.shadow.visible    = false;
                    cluster.fadeOutAt         = 0;
                }
            }

            // ── Position + shadow ─────────────────────────────────────────────
            cluster.sprite.position.set(d.cx, d.cy + yOffset, d.cz);
            // Only force visible if a fade-out didn't just hide it this tick
            if (cluster.fadeOutAt === 0) cluster.sprite.visible = true;

            // Ground shadow disabled — over the bright flattened terrain these
            // dark discs read as "black holes" blotting the map. The cluster
            // bubble (ring + count) is legible on its own. Kept the sprite for
            // back-compat but never shown.
            cluster.shadow.visible = false;
        });
    }

    dispose() {
        [this._shipClusters, this._flightClusters].forEach(map => {
            map.forEach(c => {
                if (c.spriteMat.map) c.spriteMat.map.dispose();
                c.spriteMat.dispose();
                this.scene.remove(c.sprite);
                if (c.shadow) {
                    c.shadow.material.dispose();
                    this.scene.remove(c.shadow);
                }
            });
            map.clear();
        });
    }
}
