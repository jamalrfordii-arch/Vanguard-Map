// tilePointsWorker.js — runs tile point generation off the main thread.
//
// Deliberately thin: it owns no logic of its own. All the maths lives in
// tilePointsBuilder.js, which the main thread also imports, so there is exactly
// ONE implementation and the worker cannot drift away from it. That was the whole
// reason the extraction (stage 1) happened before this file existed.
//
// Protocol: { id, cfg, tx, ty, qmData, imgData, landMask, imgRect, geoCarve } in →
//           { id, positions, colors, count } out, buffers transferred.
//           { id, error } on failure — the pool rejects rather than hanging.

import { buildTilePoints } from './tilePointsBuilder.js';

self.onmessage = (e) => {
    const { id, cfg, tx, ty, qmData, imgData, landMask, imgRect, geoCarve } = e.data;
    try {
        const { positions, colors, count } = buildTilePoints(cfg, tx, ty, qmData, imgData, landMask, imgRect, geoCarve);
        // Transfer rather than copy: these are the large buffers (up to
        // ptsBudget × 3 floats each) and the worker has no further use for them.
        // qmData/imgData came IN as copies on purpose — see the pool.
        self.postMessage({ id, positions, colors, count }, [positions.buffer, colors.buffer]);
    } catch (err) {
        // A throw here would otherwise surface as a bare 'error' event with no
        // job id, leaving that tile's promise pending forever and its key stuck
        // in _loading — the tile would never be retried.
        self.postMessage({ id, error: err?.message ?? String(err) });
    }
};
