/**
 * tests/rollingRecorder.test.mjs
 *   node --import ./tests/_stubs/register.mjs tests/rollingRecorder.test.mjs
 *
 * The load-bearing claim of this module is an HONESTY one: it must only report
 * coverage it actually has, and must never invent a position for a time it
 * cannot answer for. Most of what follows tries to make it lie.
 */

import { floorIndex, sampleAt, buildReport, RollingRecorder } from '../rollingRecorder.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => c ? (pass++, console.log(`  ✓ ${n}`))
                               : (fail++, console.error(`  ✗ ${n} ${x}`));
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

const S = (t, lat, lon, sog = 10, cog = 90) => ({ t, lat, lon, sog, cog });

console.log('\nrollingRecorder — floorIndex');
{
    const s = [S(100, 0, 0), S(200, 0, 0), S(300, 0, 0)];
    ok('exact hit',        floorIndex(s, 200) === 1);
    ok('between samples',  floorIndex(s, 250) === 1);
    ok('before first',     floorIndex(s, 50)  === -1);
    ok('after last',       floorIndex(s, 999) === 2);
    ok('empty array',      floorIndex([], 10) === -1);
}

console.log('\nrollingRecorder — interpolation');
{
    const s = [S(0, 10, 20, 5, 90), S(1000, 20, 30, 15, 90)];
    const mid = sampleAt(s, 500);
    ok('midpoint lat', near(mid.lat, 15), `got ${mid.lat}`);
    ok('midpoint lon', near(mid.lon, 25), `got ${mid.lon}`);
    ok('midpoint sog', near(mid.sog, 10), `got ${mid.sog}`);
    ok('flagged interpolated', mid.interpolated === true);

    const exact = sampleAt(s, 0);
    ok('exact sample not flagged interpolated', exact.interpolated === false);
}

console.log('\nrollingRecorder — refuses to invent positions');
{
    const s = [S(1000, 10, 20), S(2000, 11, 21)];
    ok('before coverage → null', sampleAt(s, 500) === null);
    ok('after coverage → null',  sampleAt(s, 5000) === null);
    ok('empty → null',           sampleAt([], 1500) === null);
    ok('single sample, off-time → null', sampleAt([S(1000, 1, 1)], 1200) === null);
    console.log('    → "no coverage" must stay a real answer; nearest-sample would fabricate');
}

console.log('\nrollingRecorder — antimeridian');
{
    // 179°E → -179°E is 2° east, not 358° west.
    const s = [S(0, 0, 179), S(1000, 0, -179)];
    const mid = sampleAt(s, 500);
    ok('crosses the short way', Math.abs(mid.lon) === 180 || Math.abs(mid.lon) > 179.5,
        `got ${mid.lon}`);
    ok('does not sweep the globe', Math.abs(mid.lon) > 179, `got ${mid.lon}`);
}

console.log('\nrollingRecorder — replayed reports carry the SAMPLE time');
{
    const r = buildReport('123456789', S(1_700_000_000_000, 1.5, 103.8, 12, 210));
    ok('AISStream shape', r.MessageType === 'PositionReport' && !!r.Message.PositionReport);
    ok('event time is the sample time, not now',
        r.MetaData.time_utc === new Date(1_700_000_000_000).toISOString(),
        r.MetaData.time_utc);
    console.log('    → otherwise invariants.js flags every replayed report as TIME_REGRESSION');
}

console.log('\nrollingRecorder — decimation');
{
    const rec = new RollingRecorder({ decimateMs: 1000, maxSamples: 1e6 });
    const tap = rec.tap();
    const msg = (lat) => ({
        MetaData: { MMSI: '1', latitude: lat, longitude: 0, ShipName: 'X', ShipType: 70 },
        Message:  { PositionReport: { Sog: 1, Cog: 1 } }
    });
    for (let i = 0; i < 50; i++) tap(msg(i));      // all within the same ms
    ok('bursts collapse to one sample', rec.stats().samples === 1, `got ${rec.stats().samples}`);
}

console.log('\nrollingRecorder — memory cap is enforced, not just the window');
{
    // Window is huge, so ONLY the cap can bound this. That is the point: a
    // window alone scales with vessel count and cannot guarantee a ceiling.
    const CAP = 200;
    const rec = new RollingRecorder({ windowMs: 9e9, decimateMs: 0, maxSamples: CAP });
    const tap = rec.tap();
    // Positions are held CONSTANT on purpose. These samples all land in the same
    // millisecond, and the teleport guard (rightly) treats any movement in zero
    // elapsed time as infinite speed — an earlier version of this fixture walked
    // latitude 0..29 and had 29 of every 30 samples refused, so the cap never
    // engaged and this test passed for the wrong reason. Stationary samples
    // isolate what is actually under test here: eviction, not validation.
    for (let v = 0; v < 40; v++) {
        for (let i = 0; i < 30; i++) {
            tap({ MetaData: { MMSI: String(v), latitude: 0, longitude: 0 },
                  Message:  { PositionReport: { Sog: 1, Cog: 1 } } });
        }
    }
    const st = rec.stats();
    ok('stayed within cap despite 1200 inbound', st.samples <= CAP, `samples=${st.samples}`);
    ok('actually evicted', st.evicted > 0, `evicted=${st.evicted}`);
    console.log(`    → 1200 offered, ${st.samples} retained, ${st.evicted} evicted`);
}

console.log('\nrollingRecorder — coverage reporting');
{
    const rec = new RollingRecorder({ decimateMs: 0, maxSamples: 1e6 });
    ok('no data → no coverage', rec.coverage() === null);
    ok('no data → covers() false', rec.covers(Date.now()) === false);

    const tap = rec.tap();
    tap({ MetaData: { MMSI: '7', latitude: 1, longitude: 2 },
          Message:  { PositionReport: { Sog: 3, Cog: 4 } } });
    const c = rec.coverage();
    ok('coverage appears after a sample', c !== null && c.from <= c.to);
    ok('covers(now) true',  rec.covers(Date.now()) === true);
    ok('covers(long ago) false', rec.covers(Date.now() - 9e8) === false);
}


console.log('\nrollingRecorder — refuses teleport-grade reports at the door');
{
    // onRawMessage fires BEFORE invariants.js validates, so the buffer sees raw
    // traffic. Observed live: one MMSI jumped 66 degrees of arc in 119 s. Storing
    // that lets sampleAt() lerp a smooth, plausible track through positions the
    // vessel was never in — fabricated history that would PASS the speed check
    // the raw report failed.
    const rec = new RollingRecorder({ decimateMs: 0, maxSamples: 1e6 });
    const tap = rec.tap();
    const at = (lat, lon) => tap({
        MetaData: { MMSI: 'T1', latitude: lat, longitude: lon, ShipName: 'X', ShipType: 70 },
        Message:  { PositionReport: { Sog: 5, Cog: 90 } }
    });
    at(0, 0);          // anchor
    at(0, 66);         // ~3960 NM in milliseconds — teleport
    const arr = rec._byMmsi.get('T1');
    ok('teleport not retained', arr.length === 1, `len=${arr.length}`);
    ok('counted as rejected', rec.stats().rejectedTeleports === 1,
        `got ${rec.stats().rejectedTeleports}`);

    // A "plausible nudge" needs real elapsed time to BE plausible. An earlier
    // version of this assertion fired it in the same millisecond and expected it
    // to pass — but any movement in zero time is infinite speed, so the code was
    // right to refuse it and the expectation was wrong.
    // 2e-5 deg over ~80 ms ≈ 54 kt, comfortably under HARD_REJECT_KTS (120).
    await new Promise(r => setTimeout(r, 80));
    at(2e-5, 2e-5);
    ok('plausible movement over real elapsed time is accepted',
        rec._byMmsi.get('T1').length === 2, `len=${rec._byMmsi.get('T1').length}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
