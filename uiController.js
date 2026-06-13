// uiController.js — HUD toggles, tooltip, raycasting, vessel/flight panels, search, alert zones
import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';

// ── Scene ↔ lat/lon helpers (inverse of lonLatToScene in aisManager.js) ────────
function _scenePosToLonLat(x, z) {
    const lon    = (x / (MAP_WIDTH  / 2)) * 180;
    const mercY  = -(z / (MAP_HEIGHT / 2)) * Math.PI;
    const latRad = 2 * Math.atan(Math.exp(mercY)) - Math.PI / 2;
    return { lon, lat: latRad * (180 / Math.PI) };
}
import { getTrueElevation } from './terrainBuilder.js';
import { CITIES } from './cityManager.js';
import { contextCards } from './contextCardManager.js';

// ── Module-level state ────────────────────────────────────────────────────────
let _searchQuery  = '';
let _detailShip   = null;   // ship currently shown in vessel-detail panel
let _alertZone    = null;   // { mesh, ringMesh, center: Vector3, radius: number }
let _zoneWaiting  = false;  // true while waiting for user click to place zone
let _darkCount    = 0;

// ── Highlight helpers ─────────────────────────────────────────────────────────
const highlightMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0x444444,
});

export function highlightShip(shipGroup) {
    shipGroup.children.forEach(child => {
        if (child.isMesh && child.userData.baseMaterial) {
            child.material = highlightMat;
        }
    });
}

export function resetShipHighlight(shipGroup) {
    shipGroup.children.forEach(child => {
        if (child.isMesh && child.userData.baseMaterial) {
            child.material = child.userData.baseMaterial;
        }
    });
}

// ── Coordinate / region helpers ───────────────────────────────────────────────
// targetAlt — desired camera.position.y after fly-to. Default 90 (regional tactical view).
// Pass 0 to preserve current altitude (pan-only behaviour).
export function flyToSector(lon, lat, camera, controls, stateRef, targetAlt = 90) {
    const x      = (lon / 180.0) * (MAP_WIDTH  / 2.0);
    const latRad = lat * (Math.PI / 180.0);
    const mercY  = Math.log(Math.tan(Math.PI / 4.0 + latRad / 2.0));
    const z      = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);

    stateRef.terrainTargetPos.set(x, 0, z);
    stateRef.isPanningToTerrain = true;

    if (targetAlt > 0) {
        // Fly to a position directly above the target at the requested altitude.
        // Offset slightly toward the viewer so the destination fills the screen.
        stateRef.flightTargetPos.set(x, targetAlt, z + targetAlt * 0.55);
        stateRef.isFlyingToTarget = true;
    } else {
        // Pan-only — maintain current camera height
        const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
        stateRef.flightTargetPos.copy(stateRef.terrainTargetPos).add(dir.multiplyScalar(60));
        if (stateRef.flightTargetPos.y < 15) stateRef.flightTargetPos.y = 15;
        stateRef.isFlyingToTarget = true;
    }

    stateRef.lockedShip = null;
}

export function detectRegion(lat, lon) {
    if (lat >  60)                          return 'ARCTIC';
    if (lat < -60)                          return 'ANTARCTIC';
    if (lon > -30  && lon < 60  && lat > 0) return 'EUROPE / N.AFRICA';
    if (lon > 60   && lon < 150 && lat > 0) return 'ASIA-PACIFIC';
    if (lon > -170 && lon < -30 && lat > 0) return 'NORTH AMERICA';
    if (lon > -90  && lon < -30 && lat < 0) return 'SOUTH AMERICA';
    if (lon > 10   && lon < 55  && lat < 0) return 'SUB-SAHARAN AFRICA';
    if (lon > 100  && lon < 160 && lat < 0) return 'SOUTHERN PACIFIC';
    return 'OPEN OCEAN';
}

// ── Named waterways ─────────────────────────────────────────────────────────
// The terrain DEM is too coarse to carve narrow fjords, sounds, and rivers, so
// vessels genuinely on water there can render over land. This gazetteer names
// the common cases so the vessel card explains where the ship actually is,
// rather than leaving it looking mysteriously "on land". [latMin,latMax,lonMin,lonMax].
const NAMED_WATERWAYS = [
    { name: 'SOGNEFJORD',                 box: [60.8, 61.4,   4.8,  7.4] },
    { name: 'OSLOFJORD',                  box: [59.0, 59.95, 10.2, 11.0] },
    { name: 'HARDANGERFJORD',             box: [59.7, 60.6,   5.4,  7.2] },
    { name: 'NORWEGIAN COASTAL WATERS',   box: [58.0, 71.5,   4.0, 31.0] },
    { name: 'SALISH SEA / PUGET SOUND',   box: [47.0, 49.5, -125.0,-122.0] },
    { name: 'FRASER RIVER / VANCOUVER',   box: [49.0, 49.45,-123.6,-122.4] },
    { name: 'ST. LAWRENCE SEAWAY',        box: [45.0, 50.0, -75.0, -64.0] },
    { name: 'DANISH STRAITS',             box: [54.5, 58.0,   9.0, 13.5] },
    { name: 'STRAIT OF JUAN DE FUCA',     box: [48.0, 48.6, -124.8,-123.0] },
    { name: 'CHESAPEAKE BAY',             box: [36.8, 39.6, -77.2, -75.8] },
];

// Returns a named waterway for a position, or null. Honest fallback handled
// by the caller (it can show "COASTAL WATERWAY" when the DEM shows land here).
export function detectWaterway(lat, lon) {
    if (lat == null || lon == null) return null;
    for (const w of NAMED_WATERWAYS) {
        const [laM, laX, loM, loX] = w.box;
        if (lat >= laM && lat <= laX && lon >= loM && lon <= loX) return w.name;
    }
    return null;
}

// ── Search ────────────────────────────────────────────────────────────────────
export function applySearchFilter(aisShips) {
    const q = _searchQuery.toLowerCase().trim();
    if (!q) {
        aisShips.forEach(s => { s.userData._searchHidden = false; });
        const el = document.getElementById('search-match-count');
        if (el) el.innerText = '';
        return;
    }
    let matches = 0;
    aisShips.forEach(s => {
        const ud = s.userData;
        const hit = (
            (ud.id          && String(ud.id).toLowerCase().includes(q))   ||
            (ud.displayName && ud.displayName.toLowerCase().includes(q))  ||
            (ud.class       && ud.class.toLowerCase().includes(q))        ||
            (ud.country     && ud.country.toLowerCase().includes(q))
        );
        s.userData._searchHidden = !hit;
        if (hit) matches++;
    });
    const el = document.getElementById('search-match-count');
    if (el) el.innerText = matches ? `${matches} MATCH${matches > 1 ? 'ES' : ''}` : 'NO MATCH';
}

export function tickSearchVisibility(aisShips) {
    aisShips.forEach(s => {
        if (s.userData._searchHidden !== undefined) {
            s.visible = !s.userData._searchHidden;
            if (s.userData.trail) s.userData.trail.visible = s.visible;
        }
    });
}

// ── Alert zone ────────────────────────────────────────────────────────────────
function _clearZoneMeshes(scene) {
    if (_alertZone) {
        scene.remove(_alertZone.mesh);
        scene.remove(_alertZone.ringMesh);
        _alertZone.mesh.geometry.dispose();
        _alertZone.ringMesh.geometry.dispose();
        _alertZone = null;
    }
    const badge = document.getElementById('alert-zone-badge');
    if (badge) badge.innerText = '';
}

export function tickAlertZone(aisShips) {
    if (!_alertZone) return;
    let alertCount = 0;
    aisShips.forEach(s => {
        const dist = s.position.distanceTo(_alertZone.center);
        if (dist < _alertZone.radius) alertCount++;
    });
    const badge = document.getElementById('alert-zone-badge');
    if (badge) {
        badge.innerText  = alertCount > 0 ? `⚠ ${alertCount} IN ZONE` : '';
        badge.style.color = alertCount > 0 ? 'var(--orange)' : '';
    }
}

// ── Plan 04 helpers ───────────────────────────────────────────────────────────

/**
 * Score behavioral anomalies for a vessel.
 * Returns { score: number, criteria: string[], state: '' | 'elevated' | 'critical' }
 */
function _computeBehaviorScore(ud) {
    const criteria = [];
    let score = 0;

    if (ud.isDark) {
        score += 2;
        criteria.push('AIS SIGNAL LOST');
    }
    if (ud.speedKts != null && ud.speedKts < 0.4) {
        score += 1;
        criteria.push('ZERO VELOCITY / DRIFTING');
    }
    const anomLvl = window.aiCopilot
        ? window.aiCopilot.getVesselAnomalyLevel(ud.mmsi ?? ud.id) ?? 0
        : 0;
    if (anomLvl >= 2) {
        score += 2;
        criteria.push('ACTIVE THREAT FLAG');
    } else if (anomLvl === 1) {
        score += 1;
        criteria.push('ELEVATED ANOMALY SCORE');
    }
    // Note: destination/ETA are only available from AIS type-5 Voyage messages,
    // which are not currently parsed — do not use absence of destination as a signal.

    const state = score === 0 ? '' : score <= 2 ? 'elevated' : 'critical';
    return { score, criteria, state };
}

/**
 * Build a one-line comparative context string about this vessel's region.
 * e.g. "7 OF 23 FLAGGED · SOUTH CHINA SEA"
 */
function _computeComparativeContext(ship) {
    const ud     = ship.userData;
    if (ud.latDeg == null || !window.aisShips) return null;

    const region  = detectRegion(ud.latDeg, ud.lonDeg);
    const peers   = window.aisShips.filter(s =>
        s.userData.isRealAIS &&
        s.userData.latDeg != null &&
        detectRegion(s.userData.latDeg, s.userData.lonDeg) === region
    );
    const flagged = peers.filter(s => {
        if (s.userData.isDark) return true;
        const lv = window.aiCopilot
            ? window.aiCopilot.getVesselAnomalyLevel(s.userData.mmsi ?? s.userData.id) ?? 0
            : 0;
        return lv > 0;
    });

    if (peers.length === 0) return null;
    const pct = flagged.length > 0
        ? `${flagged.length} OF ${peers.length} FLAGGED`
        : `${peers.length} TRACKED`;
    return `${pct} · ${region}`;
}

/**
 * Render a compact SVG bird's-eye track from trail ring-buffer positions.
 * positions: [{ x, z }] in scene coordinates, oldest → newest.
 * Maps scene X (east-west) to SVG X, scene Z (south-positive) to SVG Y flipped.
 */
function _renderTimeline(positions, accentColor = '#00D4FF') {
    const W = 260, H = 36, PAD = 6;

    if (!positions || positions.length === 0) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
            <text x="${W/2}" y="${H/2 + 3}" text-anchor="middle" font-size="7" fill="rgba(64,196,255,0.3)" font-family="Courier New">NO TRACK DATA</text>
        </svg>`;
    }

    if (positions.length === 1) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
            <circle cx="${W/2}" cy="${H/2}" r="3" fill="${accentColor}" opacity="0.8"/>
            <text x="${W - PAD}" y="${H - 2}" text-anchor="end" font-size="7" fill="rgba(64,196,255,0.3)" font-family="Courier New">NOW</text>
        </svg>`;
    }

    const xs = positions.map(p => p.x);
    const zs = positions.map(p => p.z);
    let minX = Math.min(...xs), maxX = Math.max(...xs);
    let minZ = Math.min(...zs), maxZ = Math.max(...zs);

    // If vessel barely moved, pad ranges so it doesn't collapse to a point
    const EPS = 0.5;
    if (maxX - minX < EPS) { minX -= EPS; maxX += EPS; }
    if (maxZ - minZ < EPS) { minZ -= EPS; maxZ += EPS; }

    const rangeX = maxX - minX;
    const rangeZ = maxZ - minZ;

    // Add a little breathing room inside the viewBox
    const IPAD = PAD + 2;
    const IW   = W - IPAD * 2;
    const IH   = H - IPAD * 2;

    const pts = positions.map(p => {
        const sx = IPAD + ((p.x - minX) / rangeX) * IW;
        // Z increases southward, so invert Y: smaller Z (north) → top (small SVG Y)
        const sy = IPAD + ((p.z - minZ) / rangeZ) * IH;
        return `${sx.toFixed(1)},${sy.toFixed(1)}`;
    });

    // Fade the polyline: older segments drawn dimmer
    // Split into segments and vary opacity by position index
    const segLines = [];
    for (let i = 1; i < pts.length; i++) {
        const t   = i / (pts.length - 1);       // 0 = oldest end, 1 = newest end
        const op  = (0.15 + t * 0.55).toFixed(2);
        segLines.push(
            `<line x1="${pts[i-1].split(',')[0]}" y1="${pts[i-1].split(',')[1]}" ` +
            `x2="${pts[i].split(',')[0]}" y2="${pts[i].split(',')[1]}" ` +
            `stroke="${accentColor}" stroke-width="1.2" stroke-linecap="round" opacity="${op}"/>`
        );
    }

    // Dots: tiny for history, prominent for current position
    const dotEls = pts.map((pt, i) => {
        const [px, py] = pt.split(',');
        const isLast   = i === pts.length - 1;
        const r        = isLast ? 3.5 : 1.2;
        const op       = isLast ? '1' : (0.15 + (i / pts.length) * 0.45).toFixed(2);
        return `<circle cx="${px}" cy="${py}" r="${r}" fill="${accentColor}" opacity="${op}"/>`;
    }).join('');

    // NOW label near the last point
    const [lx, ly] = pts[pts.length - 1].split(',');
    const labelX   = Math.min(parseFloat(lx) + 6, W - 22);
    const labelY   = Math.max(parseFloat(ly) - 3, 9);

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
        ${segLines.join('')}
        ${dotEls}
        <text x="${labelX.toFixed(0)}" y="${labelY.toFixed(0)}" font-size="7" fill="${accentColor}" opacity="0.55" font-family="Courier New">NOW</text>
    </svg>`;
}

// ── Vessel detail panel ───────────────────────────────────────────────────────
export function showVesselDetail(ship, camera, controls, stateRef) {
    _detailShip = ship;
    const ud    = ship.userData;
    const panel = document.getElementById('vessel-detail');
    if (!panel) return;

    const isAircraft  = ud.isRealFlight || ud.class === 'FIGHTER';
    const isSatellite = ud.isRealSatellite;

    document.getElementById('vd-name').innerText =
        ud.displayName || ud.id || '—';

    const idLabel = document.getElementById('vd-id-label');
    if (idLabel) idLabel.innerText = isAircraft ? 'ICAO24' : isSatellite ? 'NORAD' : 'MMSI';

    document.getElementById('vd-mmsi').innerText     = ud.id        || '—';
    document.getElementById('vd-class').innerText    = ud.class     || '—';
    document.getElementById('vd-heading').innerText  = ud.headingDeg != null
        ? Math.round(ud.headingDeg) + '°' : '—';
    document.getElementById('vd-country').innerText  = ud.country   || '—';
    document.getElementById('vd-destination').innerText = ud.destination || '—';
    document.getElementById('vd-eta').innerText      = ud.eta       || '—';

    const altRow = document.getElementById('vd-altitude-row');
    if (altRow) altRow.style.display = (isAircraft || isSatellite) ? '' : 'none';

    const darkRow     = document.getElementById('vd-dark-row');
    const lastContact = document.getElementById('vd-last-contact');
    if (darkRow) {
        if (ud.isDark && ud.darkSinceMs != null) {
            const ageMin = Math.round((Date.now() - ud.darkSinceMs) / 60000);
            if (lastContact) lastContact.innerText = ageMin < 60
                ? `${ageMin}m AGO`
                : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m AGO`;
            darkRow.style.display = '';
        } else {
            darkRow.style.display = 'none';
        }
    }

    // ── Plan 04: Behavioral profile + panel state ─────────────────────────────
    // Behavior scoring only applies to AIS surface vessels
    let panelState = '';
    if (ud.isRealAIS) {
        const { score, criteria, state } = _computeBehaviorScore(ud);
        panelState = state;

        // Panel border color shift
        panel.dataset.panelState = state;

        // Behavior section
        const behavSection  = document.getElementById('vd-behavior-section');
        const behavGlyph    = document.getElementById('vd-behavior-glyph');
        const behavTag      = document.getElementById('vd-behavior-tag');

        if (state && behavSection && behavGlyph && behavTag) {
            const isCritical = state === 'critical';
            const glyphColor = isCritical ? '#ff2244' : '#ff8c00';
            const glyphLabel = isCritical ? '◈ THREAT INDICATOR' : '⚡ BEHAVIOR ELEVATED';
            behavGlyph.textContent     = glyphLabel;
            behavGlyph.style.color     = glyphColor;
            behavTag.innerHTML         = criteria.map(c =>
                `<div style="color:${glyphColor};opacity:0.75;">– ${c}</div>`
            ).join('');
            behavSection.style.display = '';
        } else if (behavSection) {
            behavSection.style.display = 'none';
        }

        // Comparative context — AIS vessels only (flights/sats don't share a "region" meaningfully)
        const ctxEl = document.getElementById('vd-context');
        if (ctxEl) {
            const ctx = _computeComparativeContext(ship);
            if (ctx) { ctxEl.textContent = ctx; ctxEl.style.display = ''; }
            else      { ctxEl.style.display = 'none'; }
        }
    } else {
        // Flights, satellites — no behavior scoring
        panel.dataset.panelState = '';
        ['vd-behavior-section', 'vd-context'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
    }

    // Movement track — works for every vessel type via TrailManager read-back
    const tlWrap = document.getElementById('vd-timeline-wrap');
    const tlEl   = document.getElementById('vd-timeline');
    if (tlWrap && tlEl) {
        const trailPositions = window.trailManager?.getPositions(ship) ?? [];
        if (trailPositions.length > 0) {
            const accentColor = panelState === 'critical' ? '#ff2244'
                              : panelState === 'elevated'  ? '#ff8c00'
                              : ud.isRealFlight            ? '#ffaa00'
                              : ud.isRealSatellite         ? '#aaaaff'
                              : '#00D4FF';
            tlEl.innerHTML       = _renderTimeline(trailPositions, accentColor);
            tlWrap.style.display = '';
        } else {
            tlWrap.style.display = 'none';
        }
    }

    // ── Satellite pass arc toggle ─────────────────────────────────────────────
    const arcRow    = document.getElementById('vd-arc-row');
    const arcToggle = document.getElementById('vd-arc-toggle');
    if (arcRow) arcRow.style.display = isSatellite ? '' : 'none';
    if (arcToggle && isSatellite) {
        // Determine current arc state from the global satArcs manager
        const arcActive = window.satArcs?._selected?.has(String(ud.id));
        arcToggle.textContent = arcActive ? '⌇ HIDE PASS ARC' : '⌇ SHOW PASS ARC';
        arcToggle.style.borderColor = arcActive ? '#40ffaa' : '#40c4ff';
        arcToggle.style.color       = arcActive ? '#40ffaa' : '#40c4ff';
        arcToggle.onclick = () => {
            if (!window.satArcs) return;
            const nowActive = window.satArcs.toggleArc(ud.id);
            arcToggle.textContent = nowActive ? '⌇ HIDE PASS ARC' : '⌇ SHOW PASS ARC';
            arcToggle.style.borderColor = nowActive ? '#40ffaa' : '#40c4ff';
            arcToggle.style.color       = nowActive ? '#40ffaa' : '#40c4ff';
        };
    }

    panel.style.display = 'block';

    // Plan 02 — begin reverse (zoom-in) transition: approach → fade → vignette
    window.transitionMgr?.onLock(ship);
}

export function hideVesselDetail() {
    const panel = document.getElementById('vessel-detail');
    if (panel) panel.style.display = 'none';
    _detailShip = null;
}

export function tickVesselDetail(stateRef) {
    if (!_detailShip) return;
    const ud = _detailShip.userData;

    const speedEl = document.getElementById('vd-speed');
    if (speedEl) {
        const spd = ud.speedKts != null ? ud.speedKts.toFixed(1) + ' KTS'
            : ud.speedKmS != null ? (ud.speedKmS * 1.944).toFixed(1) + ' KTS' : '—';
        speedEl.innerText = spd;
    }

    const altEl = document.getElementById('vd-altitude');
    if (altEl) {
        altEl.innerText = ud.altMeters != null
            ? Math.round(ud.altMeters) + ' M'
            : ud.altKm != null ? Math.round(ud.altKm * 1000) + ' M' : '—';
    }

    const latEl = document.getElementById('vd-lat');
    const lonEl = document.getElementById('vd-lon');
    // Fall back to deriving lat/lon from the 3D scene position when userData
    // fields are absent (e.g. simulated vessels, first-click before first update).
    let latDeg = ud.latDeg;
    let lonDeg = ud.lonDeg;
    if ((latDeg == null || lonDeg == null) && _detailShip.position) {
        const ll = _scenePosToLonLat(_detailShip.position.x, _detailShip.position.z);
        if (latDeg == null) latDeg = ll.lat;
        if (lonDeg == null) lonDeg = ll.lon;
    }
    if (latEl && latDeg != null) latEl.innerText = latDeg.toFixed(4) + '°';
    if (lonEl && lonDeg != null) lonEl.innerText = lonDeg.toFixed(4) + '°';

    const hdgEl = document.getElementById('vd-heading');
    if (hdgEl && ud.headingDeg != null) hdgEl.innerText = Math.round(ud.headingDeg) + '°';

    const regionEl = document.getElementById('vd-region');
    if (regionEl && latDeg != null && lonDeg != null) {
        const region   = detectRegion(latDeg, lonDeg);
        // Name the specific waterway when known; otherwise, if the coarse DEM
        // shows land under the vessel, note it's in a narrow waterway the
        // terrain can't resolve (explains why it may look like it's on land).
        let waterway = detectWaterway(latDeg, lonDeg);
        if (!waterway) {
            const h = window.terrainHeight?.sampleTerrainHeightXZ?.(
                _detailShip.position.x, _detailShip.position.z) ?? 0;
            if (h > 0.05) waterway = 'COASTAL / INLAND WATERWAY';
        }
        regionEl.innerText = waterway ? `${region} · ${waterway}` : region;
    }

    // Dark row — update elapsed time while panel is open
    const darkRowEl = document.getElementById('vd-dark-row');
    const lcEl      = document.getElementById('vd-last-contact');
    if (darkRowEl && lcEl) {
        if (ud.isDark && ud.darkSinceMs != null) {
            const ageMin = Math.round((Date.now() - ud.darkSinceMs) / 60000);
            lcEl.innerText = ageMin < 60
                ? `${ageMin}m AGO`
                : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m AGO`;
            darkRowEl.style.display = '';
        } else if (darkRowEl.style.display !== 'none') {
            darkRowEl.style.display = 'none';
        }
    }
}

// ── Ship list panel ───────────────────────────────────────────────────────────
export function refreshShipList(aisShips, stateRef, camera, controls) {
    const body  = document.getElementById('ship-list-body');
    const count = document.getElementById('ship-list-count');
    if (!body) return;

    const vessels = aisShips.filter(s =>
        !s.userData.isRealFlight && !s.userData.isRealSatellite
    );

    if (count) count.innerText = vessels.length;
    body.innerHTML = '';

    vessels.slice(0, 120).forEach(ship => {
        const ud  = ship.userData;
        const row = document.createElement('div');
        row.className = 'ship-list-row';
        row.style.cssText = `
            display:flex; justify-content:space-between; align-items:center;
            padding:6px 8px; border-bottom:1px solid rgba(64,196,255,0.08);
            cursor:pointer; font-size:10px;
        `;
        row.innerHTML = `
            <span style="color:${ud.htmlColor ?? 'var(--cyan)'}; font-weight:bold;">
                ${ud.displayName || ud.id || 'UNKNOWN'}
            </span>
            <span style="color:#8aabc4;">${ud.class || '—'}</span>
            <span style="color:#fff;">${ud.speedKts != null ? ud.speedKts.toFixed(1) + ' KTS' : '—'}</span>
        `;
        row.addEventListener('click', () => {
            showVesselDetail(ship, camera, controls, stateRef);
            stateRef.lockedShip       = ship;
            stateRef.isFlyingToTarget = true;
            const dir = new THREE.Vector3()
                .subVectors(camera.position, ship.position).normalize();
            stateRef.flightTargetPos
                .copy(ship.position).add(dir.multiplyScalar(35));
            if (stateRef.flightTargetPos.y < 5) stateRef.flightTargetPos.y = 5;
        });
        body.appendChild(row);
    });

    if (vessels.length === 0) {
        body.innerHTML = '<div style="color:#4a6b84;padding:12px;font-size:10px;">NO VESSELS TRACKED</div>';
    }
}

// ── Flight list panel ─────────────────────────────────────────────────────────
export function refreshFlightList(aisShips, stateRef, camera, controls) {
    const body  = document.getElementById('flight-list-body');
    const count = document.getElementById('flight-list-count');
    if (!body) return;

    const flights = aisShips.filter(s => s.userData.isRealFlight);

    if (count) count.innerText = flights.length;
    body.innerHTML = '';

    flights.slice(0, 120).forEach(flight => {
        const ud  = flight.userData;
        const row = document.createElement('div');
        row.className = 'flight-list-row';
        row.style.cssText = `
            display:flex; justify-content:space-between; align-items:center;
            padding:6px 8px; border-bottom:1px solid rgba(255,165,0,0.08);
            cursor:pointer; font-size:10px;
        `;
        const alt = ud.altMeters != null ? Math.round(ud.altMeters / 100) * 100 + ' M' : '—';
        row.innerHTML = `
            <span style="color:var(--orange); font-weight:bold;">
                ${ud.displayName || ud.id || 'UNKNOWN'}
            </span>
            <span style="color:#8aabc4;">${alt}</span>
            <span style="color:#fff;">${ud.speedKts != null ? ud.speedKts.toFixed(0) + ' KTS' : '—'}</span>
        `;
        row.addEventListener('click', () => {
            showVesselDetail(flight, camera, controls, stateRef);
            stateRef.lockedShip       = flight;
            stateRef.isFlyingToTarget = true;
            const dir = new THREE.Vector3()
                .subVectors(camera.position, flight.position).normalize();
            stateRef.flightTargetPos
                .copy(flight.position).add(dir.multiplyScalar(35));
            if (stateRef.flightTargetPos.y < 5) stateRef.flightTargetPos.y = 5;
        });
        body.appendChild(row);
    });

    if (flights.length === 0) {
        body.innerHTML = '<div style="color:#4a6b84;padding:12px;font-size:10px;">NO FLIGHTS TRACKED</div>';
    }
}

// ── City list panel population ────────────────────────────────────────────────
function _populateCityList(panel, camera, controls, stateRef) {
    const body = document.getElementById('city-list-body');
    if (!body) return;
    body.innerHTML = '';

    const tiers = [
        { label: 'TIER I — MEGACITIES',    num: 1, dot: 'var(--red)'   },
        { label: 'TIER II — MAJOR HUBS',   num: 2, dot: 'var(--cyan)'  },
        { label: 'TIER III — REGIONAL',    num: 3, dot: '#8aabc4'      },
    ];

    tiers.forEach(({ label, num, dot }) => {
        const cities = CITIES.filter(c => c.tier === num);
        if (!cities.length) return;

        // Tier header
        const header = document.createElement('div');
        header.className = 'sl-region-header';
        header.innerHTML = `
            <span class="sl-region-name">${label}</span>
            <span class="sl-count">${cities.length}</span>
        `;
        body.appendChild(header);

        cities.forEach(city => {
            const row = document.createElement('div');
            row.className = 'sl-vessel-row';
            const popStr = city.pop >= 10
                ? city.pop.toFixed(0) + 'M'
                : city.pop.toFixed(1) + 'M';
            row.style.justifyContent = 'space-between';
            row.innerHTML = `
                <span style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
                    <span class="sl-dot" style="background:${dot};flex-shrink:0;"></span>
                    <span class="sl-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${city.name.toUpperCase()}</span>
                </span>
                <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                    <span class="sl-speed" style="font-size:9px; color:var(--cyan);">${popStr}</span>
                </span>
            `;
            row.addEventListener('click', () => {
                panel.style.display = 'none';
                const tog = document.getElementById('city-list-toggle');
                if (tog) tog.classList.remove('active');
                flyToSector(city.lon, city.lat, camera, controls, stateRef);
            });
            body.appendChild(row);
        });
    });
}

// ── Main UI setup ─────────────────────────────────────────────────────────────
export function setupUI(deps) {
    const {
        splatCloud, laneGroup, seaLevelGroup, oceanFloorMesh, aquariumWalls,
        bordersGroup, portMarkersGroup,
        ssaoPass, bloomPass, bokehPass,
        camera, controls,
        stateRef, aisShipsRef, scene,
        dayNightManager, satelliteManager, predGroup,
        cinematicDirector,
    } = deps;

    // ── Collapsible panels ────────────────────────────────────────────────────
    const otBtn     = document.getElementById('ot-toggle-btn');
    const otBody    = document.getElementById('ot-body');
    const otChevron = document.getElementById('ot-chevron');
    if (otBtn && otBody) {
        otBtn.addEventListener('click', () => {
            const collapsed = otBody.style.display === 'none';
            otBody.style.display    = collapsed ? '' : 'none';
            if (otChevron) otChevron.style.transform = collapsed ? '' : 'rotate(-90deg)';
        });
    }

    const lgBtn     = document.getElementById('legend-toggle-btn');
    const lgBody    = document.getElementById('legend-body');
    const lgChevron = document.getElementById('legend-chevron');
    if (lgBtn && lgBody) {
        // Progressive disclosure — starts collapsed (no .open class).
        // Class-based toggle drives the CSS max-height/opacity transition so
        // the drawer animates smoothly rather than snapping open.
        lgBtn.addEventListener('click', () => {
            const isOpen = lgBody.classList.toggle('open');
            lgBtn.classList.toggle('open', isOpen);
            // Chevron: flat (▼) when open, rotated (▶) when closed
            if (lgChevron) lgChevron.style.transform = isOpen ? '' : 'rotate(-90deg)';
        });
    }

    // ── Layer-group accordions ────────────────────────────────────────────────
    document.querySelectorAll('.toggle-group-hdr').forEach(hdr => {
        hdr.addEventListener('click', () => {
            hdr.closest('.toggle-group').classList.toggle('open');
        });
    });

    // ── Context card dismiss buttons ──────────────────────────────────────────
    ['ctx-dismiss-btn', 'ctx-got-it-btn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener('click', () => contextCards.dismiss());
    });

    // ── Layer toggles ─────────────────────────────────────────────────────────
    const _toggle = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.onchange = e => fn(e.target.checked);
    };

    _toggle('toggle-terrain', v => { splatCloud.visible = v; });
    _toggle('toggle-lanes',   v => { laneGroup.visible  = v; });
    _toggle('toggle-ports',   v => {
        // Use PortManager.setEnabled for graceful fade; fall back to group toggle
        if (window.portManager) window.portManager.setEnabled(v);
        else if (portMarkersGroup) portMarkersGroup.visible = v;
    });
    _toggle('toggle-daynight', v => { if (dayNightManager) dayNightManager.visible = v; });
    _toggle('toggle-cables',   v => {
        if (v) contextCards.show('SUBMARINE_CABLE');
    });
    _toggle('toggle-satellites', v => {
        if (aisShipsRef) aisShipsRef.forEach(s => {
            if (s.userData.isRealSatellite) {
                s.visible = v;
                if (s.userData.trail) s.userData.trail.visible = v;
            }
        });
    });
    _toggle('toggle-prediction', v => {
        if (predGroup) predGroup.visible = v;
        if (v) contextCards.show('ROUTE_PREDICTION');
    });
    _toggle('toggle-ssao',       v => { if (ssaoPass)  ssaoPass.enabled  = v; });

    // Depth of field — starts unchecked/off
    const bokehToggle = document.getElementById('toggle-optics');
    if (bokehToggle && bokehPass) {
        bokehToggle.onchange = e => { bokehPass.enabled = e.target.checked; };
        bokehPass.enabled = bokehToggle.checked;
    }

    // Cinematic director — permanently disabled per user request.
    // To re-enable, restore the update() call in main.js and uncomment below.
    // const directorToggle = document.getElementById('toggle-director');
    // if (directorToggle && cinematicDirector) {
    //     directorToggle.onchange = e => { cinematicDirector.enabled = e.target.checked; };
    //     cinematicDirector.enabled = directorToggle.checked;
    // }

    // ── Cinematic orbit ───────────────────────────────────────────────────────
    document.getElementById('present-mode').onclick = e => {
        stateRef.presentationMode = !stateRef.presentationMode;
        e.target.classList.toggle('active', stateRef.presentationMode);
        e.target.innerText = stateRef.presentationMode
            ? 'CINEMATIC ORBIT: ON' : 'CINEMATIC ORBIT: OFF';
    };

    // ── Pan / rotate mode ─────────────────────────────────────────────────────
    let isPanMode = true;
    document.getElementById('toggle-mouse-mode').onclick = e => {
        isPanMode = !isPanMode;
        if (isPanMode) {
            controls.mouseButtons.LEFT  = THREE.MOUSE.PAN;
            controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
            e.target.innerText = 'LEFT-CLICK MODE: PAN MAP';
            e.target.classList.remove('active');
        } else {
            controls.mouseButtons.LEFT  = THREE.MOUSE.ROTATE;
            controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
            e.target.innerText = 'LEFT-CLICK MODE: ROTATE MAP';
            e.target.classList.add('active');
        }
    };

    // ── Zoom buttons ──────────────────────────────────────────────────────────
    document.getElementById('btn-zoom-in').onclick = () => {
        const dir = new THREE.Vector3()
            .subVectors(camera.position, controls.target).normalize();
        camera.position.addScaledVector(dir, -40);
        controls.update();
    };
    document.getElementById('btn-zoom-out').onclick = () => {
        const dir = new THREE.Vector3()
            .subVectors(camera.position, controls.target).normalize();
        camera.position.addScaledVector(dir, 40);
        controls.update();
    };

    // ── Sector bookmarks ──────────────────────────────────────────────────────
    // Buttons now live in the top-right zoom column; active state shown in amber.
    const _sectorBtns = ['btn-na','btn-eu','btn-as'].map(id => document.getElementById(id));
    function _activateSector(btn) {
        _sectorBtns.forEach(b => b && b.classList.remove('active'));
        if (btn) btn.classList.add('active');
    }
    document.getElementById('btn-na').onclick = () => { flyToSector(-100, 40,  camera, controls, stateRef, 90); _activateSector(document.getElementById('btn-na')); };
    document.getElementById('btn-eu').onclick = () => { flyToSector(15,   50,  camera, controls, stateRef, 90); _activateSector(document.getElementById('btn-eu')); };
    document.getElementById('btn-as').onclick = () => { flyToSector(130,  20,  camera, controls, stateRef, 90); _activateSector(document.getElementById('btn-as')); };

    // ── Home button — reset to default global overview ────────────────────────
    const btnHome = document.getElementById('btn-home');
    if (btnHome) {
        btnHome.onclick = () => {
            _activateSector(null);  // clear active sector highlight
            stateRef.lockedShip       = null;
            stateRef.isFlyingToTarget = true;
            stateRef.isPanningToTerrain = true;
            stateRef.terrainTargetPos.set(0, 0, 0);
            stateRef.flightTargetPos.set(0, 250, 400);  // default camera start
        };
    }

    // ── Vessel detail panel ───────────────────────────────────────────────────
    const vdClose = document.getElementById('vd-close');
    if (vdClose) vdClose.onclick = () => {
        const ship = stateRef.lockedShip;
        if (ship && ship !== stateRef.hoveredShip) {
            resetShipHighlight(ship);
        }
        // Plan 02 — fire unlock transition before panel hides so the vignette
        // dissolve and camera tilt start simultaneously with the panel closing.
        // onUnlock sets isFlyingToTarget = true, so we must NOT reset it after.
        hideVesselDetail();
        stateRef.lockedShip = null;
        if (ship) {
            window.transitionMgr?.onUnlock(ship, stateRef);
        } else {
            stateRef.isFlyingToTarget = false;
        }
    };

    const vdTrack = document.getElementById('vd-track');
    if (vdTrack) vdTrack.onclick = () => {
        if (!_detailShip) return;
        if (stateRef.lockedShip === _detailShip) {
            if (stateRef.lockedShip !== stateRef.hoveredShip) {
                resetShipHighlight(stateRef.lockedShip);
            }
            stateRef.lockedShip       = null;
            stateRef.isFlyingToTarget = false;
            vdTrack.innerText = 'LOCK TRACK';
            vdTrack.classList.remove('active');
        } else {
            if (stateRef.lockedShip && stateRef.lockedShip !== _detailShip) {
                resetShipHighlight(stateRef.lockedShip);
            }
            stateRef.lockedShip = _detailShip;
            highlightShip(stateRef.lockedShip);
            const dir = new THREE.Vector3()
                .subVectors(camera.position, _detailShip.position).normalize();
            stateRef.flightTargetPos
                .copy(_detailShip.position).add(dir.multiplyScalar(35));
            if (stateRef.flightTargetPos.y < 5) stateRef.flightTargetPos.y = 5;
            stateRef.isFlyingToTarget = true;
            vdTrack.innerText = 'UNLOCK TRACK';
            vdTrack.classList.add('active');
        }
    };

    // ── Search ────────────────────────────────────────────────────────────────
    const searchInput = document.getElementById('search-input');
    if (searchInput && aisShipsRef) {
        searchInput.addEventListener('input', () => {
            _searchQuery = searchInput.value;
            applySearchFilter(aisShipsRef);
        });
        searchInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                searchInput.value = '';
                _searchQuery = '';
                applySearchFilter(aisShipsRef);
                searchInput.blur();
            }
        });
    }

    // ── Alert zone (place / clear, if buttons exist in HTML) ─────────────────
    const btnPlace = document.getElementById('btn-place-zone');
    const btnClear = document.getElementById('btn-clear-zone');

    if (btnPlace) {
        btnPlace.addEventListener('click', () => {
            if (_alertZone) return;
            _zoneWaiting = !_zoneWaiting;
            btnPlace.innerText = _zoneWaiting ? 'CLICK MAP TO PLACE...' : 'PLACE ALERT ZONE';
            btnPlace.classList.toggle('active', _zoneWaiting);
        });
    }
    if (btnClear && scene) {
        btnClear.addEventListener('click', () => {
            _clearZoneMeshes(scene);
            _zoneWaiting = false;
            if (btnPlace) {
                btnPlace.innerText = 'PLACE ALERT ZONE';
                btnPlace.classList.remove('active');
            }
        });
    }

    // ── Ship list panel ───────────────────────────────────────────────────────
    const shipListToggle = document.getElementById('ship-list-toggle');
    const shipListPanel  = document.getElementById('ship-list-panel');
    const shipListClose  = document.getElementById('ship-list-close');

    if (shipListToggle && shipListPanel) {
        shipListToggle.onclick = () => {
            const visible = shipListPanel.style.display !== 'none';
            shipListPanel.style.display = visible ? 'none' : 'block';
            if (!visible && aisShipsRef) {
                refreshShipList(aisShipsRef, stateRef, camera, controls);
            }
        };
    }
    if (shipListClose && shipListPanel) {
        shipListClose.onclick = () => { shipListPanel.style.display = 'none'; };
    }

    // ── Flight list panel ─────────────────────────────────────────────────────
    const flightListToggle = document.getElementById('flight-list-toggle');
    const flightListPanel  = document.getElementById('flight-list-panel');
    const flightListClose  = document.getElementById('flight-list-close');

    if (flightListToggle && flightListPanel) {
        flightListToggle.onclick = () => {
            const visible = flightListPanel.style.display !== 'none';
            flightListPanel.style.display = visible ? 'none' : 'block';
            if (!visible && aisShipsRef) {
                refreshFlightList(aisShipsRef, stateRef, camera, controls);
            }
        };
    }
    if (flightListClose && flightListPanel) {
        flightListClose.onclick = () => { flightListPanel.style.display = 'none'; };
    }

    // ── City list panel ───────────────────────────────────────────────────────
    const cityListToggle = document.getElementById('city-list-toggle');
    const cityListPanel  = document.getElementById('city-list-panel');
    const cityListClose  = document.getElementById('city-list-close');

    if (cityListToggle && cityListPanel) {
        cityListToggle.onclick = () => {
            const visible = cityListPanel.style.display !== 'none';
            cityListPanel.style.display = visible ? 'none' : 'block';
            cityListToggle.classList.toggle('active', !visible);
            if (!visible) _populateCityList(cityListPanel, camera, controls, stateRef);
        };
    }
    if (cityListClose && cityListPanel) {
        cityListClose.onclick = () => {
            cityListPanel.style.display = 'none';
            if (cityListToggle) cityListToggle.classList.remove('active');
        };
    }

    // ── AI Co-Pilot panel ─────────────────────────────────────────────────────
    const copilotToggle = document.getElementById('copilot-toggle');
    const copilotPanel  = document.getElementById('copilot-panel');
    if (copilotToggle && copilotPanel) {
        copilotToggle.onclick = () => {
            const visible = copilotPanel.style.display !== 'none' &&
                            copilotPanel.style.display !== '';
            copilotPanel.style.display = visible ? 'none' : 'block';
        };
    }

    // GPU backend label
    const gpuLabel = document.getElementById('gpu-backend');
    if (gpuLabel) gpuLabel.innerText = 'WEBGL2';
}

// ── Settings panel ────────────────────────────────────────────────────────────
export function setupSettingsPanel(weatherManager) {
    const toggle   = document.getElementById('settings-toggle');
    const panel    = document.getElementById('settings-panel');
    const closeBtn = document.getElementById('settings-close');

    if (!toggle || !panel) return;

    // Open / close
    toggle.addEventListener('click', () => {
        const open = panel.classList.toggle('open');
        toggle.classList.toggle('active', open);
        if (open) _refreshOwmState(weatherManager);
    });
    if (closeBtn) closeBtn.addEventListener('click', () => {
        panel.classList.remove('open');
        toggle.classList.remove('active');
    });

    // Populate input with saved key on first open
    _refreshOwmState(weatherManager);

    // Connect button
    const connectBtn  = document.getElementById('owm-connect-btn');
    const keyInput    = document.getElementById('owm-key-input');
    const feedbackEl  = document.getElementById('owm-feedback');

    if (connectBtn && keyInput) {
        connectBtn.addEventListener('click', async () => {
            // If already connected, act as disconnect
            if (weatherManager.isConnected) {
                weatherManager.clearKey();
                keyInput.value = '';
                _refreshOwmState(weatherManager);
                return;
            }

            const key = keyInput.value.trim();
            if (!key) {
                _setFeedback(feedbackEl, 'Enter an API key first', 'var(--orange)');
                return;
            }

            connectBtn.innerText     = 'Validating…';
            connectBtn.disabled      = true;
            _setFeedback(feedbackEl, '', '');

            try {
                await weatherManager.setKey(key);
                _refreshOwmState(weatherManager);
                _setFeedback(feedbackEl, '✓ Connected — live storm data active', '#40ffaa');
            } catch (err) {
                _refreshOwmState(weatherManager);
                _setFeedback(feedbackEl, `✕ ${err.message}`, 'var(--orange)');
            } finally {
                connectBtn.disabled = false;
            }
        });

        // Enter key submits
        keyInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') connectBtn.click();
        });
    }
}

function _refreshOwmState(weatherManager) {
    const dot        = document.getElementById('owm-dot');
    const statusText = document.getElementById('owm-status-text');
    const connectBtn = document.getElementById('owm-connect-btn');
    const keyInput   = document.getElementById('owm-key-input');

    const connected = weatherManager.isConnected;

    if (dot) {
        dot.className = 'cfg-dot' + (connected ? ' live' : '');
    }
    if (statusText) {
        statusText.innerText  = connected ? 'LIVE' : 'OFFLINE';
        statusText.style.color = connected ? '#40ffaa' : '#4a6b84';
    }
    if (connectBtn) {
        connectBtn.innerText = connected ? 'Disconnect' : 'Connect';
        connectBtn.className = 'cfg-btn' + (connected ? ' cfg-btn-disconnect' : '');
    }
    // Show masked key placeholder if connected
    if (keyInput && connected && !keyInput.value) {
        keyInput.placeholder = '••••••••••••••••  (saved)';
    }
}

function _setFeedback(el, msg, color) {
    if (!el) return;
    el.innerText   = msg;
    el.style.color = color;
}

// ── Mouse move ────────────────────────────────────────────────────────────────
export function onMouseMove(event, deps) {
    const { mouse, tooltipEl, raycaster, camera, boardPlane, hoverReticle, stateRef } = deps;

    mouse.x = ( event.clientX / window.innerWidth)  * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    if (tooltipEl) {
        tooltipEl.style.left = (event.clientX + 15) + 'px';
        tooltipEl.style.top  = (event.clientY + 15) + 'px';
    }

    if (boardPlane && hoverReticle) {
        raycaster.setFromCamera(mouse, camera);
        const hits = [];
        boardPlane.raycast(raycaster, hits);

        if (hits.length > 0 && !stateRef.hoveredShip) {
            const pt = hits[0].point;
            hoverReticle.position.set(pt.x, pt.y + 0.5, pt.z);
            hoverReticle.visible = true;

            const lon    = (pt.x / (MAP_WIDTH  / 2.0)) * 180.0;
            const mercY  = -(pt.z / (MAP_HEIGHT / 2.0)) * Math.PI;
            const lat    = (2.0 * Math.atan(Math.exp(mercY)) - Math.PI / 2.0) * (180.0 / Math.PI);
            const hM     = getTrueElevation(pt.x, pt.z);
            const depStr = hM < 0 ? Math.floor(hM) : '0';

            document.getElementById('coord-lat').innerText = lat.toFixed(4);
            document.getElementById('coord-lon').innerText = lon.toFixed(4);
            document.getElementById('coord-dep').innerText = depStr;

            // Place alert zone on click if waiting
            if (_zoneWaiting) {
                // handled in onClick
            }
        } else {
            hoverReticle.visible = false;
        }
    }
}

// ── Double click ──────────────────────────────────────────────────────────────
export function onDoubleClick(event, deps) {
    const { mouse, raycaster, camera, boardPlane, controls, stateRef } = deps;
    if (event.button !== 0 || stateRef.hoveredShip) return;

    raycaster.setFromCamera(mouse, camera);
    const hits = [];
    boardPlane.raycast(raycaster, hits);

    if (hits.length > 0) {
        const pt = hits[0].point;
        stateRef.terrainTargetPos.copy(pt);
        stateRef.isPanningToTerrain = true;

        const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
        stateRef.flightTargetPos.copy(pt).add(dir.multiplyScalar(60));
        if (stateRef.flightTargetPos.y < 15) stateRef.flightTargetPos.y = 15;

        stateRef.isFlyingToTarget = true;
        stateRef.lockedShip = null;
    }
}

// ── Click ─────────────────────────────────────────────────────────────────────
export function onClick(event, deps) {
    const { mouse, raycaster, camera, controls, boardPlane, stateRef, scene, hasInteracted } = deps;
    if (event.button !== 0) return;

    // Hard guard: if this is somehow the very first interaction (e.g. mouse was
    // initialized at (0,0) and a stale hoveredShip is already set from startup),
    // clear hoveredShip and bail — don't lock a ship the user never intended to select.
    if (hasInteracted && !hasInteracted()) {
        stateRef.hoveredShip = null;
        return;
    }

    // Zone placement
    if (_zoneWaiting && boardPlane && scene) {
        raycaster.setFromCamera(mouse, camera);
        const hits = [];
        boardPlane.raycast(raycaster, hits);
        if (hits.length > 0) {
            const center = hits[0].point.clone();
            const radius = 18;

            _clearZoneMeshes(scene);

            const diskGeo  = new THREE.CircleGeometry(radius, 64);
            diskGeo.rotateX(-Math.PI / 2);
            const diskMat  = new THREE.MeshBasicMaterial({
                color: 0xff4400, transparent: true, opacity: 0.08,
                depthWrite: false, side: THREE.DoubleSide,
            });
            const disk = new THREE.Mesh(diskGeo, diskMat);
            disk.position.copy(center).setY(center.y + 0.3);
            scene.add(disk);

            const ringGeo = new THREE.RingGeometry(radius - 0.4, radius, 64);
            ringGeo.rotateX(-Math.PI / 2);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0xff4400, transparent: true, opacity: 0.6,
                depthWrite: false, side: THREE.DoubleSide,
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.position.copy(center).setY(center.y + 0.35);
            scene.add(ring);

            _alertZone   = { mesh: disk, ringMesh: ring, center, radius };
            _zoneWaiting = false;
            contextCards.show('ALERT_ZONE');

            const btnPlace = document.getElementById('btn-place-zone');
            if (btnPlace) {
                btnPlace.innerText = 'PLACE ALERT ZONE';
                btnPlace.classList.remove('active');
            }
        }
        return;
    }


    // ── Chokepoint landmark click ─────────────────────────────────────────────
    // Check hit discs before vessel test so a click on a chokepoint glyph that
    // overlaps a vessel prefers the chokepoint (user is clicking the landmark).
    if (window.chokepointHitMeshes?.length) {
        raycaster.setFromCamera(mouse, camera);
        const cpHits = raycaster.intersectObjects(window.chokepointHitMeshes);
        if (cpHits.length > 0) {
            const cpData = cpHits[0].object.userData.chokepointData;
            if (cpData) {
                contextCards.show('CHOKEPOINT');
                // Fly tactical camera to the chokepoint center
                const hit = cpHits[0].point;
                stateRef.terrainTargetPos.set(hit.x, 0, hit.z);
                stateRef.isPanningToTerrain = true;

            }
            return;
        }
    }

    if (stateRef.hoveredShip) {
        if (stateRef.lockedShip === stateRef.hoveredShip) {
            // Re-clicking the locked vessel deselects it — dissolve the focus
            // vignette and close the panel (same unlock path as the close button).
            const prev = stateRef.lockedShip;
            stateRef.lockedShip = null;
            hideVesselDetail();
            window.transitionMgr?.onUnlock(prev, stateRef);
            const ttId = document.getElementById('tt-id');
            if (ttId) ttId.innerText = 'ASSET ID: ' + stateRef.hoveredShip.userData.id;
        } else {
            stateRef.lockedShip = stateRef.hoveredShip;
            showVesselDetail(stateRef.lockedShip, camera, controls, stateRef);

            // ── First-encounter context cards ─────────────────────────────────
            const cls = stateRef.lockedShip.userData?.class ?? '';
            const isDark = stateRef.lockedShip.userData?.isDark === true;
            if      (isDark)                                          contextCards.show('DARK_VESSEL');
            else if (cls === 'HOSTILE')                               contextCards.show('HOSTILE');
            else if (cls === 'SUBMARINE')                             contextCards.show('SUBMARINE');
            else if (cls === 'ORBITAL')                               contextCards.show('ORBITAL');
            else if (['FIGHTER','AWACS','DRONE'].includes(cls))       contextCards.show('FIGHTER');

            const ttId = document.getElementById('tt-id');
            if (ttId) ttId.innerText = '[LOCKED] ' + stateRef.hoveredShip.userData.id;

            const dir = new THREE.Vector3()
                .subVectors(camera.position, stateRef.lockedShip.position).normalize();
            stateRef.flightTargetPos
                .copy(stateRef.lockedShip.position).add(dir.multiplyScalar(35));
            if (stateRef.flightTargetPos.y < 5) stateRef.flightTargetPos.y = 5;
            stateRef.isFlyingToTarget = true;
        }
    } else {
        // Clicked empty water/land — if a vessel was focused, release it:
        // dissolve the vignette, undim, and close the panel.
        const prev = stateRef.lockedShip;
        stateRef.lockedShip = null;
        if (prev) {
            hideVesselDetail();
            window.transitionMgr?.onUnlock(prev, stateRef);
        } else {
            stateRef.isFlyingToTarget = false;
        }
    }
}

// ── Raycasting tick ───────────────────────────────────────────────────────────
//
// Two-stage hit detection for Fitts's Law compliance:
//
//   Stage 1 — Screen-space proximity (primary, runs every frame)
//     Projects every ship's world position to canvas pixels. The nearest ship
//     within HIT_RADIUS_PX is selected regardless of rendered mesh size.
//     This gives every entity a large "invisible hitbox" and implements
//     snap-to targeting: the cursor magnetically locks to the closest node
//     as soon as it enters the snap radius.
//
//   Stage 2 — Geometry raycast (fallback)
//     Only fires when Stage 1 finds nothing. Handles edge cases where a
//     large ship model extends significantly beyond its origin point.

// Snap radius in CSS pixels. 40px gives reliable selection on dense scenes.
const HIT_RADIUS_PX = 40;

// Scratch vector — reused each frame to avoid allocation in the hot path.
const _snapVec = new THREE.Vector3();

// Cache tooltip sub-elements once after first call.
let _ttId = null, _ttClass = null, _ttSpd = null, _ttName = null, _ttHdg = null;
let _ttWind = null, _ttWindRow = null, _ttWindArrow = null;
function _ensureTTRefs() {
    if (!_ttId)        _ttId        = document.getElementById('tt-id');
    if (!_ttClass)     _ttClass     = document.getElementById('tt-class');
    if (!_ttSpd)       _ttSpd       = document.getElementById('tt-spd');
    if (!_ttName)      _ttName      = document.getElementById('tt-name');
    if (!_ttHdg)       _ttHdg       = document.getElementById('tt-hdg');
    if (!_ttWind)      _ttWind      = document.getElementById('tt-wind');
    if (!_ttWindRow)   _ttWindRow   = document.getElementById('tt-wind-row');
    if (!_ttWindArrow) _ttWindArrow = document.getElementById('tt-wind-arrow');
}

// Compass abbreviation from degrees-from-north (0=N, 90=E, etc.)
const _COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function _compassFromDeg(deg) {
    return _COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

function _fillTooltip(shipGroup, stateRef) {
    _ensureTTRefs();
    const ud = shipGroup.userData;

    // Vessel name — prefer displayName, fall back to MMSI/ICAO
    const name = ud.displayName && ud.displayName !== 'UNKNOWN'
        ? ud.displayName
        : (ud.id ?? '—');
    if (_ttName) _ttName.innerText = name;

    // Lock/hover state shown in header
    if (_ttId) _ttId.innerText = stateRef.lockedShip === shipGroup
        ? '◉ LOCKED'
        : (ud.isDark ? '◉ AIS DARK' : '◉ LIVE');

    if (_ttClass) {
        _ttClass.innerText   = ud.class ?? '—';
        _ttClass.style.color = ud.isDark ? '#ff1744' : (ud.htmlColor ?? 'var(--cyan)');
    }

    const spd = ud.speedKts != null ? ud.speedKts.toFixed(1)
              : ud.speedKmS != null ? (ud.speedKmS * 1.944).toFixed(1)
              : '0';
    if (_ttSpd) _ttSpd.innerText = spd;

    if (_ttHdg) _ttHdg.innerText = ud.headingDeg != null
        ? Math.round(ud.headingDeg) + '°'
        : '—';

    // ── Wind chip ──────────────────────────────────────────────────────────
    // Looks up the GFS wind field at the vessel's lat/lon. If the vessel has
    // a heading we classify the wind as head / tail / crosswind; otherwise
    // we just show its speed + compass direction.
    const wm = window.gfsWindManager;
    if (_ttWind && _ttWindRow && wm && ud.latDeg != null && ud.lonDeg != null) {
        const headed = ud.headingDeg != null && (ud.speedKts ?? 0) > 0.3;
        let label, color, arrowDeg, hideArrow = false;
        if (headed) {
            const rw = wm.relativeWind(ud.lonDeg, ud.latDeg, ud.headingDeg);
            if (rw.type === 'calm') {
                label = 'CALM';
                color = '#7fb6cf';
                hideArrow = true;
            } else {
                const tag =
                    rw.type === 'headwind'             ? 'HEADWIND'   :
                    rw.type === 'tailwind'             ? 'TAILWIND'   :
                    rw.type === 'crosswind-port'       ? 'CROSS PORT' :
                                                         'CROSS STBD';
                color =
                    rw.type === 'headwind' ? '#ff8c5a' :
                    rw.type === 'tailwind' ? '#5be3a4' :
                                             '#ffd95a';
                label = `${tag} ${rw.speed.toFixed(1)} m/s`;
                // Arrow points TO where the wind is going, in the vessel's
                // frame (vessel always faces "up" in the arrow). +Y in SVG
                // is down, so flip the sign.
                arrowDeg = rw.angleOff;
            }
        } else {
            const w = wm.windAt(ud.lonDeg, ud.latDeg);
            if (w.speed < 0.5) {
                label = 'CALM';
                color = '#7fb6cf';
                hideArrow = true;
            } else {
                label = `${w.speed.toFixed(1)} m/s ${_compassFromDeg(w.dirTo)}`;
                color = '#8ce6ff';
                // No vessel heading — orient the arrow to absolute compass
                // direction (0° = north = up).
                arrowDeg = w.dirTo;
            }
        }
        _ttWind.innerText = label;
        _ttWind.style.color = color;
        if (_ttWindArrow) {
            _ttWindArrow.style.color   = color;
            _ttWindArrow.style.display = hideArrow ? 'none' : 'inline-block';
            if (!hideArrow) _ttWindArrow.style.transform = `rotate(${arrowDeg}deg)`;
        }
        _ttWindRow.style.display = 'flex';
    } else if (_ttWindRow) {
        _ttWindRow.style.display = 'none';
    }
}

export function tickRaycasting(deps) {
    const { raycaster, mouse, camera, aisShips, tooltipEl, stateRef } = deps;
    if (!aisShips || aisShips.length === 0) return;

    // ── Stage 1: Screen-space proximity / snap-to ─────────────────────────────
    const W  = window.innerWidth;
    const H  = window.innerHeight;
    // Convert NDC mouse (-1..1) to canvas pixels
    const mx = (mouse.x + 1) * 0.5 * W;
    const my = (1 - mouse.y) * 0.5 * H;   // Y is flipped in NDC

    let snapTarget = null;
    let snapDist   = HIT_RADIUS_PX;        // acts as the initial maximum

    for (let i = 0, n = aisShips.length; i < n; i++) {
        const ship = aisShips[i];
        if (!ship.userData?.id) continue;
        // Project all registered ships regardless of visibility.
        // Clustered ships are invisible but their world position is still valid —
        // projecting it to screen space lets the user click them by proximity.
        // The _snapVec.z > 1 guard below handles ships behind the camera.

        // Project world position → NDC → canvas pixels
        _snapVec.copy(ship.position).project(camera);
        if (_snapVec.z > 1) continue;  // behind the camera frustum

        const sx   = (_snapVec.x + 1) * 0.5 * W;
        const sy   = (1 - _snapVec.y) * 0.5 * H;
        const dist = Math.hypot(sx - mx, sy - my);

        if (dist < snapDist) { snapDist = dist; snapTarget = ship; }
    }

    if (snapTarget) {
        // Snap acquired — apply hover state and show tooltip
        if (stateRef.hoveredShip !== snapTarget) {
            if (stateRef.hoveredShip) resetShipHighlight(stateRef.hoveredShip);
            stateRef.hoveredShip = snapTarget;
            highlightShip(snapTarget);
        }
        _fillTooltip(snapTarget, stateRef);
        if (tooltipEl) tooltipEl.style.display = 'block';
        document.body.style.cursor = 'crosshair';   // precision-mode feedback
        return;
    }

    // ── Stage 2: Geometry raycast fallback ────────────────────────────────────
    // Only runs when no entity is within the snap radius.  Catches large models
    // whose visible geometry extends past their group origin (e.g. carriers).
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(aisShips, true);

    if (hits.length > 0) {
        let obj = hits[0].object;
        while (obj && !obj.userData.id && obj.parent) obj = obj.parent;
        const shipGroup = (obj && obj.userData.id) ? obj : null;

        if (shipGroup) {
            if (stateRef.hoveredShip !== shipGroup) {
                if (stateRef.hoveredShip) resetShipHighlight(stateRef.hoveredShip);
                stateRef.hoveredShip = shipGroup;
                highlightShip(shipGroup);
            }
            _fillTooltip(shipGroup, stateRef);
            if (tooltipEl) tooltipEl.style.display = 'block';
            document.body.style.cursor = 'crosshair';
            return;
        }
    }

    // ── No hit — clear hover state ────────────────────────────────────────────
    if (stateRef.hoveredShip) {
        resetShipHighlight(stateRef.hoveredShip);
        stateRef.hoveredShip = null;
        if (tooltipEl) tooltipEl.style.display = 'none';
    }
    document.body.style.cursor = '';   // restore default arrow
}

// ── Sector Search command palette ──────────────────────────────────────────────
// Opens with the ⌕ toolbar button or the "/" key.
// Searches:
//   • Cities (from cityManager.js CITIES list) — fuzzy name match
//   • Named geographic regions — predefined lat/lon
//   • Raw coordinates — "lat, lon" syntax  (e.g. "35.6, 139.7")
//
// Results show in a scrollable list; arrow-up/down moves the cursor,
// Enter or click flies the camera to the selection, Escape closes.

const NAMED_REGIONS = [
    // ── Strategic waterways ───────────────────────────────────────────────────
    { name: 'Strait of Hormuz',    lat:  26.6,   lon:  56.2,   icon: '⬡', type: 'region' },
    { name: 'Strait of Malacca',   lat:   2.5,   lon: 101.5,   icon: '⬡', type: 'region' },
    { name: 'Strait of Gibraltar', lat:  35.9,   lon:  -5.6,   icon: '⬡', type: 'region' },
    { name: 'Bab-el-Mandeb',       lat:  12.5,   lon:  43.5,   icon: '⬡', type: 'region' },
    { name: 'Suez Canal',          lat:  30.5,   lon:  32.3,   icon: '⬡', type: 'region' },
    { name: 'Panama Canal',        lat:   9.1,   lon: -79.7,   icon: '⬡', type: 'region' },
    { name: 'Bosphorus',           lat:  41.1,   lon:  29.0,   icon: '⬡', type: 'region' },
    { name: 'English Channel',     lat:  50.5,   lon:   1.0,   icon: '⬡', type: 'region' },
    { name: 'Danish Straits',      lat:  56.0,   lon:  10.5,   icon: '⬡', type: 'region' },
    { name: 'Taiwan Strait',       lat:  24.5,   lon: 120.5,   icon: '⬡', type: 'region' },
    { name: 'Luzon Strait',        lat:  20.0,   lon: 121.5,   icon: '⬡', type: 'region' },
    { name: 'Cape of Good Hope',   lat: -34.4,   lon:  18.5,   icon: '⬡', type: 'region' },
    { name: 'Cape Horn',           lat: -55.9,   lon: -67.3,   icon: '⬡', type: 'region' },
    { name: 'Drake Passage',       lat: -58.0,   lon: -65.0,   icon: '⬡', type: 'region' },
    // ── Ocean basins ─────────────────────────────────────────────────────────
    { name: 'North Atlantic',      lat:  40.0,   lon: -35.0,   icon: '⬡', type: 'region' },
    { name: 'North Pacific',       lat:  40.0,   lon: 170.0,   icon: '⬡', type: 'region' },
    { name: 'South China Sea',     lat:  12.0,   lon: 115.0,   icon: '⬡', type: 'region' },
    { name: 'Persian Gulf',        lat:  26.5,   lon:  51.5,   icon: '⬡', type: 'region' },
    { name: 'Mediterranean Sea',   lat:  36.0,   lon:  15.0,   icon: '⬡', type: 'region' },
    { name: 'Red Sea',             lat:  20.0,   lon:  38.0,   icon: '⬡', type: 'region' },
    { name: 'Gulf of Aden',        lat:  12.0,   lon:  46.0,   icon: '⬡', type: 'region' },
    { name: 'Indian Ocean',        lat: -20.0,   lon:  80.0,   icon: '⬡', type: 'region' },
    { name: 'South Atlantic',      lat: -30.0,   lon: -15.0,   icon: '⬡', type: 'region' },
    { name: 'Baltic Sea',          lat:  58.0,   lon:  20.0,   icon: '⬡', type: 'region' },
    { name: 'Black Sea',           lat:  43.0,   lon:  34.0,   icon: '⬡', type: 'region' },
    { name: 'Arabian Sea',         lat:  15.0,   lon:  65.0,   icon: '⬡', type: 'region' },
    { name: 'Bay of Bengal',       lat:  15.0,   lon:  90.0,   icon: '⬡', type: 'region' },
    { name: 'Sea of Japan',        lat:  40.0,   lon: 135.0,   icon: '⬡', type: 'region' },
    { name: 'Caspian Sea',         lat:  42.0,   lon:  52.0,   icon: '⬡', type: 'region' },
    { name: 'Arctic',              lat:  82.0,   lon:   0.0,   icon: '⬡', type: 'region' },
    { name: 'Antarctic',           lat: -80.0,   lon:   0.0,   icon: '⬡', type: 'region' },
    { name: 'Horn of Africa',      lat:  11.0,   lon:  50.0,   icon: '⬡', type: 'region' },
    { name: 'Mariana Trench',      lat:  11.4,   lon: 142.2,   icon: '⬡', type: 'region' },
    { name: 'Great Barrier Reef',  lat: -18.3,   lon: 147.7,   icon: '⬡', type: 'region' },
    { name: 'Sahara Desert',       lat:  23.0,   lon:  12.0,   icon: '⬡', type: 'region' },
    { name: 'Amazon Basin',        lat:  -3.5,   lon: -62.0,   icon: '⬡', type: 'region' },
    { name: 'Himalaya Range',      lat:  28.0,   lon:  86.9,   icon: '⬡', type: 'region' },
];

// ── World Port Index — major global ports by throughput / strategic importance ──
// Fly-to altitude for ports uses 25 (close tactical zoom) to see berths.
const NAMED_PORTS = [
    // Europe
    { name: 'Rotterdam',           lat:  51.90,  lon:   4.48,  icon: '⚓', type: 'port' },
    { name: 'Antwerp',             lat:  51.23,  lon:   4.40,  icon: '⚓', type: 'port' },
    { name: 'Hamburg',             lat:  53.55,  lon:   9.99,  icon: '⚓', type: 'port' },
    { name: 'Algeciras',           lat:  36.13,  lon:  -5.44,  icon: '⚓', type: 'port' },
    { name: 'Piraeus',             lat:  37.94,  lon:  23.62,  icon: '⚓', type: 'port' },
    { name: 'Felixstowe',          lat:  51.96,  lon:   1.35,  icon: '⚓', type: 'port' },
    { name: 'Valencia',            lat:  39.45,  lon:  -0.30,  icon: '⚓', type: 'port' },
    { name: 'Barcelona',           lat:  41.35,  lon:   2.16,  icon: '⚓', type: 'port' },
    { name: 'Marseille',           lat:  43.30,  lon:   5.37,  icon: '⚓', type: 'port' },
    { name: 'Genoa',               lat:  44.41,  lon:   8.92,  icon: '⚓', type: 'port' },
    { name: 'Gdansk',              lat:  54.35,  lon:  18.67,  icon: '⚓', type: 'port' },
    { name: 'Bremerhaven',         lat:  53.55,  lon:   8.58,  icon: '⚓', type: 'port' },
    // Middle East / Africa
    { name: 'Jebel Ali',           lat:  24.98,  lon:  55.07,  icon: '⚓', type: 'port' },
    { name: 'Port Said',           lat:  31.27,  lon:  32.30,  icon: '⚓', type: 'port' },
    { name: 'Aden',                lat:  12.79,  lon:  44.99,  icon: '⚓', type: 'port' },
    { name: 'Djibouti',            lat:  11.59,  lon:  43.14,  icon: '⚓', type: 'port' },
    { name: 'Mombasa',             lat:  -4.05,  lon:  39.67,  icon: '⚓', type: 'port' },
    { name: 'Durban',              lat: -29.87,  lon:  31.03,  icon: '⚓', type: 'port' },
    { name: 'Bandar Abbas',        lat:  27.18,  lon:  56.27,  icon: '⚓', type: 'port' },
    { name: 'Jubail',              lat:  26.95,  lon:  49.65,  icon: '⚓', type: 'port' },
    // Asia-Pacific
    { name: 'Shanghai',            lat:  31.23,  lon: 121.47,  icon: '⚓', type: 'port' },
    { name: 'Singapore',           lat:   1.28,  lon: 103.83,  icon: '⚓', type: 'port' },
    { name: 'Ningbo',              lat:  29.87,  lon: 121.55,  icon: '⚓', type: 'port' },
    { name: 'Shenzhen',            lat:  22.53,  lon: 114.05,  icon: '⚓', type: 'port' },
    { name: 'Guangzhou',           lat:  23.11,  lon: 113.25,  icon: '⚓', type: 'port' },
    { name: 'Busan',               lat:  35.10,  lon: 129.04,  icon: '⚓', type: 'port' },
    { name: 'Hong Kong',           lat:  22.29,  lon: 114.16,  icon: '⚓', type: 'port' },
    { name: 'Qingdao',             lat:  36.07,  lon: 120.33,  icon: '⚓', type: 'port' },
    { name: 'Tianjin',             lat:  38.99,  lon: 117.72,  icon: '⚓', type: 'port' },
    { name: 'Yokohama',            lat:  35.45,  lon: 139.65,  icon: '⚓', type: 'port' },
    { name: 'Tokyo Bay',           lat:  35.55,  lon: 139.78,  icon: '⚓', type: 'port' },
    { name: 'Tanjung Pelepas',     lat:   1.36,  lon: 103.55,  icon: '⚓', type: 'port' },
    { name: 'Port Klang',          lat:   3.00,  lon: 101.39,  icon: '⚓', type: 'port' },
    { name: 'Colombo',             lat:   6.93,  lon:  79.86,  icon: '⚓', type: 'port' },
    { name: 'Surabaya',            lat:  -7.22,  lon: 112.73,  icon: '⚓', type: 'port' },
    { name: 'Laem Chabang',        lat:  13.08,  lon: 100.88,  icon: '⚓', type: 'port' },
    { name: 'Kaohsiung',           lat:  22.62,  lon: 120.27,  icon: '⚓', type: 'port' },
    { name: 'Vladivostok',         lat:  43.12,  lon: 131.89,  icon: '⚓', type: 'port' },
    // Americas
    { name: 'Los Angeles',         lat:  33.73,  lon: -118.27, icon: '⚓', type: 'port' },
    { name: 'Long Beach',          lat:  33.75,  lon: -118.22, icon: '⚓', type: 'port' },
    { name: 'New York',            lat:  40.65,  lon:  -74.07, icon: '⚓', type: 'port' },
    { name: 'Houston',             lat:  29.73,  lon:  -95.27, icon: '⚓', type: 'port' },
    { name: 'Savannah',            lat:  31.98,  lon:  -81.09, icon: '⚓', type: 'port' },
    { name: 'Seattle',             lat:  47.60,  lon: -122.33, icon: '⚓', type: 'port' },
    { name: 'Vancouver',           lat:  49.29,  lon: -123.11, icon: '⚓', type: 'port' },
    { name: 'Santos',              lat: -23.95,  lon:  -46.33, icon: '⚓', type: 'port' },
    { name: 'Colon',               lat:   9.36,  lon:  -79.90, icon: '⚓', type: 'port' },
    { name: 'Cartagena',           lat:  10.39,  lon:  -75.52, icon: '⚓', type: 'port' },
    { name: 'Callao',              lat:  -12.05, lon:  -77.14, icon: '⚓', type: 'port' },
    { name: 'Buenos Aires',        lat:  -34.60, lon:  -58.37, icon: '⚓', type: 'port' },
];

export function setupSectorSearch(camera, controls, stateRef) {
    const overlay     = document.getElementById('sector-search-overlay');
    const input       = document.getElementById('sector-search-input');
    const resultsEl   = document.getElementById('sector-search-results');
    const toggleBtn   = document.getElementById('sector-search-toggle');
    const countEl     = document.getElementById('sector-search-count');
    const filterBtns  = document.querySelectorAll('.ss-filter');
    if (!overlay || !input || !resultsEl) return;

    let _query        = '';
    let _results      = [];
    let _cursor       = -1;
    let _activeFilter = 'all';   // 'all' | 'city' | 'region' | 'coord'

    // ── Filter pill wiring ────────────────────────────────────────────────────
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            _activeFilter = btn.dataset.filter;
            filterBtns.forEach(b => b.classList.toggle('active', b === btn));
            _cursor = -1;
            render();
        });
    });

    // ── Build unified search corpus ───────────────────────────────────────────
    // CITIES is imported from cityManager.js at the top of this file
    const corpus = [
        ...CITIES.map(c => ({
            type:    'city',
            name:    c.name,
            sub:     `Tier ${c.tier}  ·  Pop ${c.pop}M`,
            lat:     c.lat,
            lon:     c.lon,
            icon:    c.tier === 1 ? '●' : c.tier === 2 ? '◦' : '·',
            tag:     'CITY',
            flyAlt:  40,
        })),
        ...NAMED_REGIONS.map(r => ({
            type:    'region',
            name:    r.name,
            sub:     `${r.lat.toFixed(1)}°  ${r.lon.toFixed(1)}°`,
            lat:     r.lat,
            lon:     r.lon,
            icon:    '⬡',
            tag:     'REGION',
            flyAlt:  90,
        })),
        ...NAMED_PORTS.map(p => ({
            type:    'port',
            name:    p.name,
            sub:     `PORT  ·  ${p.lat.toFixed(2)}°  ${p.lon.toFixed(2)}°`,
            lat:     p.lat,
            lon:     p.lon,
            icon:    '⚓',
            tag:     'PORT',
            flyAlt:  30,   // close zoom to see berths and vessel activity
        })),
    ];

    // ── Parse raw coordinate input ("35.6, 139.7" or "35.6 139.7") ───────────
    function parseCoord(q) {
        const m = q.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
        if (!m) return null;
        const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
        return { lat, lon };
    }

    // ── Fuzzy match: all corpus items whose name includes the query ───────────
    function getResults(q) {
        const qLow  = q.toLowerCase().trim();
        const coord = parseCoord(qLow);

        // Start from full corpus, apply name filter first
        let pool = qLow
            ? corpus.filter(item => item.name.toLowerCase().includes(qLow))
            : corpus.slice(0, 80);   // show broader set when empty so filter pills are useful

        // Apply type filter pill
        if (_activeFilter !== 'all') {
            pool = pool.filter(item => item.type === _activeFilter);
        }

        // Prepend raw-coordinate result if query looks like a coord
        if (coord && (_activeFilter === 'all' || _activeFilter === 'coord')) {
            pool.unshift({
                type: 'coord',
                name: `${coord.lat.toFixed(4)}°, ${coord.lon.toFixed(4)}°`,
                sub:  'Coordinate',
                lat:  coord.lat,
                lon:  coord.lon,
                icon: '+',
                tag:  'COORD',
            });
        }

        return pool.slice(0, 16);
    }

    // ── Render results list ───────────────────────────────────────────────────
    function render() {
        _results = getResults(_query);
        if (_cursor >= _results.length) _cursor = _results.length - 1;

        // Update count badge
        if (countEl) countEl.textContent = _results.length ? `${_results.length} results` : '';

        if (_results.length === 0) {
            resultsEl.innerHTML = '<div id="sector-search-empty">NO RESULTS</div>';
            return;
        }

        resultsEl.innerHTML = '';
        _results.forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 'ss-result' + (i === _cursor ? ' active' : '');
            row.innerHTML = `
                <span class="ss-result-icon">${item.icon}</span>
                <div style="flex:1; min-width:0;">
                    <div class="ss-result-name">${item.name}</div>
                    <div class="ss-result-sub">${item.sub}</div>
                </div>
                <span class="ss-result-tag ss-tag-${item.type}">${item.tag}</span>
            `;
            row.onclick = () => select(i);
            resultsEl.appendChild(row);
        });
    }

    // ── Fly to a result ───────────────────────────────────────────────────────
    function select(idx) {
        const item = _results[idx];
        if (!item) return;
        flyToSector(item.lon, item.lat, camera, controls, stateRef);
        close();
    }

    // ── Open / close ──────────────────────────────────────────────────────────
    function open() {
        overlay.classList.add('open');
        input.value = '';
        _query  = '';
        _cursor = -1;
        render();
        requestAnimationFrame(() => input.focus());
        if (toggleBtn) toggleBtn.classList.add('active');
    }

    function close() {
        overlay.classList.remove('open');
        if (toggleBtn) toggleBtn.classList.remove('active');
    }

    // ── Event wiring ──────────────────────────────────────────────────────────
    if (toggleBtn) toggleBtn.onclick = () =>
        overlay.classList.contains('open') ? close() : open();

    // "/" key opens the palette; ESC closes
    window.addEventListener('keydown', e => {
        if (overlay.classList.contains('open')) {
            if (e.key === 'Escape') { e.preventDefault(); close(); return; }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                _cursor = Math.min(_cursor + 1, _results.length - 1);
                render();
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                _cursor = Math.max(_cursor - 1, 0);
                render();
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                select(_cursor >= 0 ? _cursor : 0);
                return;
            }
        } else {
            // Only open on "/" when not typing in another input
            if (e.key === '/' &&
                document.activeElement.tagName !== 'INPUT' &&
                document.activeElement.tagName !== 'TEXTAREA') {
                e.preventDefault();
                open();
            }
        }
    });

    input.addEventListener('input', () => {
        _query  = input.value;
        _cursor = -1;
        render();
    });

    // Click the backdrop to close
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    // Initial render (empty query shows top cities)
    render();
}
