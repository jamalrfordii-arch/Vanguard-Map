// archiveManager.js — Session recording archive: capture the AIS stream AND
// the operator's camera path, store in-browser, replay as a full session.
//
//   REC    — records every inbound AIS message + camera position (4 Hz)
//   SAVE   — persists capture to IndexedDB (survives restarts)
//   REPLAY — session replay: mutes the live feed, clears the world, scrubs
//            simClock to the capture start, re-feeds the recorded traffic and
//            re-flies the recorded camera path (POV). FREE releases the camera
//            while the world keeps replaying.
//   LIVE   — back to wall clock + live feed
//   EXPORT — download capture as NDJSON (first line = manifest with camera track)
//
//   ZONE RECORD — armed, zone-scoped capture of ships AND planes:
//     SET ZONE → click the map, a cyan disc marks the capture zone
//     ARM      → recorder waits for the window start (sim time), records only
//                traffic inside the zone, auto-stops at window end
//     SAVE     → capture joins the archive list; REPLAY re-feeds both domains
//
// Wiring (main.js): initArchivePanel({ aisManager, flightManager, recorder,
//                                      zoneRecorder, camera, controls, scene,
//                                      requestMapPick })

import * as THREE from 'three';
import { simClock } from './simClock.js';
import { RecordedAISSource, ZoneRecordedSource } from './dataSource.js';
import { ZoneRecorder, ZR_STATE } from './zoneRecorder.js';
import { MAP_WIDTH, ZONE_REC } from './config.js';

// ── IndexedDB minimal promise wrapper ────────────────────────────────────────
const DB_NAME = 'vg1-archive';
const STORE   = 'captures';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) {
                req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}
async function dbPut(record) {
    const db = await openDB();
    return new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
}
async function dbAll() {
    const db = await openDB();
    return new Promise((res, rej) => {
        const rq = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error);
    });
}
async function dbDelete(id) {
    const db = await openDB();
    return new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
}

// ── Panel ─────────────────────────────────────────────────────────────────────
export function initArchivePanel({ aisManager, flightManager, recorder, zoneRecorder,
                                   camera, controls, scene, requestMapPick }) {
    let replaySource = null;
    let recTimer     = null;
    let camTimer     = null;
    let camTrack     = [];     // [{t, p:[x,y,z], g:[x,y,z]}] — camera pos + orbit target
    let povTimer     = null;   // drives camera along recorded track during replay
    let replaying    = false;

    const root = document.createElement('div');
    root.id = 'archive-panel';
    root.style.cssText = `
        position:fixed; left:12px; top:46%; z-index:60;
        font-family:'Courier New',Courier,monospace; font-size:10px;
        color:#8aabc4; user-select:none; width:218px;
    `;
    root.innerHTML = `
        <div id="arc-header" style="
            border:1px solid rgba(64,196,255,0.45); border-left:3px solid #40c4ff;
            background:rgba(1,10,20,0.88); padding:7px 10px; cursor:pointer;
            letter-spacing:2px; color:#40c4ff; display:flex; justify-content:space-between;
        ">
            <span>◉ ARCHIVE</span><span id="arc-caret">▸</span>
        </div>
        <div id="arc-body" style="
            display:none; border:1px solid rgba(64,196,255,0.25); border-top:none;
            background:rgba(1,10,20,0.92); padding:10px;
        ">
            <div style="display:flex; gap:6px; margin-bottom:8px;">
                <button id="arc-rec"  style="${btnCss('#ff1744')}">● REC</button>
                <button id="arc-save" style="${btnCss('#40c4ff')}" disabled>SAVE</button>
                <button id="arc-live" style="${btnCss('#8aabc4')}">LIVE</button>
            </div>
            <div id="arc-pov-row" style="display:none; margin-bottom:8px;">
                <button id="arc-pov" style="${btnCss('#ffb547')}; width:100%;">▣ POV LOCKED — CLICK TO FREE CAMERA</button>
            </div>
            <div style="border-top:1px solid rgba(64,196,255,0.15); margin-bottom:8px; padding-top:8px;">
                <div style="color:#40c4ff; letter-spacing:2px; margin-bottom:6px;">◎ ZONE RECORD</div>
                <div style="display:flex; gap:6px; margin-bottom:6px; align-items:center;">
                    <button id="arc-zone-set" style="${btnCss('#40c4ff')}">SET ZONE</button>
                    <input id="arc-zone-radius" type="number" value="${ZONE_REC.DEFAULT_RADIUS_NM}" min="5" max="600"
                        style="width:44px; background:transparent; border:1px solid #2e4a5e; color:#cfe3f1;
                               font-family:inherit; font-size:9px; padding:4px 3px;">
                    <span style="color:#4a6b84;">NM</span>
                </div>
                <div id="arc-zone-coords" style="color:#4a6b84; letter-spacing:1px; margin-bottom:6px;">NO ZONE SET</div>
                <div style="color:#4a6b84; margin-bottom:6px;">
                    <div style="display:flex; gap:5px; align-items:center; margin-bottom:4px;">
                        <span style="width:32px;">START</span>
                        <input id="arc-zone-start" type="datetime-local" style="${dtCss()}">
                    </div>
                    <div style="display:flex; gap:5px; align-items:center;">
                        <span style="width:32px;">END</span>
                        <input id="arc-zone-end" type="datetime-local" style="${dtCss()}">
                    </div>
                </div>
                <div style="display:flex; gap:6px; margin-bottom:6px;">
                    <button id="arc-zone-arm"  style="${btnCss('#ff1744')}" disabled>◎ ARM</button>
                    <button id="arc-zone-save" style="${btnCss('#40c4ff')}" disabled>SAVE ZONE</button>
                </div>
                <div id="arc-zone-status" style="min-height:13px; color:#4a6b84; letter-spacing:1px;">IDLE</div>
            </div>
            <div id="arc-status" style="min-height:13px; color:#4a6b84; letter-spacing:1px; margin-bottom:8px;">READY</div>
            <div id="arc-list" style="max-height:180px; overflow-y:auto;"></div>
        </div>
    `;
    document.body.appendChild(root);

    function btnCss(color) {
        return `flex:1; background:transparent; border:1px solid ${color};
                color:${color}; padding:5px 4px; font-family:inherit; font-size:9px;
                letter-spacing:1px; cursor:pointer;`;
    }
    function dtCss() {
        return `flex:1; background:rgba(1,10,20,0.9); border:1px solid #2e4a5e;
                color:#cfe3f1; font-family:inherit; font-size:9px; padding:3px;
                color-scheme:dark;`;
    }

    const $ = (id) => document.getElementById(id);
    const header = $('arc-header'), body = $('arc-body'), caret = $('arc-caret');
    const recBtn = $('arc-rec'), saveBtn = $('arc-save'), liveBtn = $('arc-live');
    const povRow = $('arc-pov-row'), povBtn = $('arc-pov');
    const status = $('arc-status'), list = $('arc-list');

    header.addEventListener('click', () => {
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        caret.textContent  = open ? '▸' : '▾';
        if (!open) refreshList();
    });

    function setStatus(text, color = '#4a6b84') {
        status.textContent = text;
        status.style.color = color;
    }

    // ── Record (AIS stream + camera path) ────────────────────────────────────
    recBtn.addEventListener('click', () => {
        if (recorder.active) {  // acts as STOP
            recorder.stop();
            clearInterval(recTimer); clearInterval(camTimer);
            recBtn.textContent = '● REC';
            setStatus(`STOPPED — ${recorder.count()} MSGS, ${camTrack.length} CAM SAMPLES`);
            return;
        }
        recorder.clear(); camTrack = [];
        recorder.start();
        recBtn.textContent = '■ STOP';
        saveBtn.disabled = false;
        camTimer = setInterval(() => {
            camTrack.push({
                t: simClock.now(),
                p: [camera.position.x, camera.position.y, camera.position.z],
                g: [controls.target.x, controls.target.y, controls.target.z],
            });
        }, 250);
        recTimer = setInterval(() =>
            setStatus(`RECORDING — ${recorder.count()} MSGS`, '#ff1744'), 1000);
    });

    saveBtn.addEventListener('click', async () => {
        recorder.stop();
        clearInterval(recTimer); clearInterval(camTimer);
        recBtn.textContent = '● REC';
        const n = recorder.count();
        if (!n && camTrack.length < 2) { setStatus('NOTHING TO SAVE'); return; }

        const name = prompt('Name this capture:',
            `capture ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`) || 'unnamed';
        const recs = recorder._records;
        const t0 = recs.length ? recs[0].t : camTrack[0].t;
        const t1 = recs.length ? recs[recs.length - 1].t : camTrack[camTrack.length - 1].t;
        await dbPut({
            name, savedAt: Date.now(), t0, t1,
            count: n,
            ndjson: recorder.toNDJSON(),
            camTrack,
        });
        recorder.clear(); camTrack = [];
        saveBtn.disabled = true;
        setStatus(`SAVED — ${n} MSGS`, '#40c4ff');
        refreshList();
    });

    // ── Zone record ───────────────────────────────────────────────────────────
    const zSetBtn  = $('arc-zone-set'),   zArmBtn   = $('arc-zone-arm');
    const zSaveBtn = $('arc-zone-save'),  zStatus   = $('arc-zone-status');
    const zCoords  = $('arc-zone-coords'), zRadius  = $('arc-zone-radius');
    const zStart   = $('arc-zone-start'), zEnd      = $('arc-zone-end');

    let zonePick   = null;   // { point: Vector3, lon, lat }
    let zoneMeshes = null;   // { disk, ring }
    let zCountTimer = null;

    function setZStatus(text, color = '#4a6b84') {
        zStatus.textContent = text;
        zStatus.style.color = color;
    }

    // datetime-local helpers (values are local time; Date.parse handles them)
    function toLocalInput(ms) {
        const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
        return d.toISOString().slice(0, 16);
    }
    function prefillWindow() {
        if (!zStart.value) zStart.value = toLocalInput(simClock.now());
        if (!zEnd.value)   zEnd.value   = toLocalInput(simClock.now() + 30 * 60000);
    }
    header.addEventListener('click', prefillWindow);

    function clearZoneMeshes() {
        if (!zoneMeshes || !scene) { zoneMeshes = null; return; }
        scene.remove(zoneMeshes.disk); scene.remove(zoneMeshes.ring);
        zoneMeshes.disk.geometry.dispose(); zoneMeshes.ring.geometry.dispose();
        zoneMeshes = null;
    }

    // Zone disc radius in scene units: 1° lon = MAP_WIDTH/360 units = 60 nm at
    // the equator; Mercator stretches horizontal distance by 1/cos(lat), so the
    // drawn disc matches the true haversine filter closely enough to aim by.
    function drawZoneMeshes() {
        if (!zonePick || !scene) return;
        clearZoneMeshes();
        const radiusNm = Number(zRadius.value) || ZONE_REC.DEFAULT_RADIUS_NM;
        const cosLat   = Math.max(0.2, Math.cos(zonePick.lat * Math.PI / 180));
        const r        = (radiusNm / 60) * (MAP_WIDTH / 360) / cosLat;

        const diskGeo = new THREE.CircleGeometry(r, 64);
        diskGeo.rotateX(-Math.PI / 2);
        const disk = new THREE.Mesh(diskGeo, new THREE.MeshBasicMaterial({
            color: 0x40c4ff, transparent: true, opacity: 0.07,
            depthWrite: false, side: THREE.DoubleSide,
        }));
        disk.position.copy(zonePick.point).setY(zonePick.point.y + 0.3);
        scene.add(disk);

        const ringGeo = new THREE.RingGeometry(Math.max(0.1, r - 0.4), r, 64);
        ringGeo.rotateX(-Math.PI / 2);
        const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
            color: 0x40c4ff, transparent: true, opacity: 0.55,
            depthWrite: false, side: THREE.DoubleSide,
        }));
        ring.position.copy(zonePick.point).setY(zonePick.point.y + 0.35);
        scene.add(ring);

        zoneMeshes = { disk, ring };
    }

    zSetBtn.addEventListener('click', () => {
        if (!requestMapPick) { setZStatus('MAP PICK UNAVAILABLE', '#ff1744'); return; }
        zSetBtn.textContent = 'CLICK MAP...';
        requestMapPick(({ point, lon, lat }) => {
            zonePick = { point, lon, lat };
            drawZoneMeshes();
            zCoords.textContent = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
            zCoords.style.color = '#cfe3f1';
            zSetBtn.textContent = 'SET ZONE';
            zArmBtn.disabled = false;
            prefillWindow();
        });
    });
    zRadius.addEventListener('change', drawZoneMeshes);

    zArmBtn.addEventListener('click', () => {
        if (!zoneRecorder) return;
        const st = zoneRecorder.state;
        if (st === ZR_STATE.RECORDING) { zoneRecorder.stop(); return; }   // stop early, keep capture
        if (st === ZR_STATE.ARMED)     { zoneRecorder.disarm(); return; } // cancel while waiting
        if (!zonePick) return;
        const startMs = zStart.value ? Date.parse(zStart.value) : simClock.now();
        const endMs   = zEnd.value   ? Date.parse(zEnd.value)   : startMs + 30 * 60000;
        try {
            zoneRecorder.arm({
                lat: zonePick.lat, lon: zonePick.lon,
                radiusNm: Number(zRadius.value) || ZONE_REC.DEFAULT_RADIUS_NM,
                startMs, endMs,
            });
        } catch (e) {
            setZStatus(e.message.replace('[ZoneRecorder] arm: ', '').toUpperCase(), '#ff1744');
        }
    });

    // State transitions arrive on the event bus; the count ticks on a timer.
    window.addEventListener('vg1:zoneRecorder', (ev) => {
        const { state } = ev.detail;
        clearInterval(zCountTimer); zCountTimer = null;
        if (state === ZR_STATE.ARMED) {
            zArmBtn.textContent = '■ DISARM';
            setZStatus('ARMED — WAITING FOR WINDOW', '#ffb547');
        } else if (state === ZR_STATE.RECORDING) {
            zArmBtn.textContent = '■ STOP';
            zCountTimer = setInterval(() => {
                const c = zoneRecorder.counts();
                setZStatus(`● REC — ${c.ais} SHIP / ${c.flt} AIR MSGS`, '#ff1744');
            }, 1000);
            setZStatus('● REC — 0 SHIP / 0 AIR MSGS', '#ff1744');
        } else if (state === ZR_STATE.DONE) {
            zArmBtn.textContent = '◎ ARM';
            const c = zoneRecorder.counts();
            setZStatus(`DONE — ${c.ais} SHIP / ${c.flt} AIR MSGS`, '#40c4ff');
            zSaveBtn.disabled = zoneRecorder.count() === 0;
        } else { // IDLE (disarmed)
            zArmBtn.textContent = '◎ ARM';
            setZStatus('IDLE');
            zSaveBtn.disabled = true;
        }
    });

    zSaveBtn.addEventListener('click', async () => {
        if (!zoneRecorder || zoneRecorder.count() === 0) return;
        const s = zoneRecorder.status();
        const name = prompt('Name this zone capture:',
            `zone ${s.zone.lat.toFixed(1)},${s.zone.lon.toFixed(1)} ${new Date(s.window.startMs).toISOString().slice(0, 16).replace('T', ' ')}`) || 'unnamed zone';
        await dbPut({
            name, kind: 'zone', savedAt: Date.now(),
            t0: s.window.startMs, t1: s.window.endMs,
            count: zoneRecorder.count(),
            zone: s.zone,
            ndjson: zoneRecorder.toNDJSON(),
        });
        zoneRecorder.clear();
        clearZoneMeshes();
        zonePick = null;
        zCoords.textContent = 'NO ZONE SET'; zCoords.style.color = '#4a6b84';
        zArmBtn.disabled = true; zSaveBtn.disabled = true;
        setZStatus('SAVED', '#40c4ff');
        refreshList();
    });

    // ── Session replay ────────────────────────────────────────────────────────
    function startPOV(track) {
        povRow.style.display = 'block';
        povBtn.textContent = '▣ POV LOCKED — CLICK TO FREE CAMERA';
        stopPOV(false);
        povTimer = setInterval(() => {
            const now = simClock.now();
            // find surrounding samples (track is time-ordered)
            let i = 0;
            while (i < track.length - 1 && track[i + 1].t < now) i++;
            const a = track[i], b = track[Math.min(i + 1, track.length - 1)];
            const f = (a === b || b.t === a.t) ? 0 : Math.min(1, Math.max(0, (now - a.t) / (b.t - a.t)));
            camera.position.set(
                a.p[0] + (b.p[0] - a.p[0]) * f,
                a.p[1] + (b.p[1] - a.p[1]) * f,
                a.p[2] + (b.p[2] - a.p[2]) * f);
            controls.target.set(
                a.g[0] + (b.g[0] - a.g[0]) * f,
                a.g[1] + (b.g[1] - a.g[1]) * f,
                a.g[2] + (b.g[2] - a.g[2]) * f);
            controls.update();
        }, 50);
    }
    function stopPOV(hideRow = true) {
        if (povTimer) { clearInterval(povTimer); povTimer = null; }
        if (hideRow) povRow.style.display = 'none';
    }
    povBtn.addEventListener('click', () => {
        if (povTimer) { stopPOV(false); povBtn.textContent = '▢ CAMERA FREE — CLICK TO RELOCK POV'; }
        else if (replaying) { /* re-lock using current capture */ povBtn.dataset.relock = '1'; }
    });

    async function replay(capture) {
        // Fresh world: mute live feeds, drop existing entities (also prevents
        // the invariant gate rejecting replayed positions as backwards
        // teleports), detach any prior replay source, scrub the clock.
        aisManager.setLivePaused(true);
        if (flightManager) flightManager.setLivePaused(true);
        if (replaySource) aisManager.detachSource(replaySource);
        aisManager.clearAllVessels();
        if (flightManager) flightManager.clearAll();
        simClock.setTime(capture.t0);

        if (capture.kind === 'zone') {
            // Mixed ship+plane capture: manifest line is skipped by the parser;
            // flight records re-enter through flightManager.ingest.
            const { records } = ZoneRecorder.parseNDJSON(capture.ndjson);
            if (records.length) simClock.setTime(records[0].t);
            replaySource = new ZoneRecordedSource(records, {
                flightSink: (states) => flightManager && flightManager.ingest(states),
            });
        } else {
            const records = (capture.ndjson || '').split('\n').filter(l => l.trim())
                .map(l => JSON.parse(l)).sort((a, b) => a.t - b.t);
            replaySource = new RecordedAISSource(records);
        }
        aisManager.attachSource(replaySource);
        replaying = true;

        if (capture.camTrack && capture.camTrack.length > 1) {
            startPOV(capture.camTrack);
            // allow re-lock after FREE
            povBtn.onclick = () => {
                if (povTimer) { stopPOV(false); povBtn.textContent = '▢ CAMERA FREE — CLICK TO RELOCK POV'; }
                else { startPOV(capture.camTrack); }
            };
        }
        setStatus(`REPLAYING "${capture.name.toUpperCase()}"`, '#40c4ff');
    }

    liveBtn.addEventListener('click', () => {
        stopPOV();
        aisManager.detachAllSources();
        replaySource = null;
        replaying = false;
        aisManager.clearAllVessels();   // drop replay ghosts; live feeds repopulate
        aisManager.setLivePaused(false);
        if (flightManager) {
            flightManager.clearAll();
            flightManager.setLivePaused(false);
        }
        simClock.goLive();
        setStatus('LIVE — CLOCK ON WALL TIME');
    });

    // ── Capture list ──────────────────────────────────────────────────────────
    async function refreshList() {
        const caps = (await dbAll()).sort((a, b) => b.savedAt - a.savedAt);
        list.innerHTML = caps.length ? '' :
            '<div style="color:#2e4a5e;">NO SAVED CAPTURES</div>';
        for (const c of caps) {
            const row = document.createElement('div');
            const mins = ((c.t1 - c.t0) / 60000).toFixed(1);
            const cam  = c.camTrack?.length > 1 ? ' · POV' : '';
            const zone = c.kind === 'zone' ? ' · <span style="color:#40c4ff;">◎ ZONE</span>' : '';
            row.style.cssText = 'border-top:1px solid rgba(64,196,255,0.12); padding:6px 0;';
            row.innerHTML = `
                <div style="color:#cfe3f1; letter-spacing:1px;">${c.name.toUpperCase()}</div>
                <div style="color:#4a6b84;">${new Date(c.savedAt).toLocaleString()} · ${c.count} msgs · ${mins} min${cam}${zone}</div>
                <div style="display:flex; gap:5px; margin-top:4px;">
                    <button data-act="replay" style="${btnCss('#40c4ff')}">REPLAY</button>
                    <button data-act="export" style="${btnCss('#8aabc4')}">EXPORT</button>
                    <button data-act="del"    style="${btnCss('#ff1744')}">✕</button>
                </div>
            `;
            row.querySelector('[data-act="replay"]').addEventListener('click', () => replay(c));
            row.querySelector('[data-act="export"]').addEventListener('click', () => {
                // Zone captures already carry their own manifest as line 1.
                const payload = c.kind === 'zone' ? c.ndjson :
                    JSON.stringify({ type: 'vg1-capture', name: c.name, t0: c.t0, t1: c.t1, camTrack: c.camTrack ?? [] }) + '\n' + c.ndjson;
                const blob = new Blob([payload], { type: 'application/x-ndjson' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${c.name.replace(/[^\w-]+/g, '_')}.ndjson`;
                a.click();
                URL.revokeObjectURL(a.href);
            });
            row.querySelector('[data-act="del"]').addEventListener('click', async () => {
                await dbDelete(c.id);
                refreshList();
            });
            list.appendChild(row);
        }
    }
}
