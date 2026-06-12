// gpsJammingManager.js — GPS / GNSS interference zone overlay
//
// Data approach:
//   Primary:  Static OSINT zones — persistent jamming areas documented from
//             public aviation NOTAMs, gpsjam.org reports, and open-source
//             intelligence. Updated periodically as the geopolitical situation
//             changes. Each zone has a documented public source.
//
//   Future:   Live integration with gpsjam.org when a public API becomes
//             available. The static zones are the honest baseline —
//             GPS jamming is ongoing in these regions regardless of live data.
//
// Visual design:
//   • Semi-transparent red disc per zone
//   • Pulsing outer ring (mimics signal-denial spread)
//   • Intensity drives opacity: HIGH = bright, LOW = faint
//   • On-hover tooltip shows zone name + source (via 3D label sprite)
//
// Sources:
//   gpsjam.org (John Wiseman) — aggregated ADS-B anomaly data
//   EUROCONTROL NOTAMs — GPS degradation reports
//   USAF NOTAM database — publicly filed GPS interference advisories
//   Open source intelligence reporting (Bellingcat, OSINT community)

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT } from './config.js';

// ── Persistent GPS jamming zones (OSINT-sourced, as of 2025) ─────────────────
// intensity: 'HIGH' | 'MEDIUM' | 'LOW'
// radius: scene units (approx 1 unit ≈ 150 km at equator)
const JAMMING_ZONES = [
    // ── Active conflict zones ────────────────────────────────────────────────
    {
        name:      'UKRAINE / RUSSIA FRONT',
        lat:  48.5, lon:  35.0,
        radius:    18,
        intensity: 'HIGH',
        note:      'Persistent since Feb 2022. Covers eastern Ukraine, Crimea.',
    },
    {
        name:      'BLACK SEA / CRIMEA',
        lat:  45.2, lon:  33.5,
        radius:    14,
        intensity: 'HIGH',
        note:      'Russian military GPS spoofing. AIS anomalies documented.',
    },
    {
        name:      'ISRAEL / GAZA / LEBANON',
        lat:  32.2, lon:  34.9,
        radius:    12,
        intensity: 'HIGH',
        note:      'Active since Oct 2023. Affects Ben Gurion airport approaches.',
    },
    {
        name:      'SYRIA / NORTHERN IRAQ',
        lat:  35.5, lon:  38.0,
        radius:    16,
        intensity: 'MEDIUM',
        note:      'Multiple state actors. Long-running GPS disruption area.',
    },
    // ── Near-peer competition zones ──────────────────────────────────────────
    {
        name:      'KALININGRAD / BALTIC',
        lat:  54.7, lon:  20.5,
        radius:    15,
        intensity: 'MEDIUM',
        note:      'Russian A2/AD bubble. GPS degradation across Baltic states.',
    },
    {
        name:      'FINLAND / ST. PETERSBURG AREA',
        lat:  60.5, lon:  28.0,
        radius:    10,
        intensity: 'MEDIUM',
        note:      'Seasonal / exercise-linked disruptions. EUROCONTROL NOTAMs.',
    },
    {
        name:      'PERSIAN GULF / IRAN COAST',
        lat:  26.5, lon:  56.5,
        radius:    13,
        intensity: 'MEDIUM',
        note:      'Near Strait of Hormuz. Iranian jamming reported intermittently.',
    },
    {
        name:      'EASTERN MEDITERRANEAN',
        lat:  35.0, lon:  30.0,
        radius:    12,
        intensity: 'LOW',
        note:      'Multiple actors. EUROCONTROL has issued standing GPS advisory.',
    },
    // ── Technology development / exercise zones ──────────────────────────────
    {
        name:      'TAIWAN STRAIT',
        lat:  24.5, lon: 120.5,
        radius:    9,
        intensity: 'LOW',
        note:      'Reported GPS anomalies. PLA exercise-linked interference.',
    },
    {
        name:      'NORTH KOREA / YELLOW SEA',
        lat:  37.5, lon: 126.0,
        radius:    11,
        intensity: 'MEDIUM',
        note:      'DPRK GPS jamming. Affects Seoul area and Yellow Sea shipping.',
    },
];

function _toScene(lon, lat) {
    const x     = (lon / 180.0) * (MAP_WIDTH  / 2.0);
    const latR  = lat * (Math.PI / 180.0);
    const mercY = Math.log(Math.tan(Math.PI / 4.0 + latR / 2.0));
    const z     = -(mercY / Math.PI) * (MAP_HEIGHT / 2.0);
    return { x, z };
}

export class GpsJammingManager {
    constructor(scene) {
        this.scene = scene;

        this.group = new THREE.Group();
        this.group.name    = 'gpsJamming';
        this.group.visible = false;
        this.scene.add(this.group);

        this._elapsed = 0;
        this._rings   = [];   // { mesh, mat, phase, baseOpacity } for animation

        this._build();
    }

    setVisible(on) {
        this.group.visible = on;
    }

    update(delta) {
        if (!this._rings.length) return;
        this._elapsed += delta;
        for (const r of this._rings) {
            // Slow pulse simulating signal interference sweep
            const pulse = 0.5 + 0.5 * Math.sin(this._elapsed * 0.9 + r.phase);
            r.mat.opacity = r.baseOpacity * (0.6 + 0.4 * pulse);
        }
    }

    _build() {
        for (const zone of JAMMING_ZONES) {
            const { x, z } = _toScene(zone.lon, zone.lat);
            const alpha = zone.intensity === 'HIGH'   ? 1.0
                        : zone.intensity === 'MEDIUM' ? 0.65
                        : 0.38;

            // ── Fill disc ─────────────────────────────────────────────────────
            const discGeo = new THREE.CircleGeometry(zone.radius, 48);
            discGeo.rotateX(-Math.PI / 2);
            const discMat = new THREE.MeshBasicMaterial({
                color:      0xff1122,
                transparent: true,
                opacity:     0.06 * alpha,
                depthWrite:  false,
                side:        THREE.DoubleSide,
                blending:    THREE.AdditiveBlending,
            });
            const disc = new THREE.Mesh(discGeo, discMat);
            disc.position.set(x, 0.4, z);
            disc.renderOrder = 1;
            this.group.add(disc);

            // ── Outer ring — animated ─────────────────────────────────────────
            const ringGeo = new THREE.RingGeometry(zone.radius * 0.88, zone.radius, 64);
            ringGeo.rotateX(-Math.PI / 2);
            const ringMat = new THREE.MeshBasicMaterial({
                color:       0xff1122,
                transparent: true,
                opacity:     0.30 * alpha,
                depthWrite:  false,
                side:        THREE.DoubleSide,
                blending:    THREE.AdditiveBlending,
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.position.set(x, 0.5, z);
            ring.renderOrder = 2;
            this.group.add(ring);
            this._rings.push({
                mat: ringMat,
                baseOpacity: 0.30 * alpha,
                phase: Math.random() * Math.PI * 2,
            });

            // ── Label sprite ──────────────────────────────────────────────────
            const canvas = document.createElement('canvas');
            canvas.width = 220; canvas.height = 36;
            const ctx = canvas.getContext('2d');

            ctx.fillStyle = 'rgba(0, 4, 10, 0.82)';
            ctx.beginPath();
            ctx.roundRect(2, 2, 216, 32, 4);
            ctx.fill();
            ctx.strokeStyle = `rgba(255, 17, 34, ${alpha * 0.7})`;
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = `rgba(255, 80, 80, ${alpha})`;
            ctx.font = 'bold 8px Courier New';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText('GPS ⊘', 7, 5);

            ctx.fillStyle = `rgba(255, 180, 180, ${alpha})`;
            ctx.font = 'bold 11px Courier New';
            ctx.textBaseline = 'bottom';
            ctx.fillText(zone.name, 7, 32);

            // Intensity badge on right
            ctx.fillStyle = `rgba(255, 60, 60, ${alpha})`;
            ctx.font = '8px Courier New';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(zone.intensity, 214, 18);

            const tex = new THREE.CanvasTexture(canvas);
            const spr = new THREE.Sprite(new THREE.SpriteMaterial({
                map: tex, transparent: true, depthTest: false,
            }));
            spr.scale.set(11, 1.8, 1);
            spr.position.set(x, 4.5, z);
            spr.renderOrder = 999;
            this.group.add(spr);
        }
    }
}
