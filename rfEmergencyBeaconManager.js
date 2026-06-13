// rfEmergencyBeaconManager.js — RF Phase 1, feature #8: distress beacon detector.
//
// Detection paths (free OSINT, per research/rf-intel-build-plan.md):
//   1. MMSI prefix — AIS distress devices use reserved prefixes:
//        970* = AIS-SART (search and rescue transponder)
//        972* = MOB (man overboard device)
//        974* = EPIRB-AIS (emergency position beacon)
//      Any position report from these MMSIs IS a distress transmission.
//   2. Safety broadcasts (AIS msg type 14) containing SART/MOB/EPIRB keywords.
//
// Visual: pulsing red halo + expanding rings at the beacon position.
// Always visible regardless of layer toggles — it's an emergency.
// Events: recordEvent(severity ALERT) → RF INTEL feed + auto-promotion.
//
// Honest-pitfalls note (#7 in the plan): AIS-borne beacons are PARTIAL
// coverage — Cospas-Sarsat 406 MHz data is gated to SAR authorities. Test
// messages (text contains "TEST") are demoted to INFO.

import * as THREE from 'three';
import { lonLatToScene } from './aisManager.js';
import { rfIntel } from './rfIntelManager.js';
import { simClock } from './simClock.js';

const DISTRESS_PREFIX = { '970': 'AIS-SART', '972': 'MOB DEVICE', '974': 'EPIRB-AIS' };
const RING_COUNT  = 3;
const RING_PERIOD = 1.8;   // s per expansion (visual-design: ease-out, 600ms stagger)
const BEACON_TTL  = 30 * 60 * 1000;  // drop beacon visual after 30 min silence
const BEACON_ALT  = 16;    // marker altitude — keeps the effect in the sky,
                           // clear of the ocean surface and nearby vessels
const RING_MAX    = 3.0;   // max ring radius multiplier — compact, won't span vessels

export class RFEmergencyBeaconManager {
    constructor(scene) {
        this.group = new THREE.Group();
        this.group.name = 'rfDistressBeacons';
        this.group.renderOrder = 250;          // critical-alert tier
        scene.add(this.group);
        this.beacons = new Map();              // mmsi → { obj, rings, lastSeen, kind }
        // Rings are camera-facing (vertical) at altitude — read as a beacon
        // pinging in the sky rather than ripples spreading on the water.
        this._ringGeo = new THREE.RingGeometry(0.5, 0.66, 48);
        this._diamondGeo = new THREE.OctahedronGeometry(0.7, 0);

        // Telemetry — visible on the RF tab's sensor status board
        this.stats = rfIntel.registerDetector('beacons', {
            name:   'DISTRESS BEACONS',
            source: 'AIS MMSI 970/972/974 + msg14',
        });
    }

    // Fed every raw AIS message (multiplexed in main.js).
    inspect(msg) {
        this.stats.inspected++;
        this.stats.lastInspect = Date.now();
        const meta = msg.MetaData;
        if (!meta) return;
        const mmsi   = String(meta.MMSI ?? '');
        const prefix = mmsi.slice(0, 3);

        // Path 1 — reserved distress MMSI sending a position
        if (DISTRESS_PREFIX[prefix] && msg.MessageType === 'PositionReport'
            && meta.latitude != null && meta.longitude != null) {
            this._activate(mmsi, DISTRESS_PREFIX[prefix], meta.latitude, meta.longitude,
                           `AIS msg from reserved distress MMSI ${mmsi}`);
            return;
        }

        // Path 2 — safety broadcast text mentioning a distress device
        if (msg.MessageType === 'SafetyBroadcastMessage') {
            const text = (msg.Message?.SafetyBroadcastMessage?.Text || '').toUpperCase();
            if (/SART|EPIRB|MOB|MAYDAY/.test(text) && meta.latitude != null) {
                this._activate(mmsi, 'SAFETY BROADCAST', meta.latitude, meta.longitude,
                               `"${text.slice(0, 60)}"`);
            }
        }
    }

    _activate(mmsi, kind, lat, lon, detail) {
        const isTest = /TEST/.test(detail.toUpperCase());
        const pos    = lonLatToScene(lon, lat, 0.6);
        let b = this.beacons.get(mmsi);

        if (!b) {
            // Anchor at the surface point; build the visual UP in the sky so it
            // never clouds the ocean or the vessels around the casualty.
            const obj = new THREE.Group();
            obj.position.set(pos.x, 0, pos.z);

            // Faint tether — a thin low-opacity line so the sky marker reads as
            // belonging to this spot, without the heavy footprint of ground rings.
            const tether = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(0, 0.4, 0), new THREE.Vector3(0, BEACON_ALT, 0)]),
                new THREE.LineBasicMaterial({ color: 0xff2a4d, transparent: true, opacity: 0.18,
                                              blending: THREE.AdditiveBlending, depthWrite: false }));
            obj.add(tether);

            // Compact ping rings at altitude (camera-facing, set in tick()).
            const rings = [];
            for (let i = 0; i < RING_COUNT; i++) {
                const mat = new THREE.MeshBasicMaterial({
                    color: 0xff2a4d, transparent: true, opacity: 0.9,
                    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
                });
                const ring = new THREE.Mesh(this._ringGeo, mat);
                ring.position.y = BEACON_ALT;
                ring.userData.phase = i / RING_COUNT;
                rings.push(ring);
                obj.add(ring);
            }

            // Sky marker — a pulsing red diamond high above the position.
            const core = new THREE.Mesh(
                this._diamondGeo,
                new THREE.MeshBasicMaterial({ color: 0xff2a4d, transparent: true, opacity: 0.95,
                                              blending: THREE.AdditiveBlending, depthWrite: false }));
            core.position.y = BEACON_ALT;
            obj.add(core);

            this.group.add(obj);
            b = { obj, rings, core, kind, firstSeen: simClock.now() };
            this.beacons.set(mmsi, b);
            this.stats.events++;
            this.stats.extra = { 'active beacons': this.beacons.size };

            // Feed event — once per beacon activation, not per ping
            const hhmm = new Date(simClock.now()).toISOString().slice(11, 16);
            rfIntel.recordEvent({
                type: isTest ? 'DISTRESS_TEST' : 'DISTRESS_BEACON',
                severity: isTest ? 'INFO' : 'ALERT',
                timestamp: simClock.now(),
                location: { lat, lon },
                vessel: { mmsi, name: kind },
                source: 'AIS (msg 1/14)',
                summary: `${kind} active at ${lat.toFixed(2)}°, ${lon.toFixed(2)}° · ${hhmm}Z`,
                evidence: { detail },
            });

            // First-encounter explanation (real beacons only, not TEST pings).
            if (!isTest) {
                import('./contextCardManager.js')
                    .then(m => m.contextCards.show('DISTRESS_BEACON'))
                    .catch(() => {});
            }
        } else {
            b.obj.position.set(pos.x, 0, pos.z);   // beacon drifts with the casualty
        }
        b.lastSeen = simClock.now();
    }

    // Animation hook — call each frame from the main loop. cameraQuat lets the
    // sky rings face the viewer so they read as pings, not flat discs.
    tick(elapsed, cameraQuat) {
        const now = simClock.now();
        const stale = [];
        this.beacons.forEach((b, mmsi) => {
            if (now - b.lastSeen > BEACON_TTL) { stale.push(mmsi); return; }
            // Compact ping rings at altitude — expand to RING_MAX then fade.
            for (const ring of b.rings) {
                if (cameraQuat) ring.quaternion.copy(cameraQuat);  // billboard toward camera
                const t = ((elapsed / RING_PERIOD) + ring.userData.phase) % 1;
                const s = 1 + t * (RING_MAX - 1);
                ring.scale.set(s, s, s);
                ring.material.opacity = (1 - t) * 0.85;
            }
            // Diamond marker: gentle pulse (1.2 s ALERT cadence) + slow spin.
            b.core.material.opacity = 0.55 + 0.4 * Math.sin(elapsed * (Math.PI * 2 / 1.2));
            b.core.rotation.y = elapsed * 0.8;
        });
        stale.forEach(mmsi => {
            const b = this.beacons.get(mmsi);
            this.group.remove(b.obj);
            this.beacons.delete(mmsi);
            this.stats.extra = { 'active beacons': this.beacons.size };
        });
    }
}
