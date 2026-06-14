// bootProfiler.js — measurement-only load-stage timing. NO behavior change.
//
// Goal: before optimizing load-time-vs-capability, get real numbers on where boot
// time actually goes — per stage, and per network source (real transferred bytes
// from the Resource Timing API). Run a throttled load (DevTools → Network → "Slow 4G"),
// then read `vg1BootProfile.report()` or the auto-dump at the end of init.
//
// Usage is already wired into main.js + dataLoader.js. From the console:
//   vg1BootProfile.report()   → console.table of stages + network breakdown
//   vg1BootProfile.data       → raw object (stages, network, device, network-info)

const _t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
let _last = _t0;
const _stages = [];

// Mark the end of a named stage. delta = ms since previous mark; total = ms since boot.
export function mark(stage, meta) {
    const now = performance.now();
    const rec = { stage, deltaMs: Math.round(now - _last), totalMs: Math.round(now - _t0), meta: meta || null };
    _stages.push(rec);
    _last = now;
    console.log(`[boot] ${stage.padEnd(28)} +${String(rec.deltaMs).padStart(6)}ms   (T+${rec.totalMs}ms)`
        + (meta ? '   ' + JSON.stringify(meta) : ''));
    return rec;
}

// Time an async stage: const r = await time('label', somePromise);
export async function time(stage, promiseOrFn, meta) {
    const start = performance.now();
    try {
        const r = await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
        const ms = Math.round(performance.now() - start);
        _stages.push({ stage, deltaMs: ms, totalMs: Math.round(performance.now() - _t0), meta: meta || null });
        console.log(`[boot] ${stage.padEnd(28)} ${String(ms).padStart(6)}ms` + (meta ? '   ' + JSON.stringify(meta) : ''));
        return r;
    } catch (e) {
        _stages.push({ stage: stage + ' (FAILED)', deltaMs: Math.round(performance.now() - start), error: e.message });
        throw e;
    }
}

function deviceContext() {
    const q = (typeof window !== 'undefined' && window.vg1Quality) ? window.vg1Quality.info() : {};
    const c = (typeof navigator !== 'undefined' && navigator.connection) || {};
    return {
        tier: q.tier, autoTier: q.auto, gpu: q.gpu, cores: q.cores, deviceMemory: q.deviceMemory, mobile: q.mobile,
        // network — currently UNUSED by the tier picker; captured here to prove it matters.
        effectiveType: c.effectiveType, downlinkMbps: c.downlink, rttMs: c.rtt, saveData: c.saveData,
        devicePixelRatio: (typeof window !== 'undefined') ? window.devicePixelRatio : undefined,
        viewport: (typeof window !== 'undefined') ? `${window.innerWidth}x${window.innerHeight}` : undefined,
    };
}

// Aggregate REAL transferred bytes + duration per network source, from the
// Resource Timing API (no extra fetches — reads what the browser already recorded).
function networkBreakdown() {
    if (typeof performance === 'undefined' || !performance.getEntriesByType) return [];
    const buckets = {};
    const label = (url) => {
        if (url.includes('elevation-tiles-prod')) return 'DEM tiles (S3 / terrarium)';
        if (url.includes('arcgisonline'))         return 'Satellite tiles (ArcGIS)';
        if (url.includes('gebco'))                return 'GEBCO bathymetry (local)';
        if (url.includes('terrain_normals'))      return 'Normal map (local)';
        if (url.includes('terrain_radiance'))     return 'Radiance map (local)';
        if (url.includes('naturalearth') || url.includes('cloudfront')) return 'World borders (GeoJSON)';
        if (/\.js(\?|$)/.test(url))               return 'JS modules';
        return 'other';
    };
    for (const e of performance.getEntriesByType('resource')) {
        const b = (buckets[label(e.name)] ||= { source: label(e.name), count: 0, transferKB: 0, encodedKB: 0, maxDurMs: 0, totalDurMs: 0 });
        b.count++;
        b.transferKB += (e.transferSize || 0) / 1024;
        b.encodedKB  += (e.encodedBodySize || 0) / 1024;
        b.maxDurMs    = Math.max(b.maxDurMs, Math.round(e.duration));
        b.totalDurMs += Math.round(e.duration);
    }
    return Object.values(buckets).map(b => ({
        source: b.source, count: b.count,
        transferMB: +(b.transferKB / 1024).toFixed(2),
        encodedMB:  +(b.encodedKB / 1024).toFixed(2),
        slowestMs:  b.maxDurMs,            // wall-clock matters: parallel fetches ≈ slowest
        sumMs:      b.totalDurMs,
    })).sort((a, b) => b.transferMB - a.transferMB);
}

export function report() {
    const device = deviceContext();
    const network = networkBreakdown();
    const totalBoot = _stages.length ? _stages[_stages.length - 1].totalMs : 0;
    const totalMB = +network.reduce((s, n) => s + n.transferMB, 0).toFixed(2);

    console.group(`%c[BOOT PROFILE] total ${totalBoot}ms · ${totalMB}MB transferred · tier=${device.tier}`,
        'color:#39c; font-weight:bold;');
    console.log('Device / network context:', device);
    if (device.saveData) console.warn('⚠ saveData is ON — user asked for reduced data, tier picker ignores this.');
    if (device.effectiveType && device.effectiveType !== '4g')
        console.warn(`⚠ network effectiveType=${device.effectiveType} — tier picker ignores network entirely.`);
    console.table(_stages.map(s => ({ stage: s.stage, deltaMs: s.deltaMs, totalMs: s.totalMs })));
    console.table(network);
    console.groupEnd();

    return { totalBootMs: totalBoot, totalTransferMB: totalMB, device, stages: _stages, network };
}

if (typeof window !== 'undefined') {
    window.vg1BootProfile = { mark, time, report, get data() { return { stages: _stages, device: deviceContext(), network: networkBreakdown() }; } };
}
