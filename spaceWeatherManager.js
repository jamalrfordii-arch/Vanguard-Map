// spaceWeatherManager.js — Central Space Weather Data Authority
//
// Single source of truth for all NOAA SWPC real-time data consumed by
// ionosphericLayerManager, birkelandManager, and the HUD telemetry strip.
//
// ENDPOINTS  (public, no auth)
//   Kp      : noaa-planetary-k-index.json       → 0–9 geomagnetic index
//   AE      : kyoto-ae.json                      → auroral electrojet (nT)
//   Plasma  : solar-wind/plasma-7-day.json       → speed (km/s), density (p/cm³)
//   Mag     : solar-wind/mag-7-day.json          → IMF Bz (nT) — primary storm driver
//
// SHARED UNIFORMS
//   Both managers receive references to these objects at construction time.
//   The .value field is updated in-place each poll — zero allocation per frame.
//
// BROADCAST
//   Fires window 'vg1:spaceWeather' CustomEvent after every fetch cycle.
//   The HUD telemetry strip listens to this event to refresh without polling.
//
// PHYSICS NOTES
//   IMF Bz: southward (negative) reconnects with Earth's field → opens
//   magnetosphere → drives storm process. −20 nT = severe storm.
//   Solar wind dynamic pressure P = 1.67×10⁻⁶ × n × v²  (nPa)
//   where n is proton density (p/cm³) and v is speed (km/s).

export class SpaceWeatherManager {
    constructor() {
        // ── Shared uniform objects ────────────────────────────────────────────
        // Passed by reference to both managers — mutated in-place, never replaced.
        this.uKp                 = { value: 1.0   };  // 0–9 Kp index
        this.uAE                 = { value: 50.0  };  // nT auroral electrojet
        this.uSolarWindSpeed     = { value: 400.0 };  // km/s
        this.uSolarWindDensity   = { value: 5.0   };  // p/cm³
        this.uSolarWindPressure  = { value: 2.0   };  // nPa
        this.uIMFBz              = { value: 0.0   };  // nT (negative = southward = storm)

        // ── Human-readable state for HUD rendering ────────────────────────────
        this.state = {
            kp:                1.0,
            ae:                50.0,
            solarWindSpeed:    400.0,
            solarWindDensity:  5.0,
            solarWindPressure: 2.0,
            imfBz:             0.0,
            lastUpdate:        null,
            status: {
                kp:     'pending',   // 'ok' | 'error' | 'pending'
                ae:     'pending',
                plasma: 'pending',
                mag:    'pending',
            },
        };

        this._fetch();
    }

    // ── Master fetch cycle ────────────────────────────────────────────────────
    async _fetch() {
        await Promise.allSettled([
            this._fetchKp(),
            this._fetchAE(),
            this._fetchSolarWindPlasma(),
            this._fetchSolarWindMag(),
        ]);

        this.state.lastUpdate = new Date();

        window.dispatchEvent(new CustomEvent('vg1:spaceWeather', {
            detail: { ...this.state }
        }));

        console.log(
            '[SpaceWeather] Kp:', this.state.kp.toFixed(1),
            '| AE:', Math.round(this.state.ae), 'nT',
            '| SW:', Math.round(this.state.solarWindSpeed), 'km/s',
            '| P:', this.state.solarWindPressure.toFixed(1), 'nPa',
            '| Bz:', this.state.imfBz.toFixed(1), 'nT'
        );

        setTimeout(() => this._fetch(), 15 * 60 * 1000);
    }

    // ── Kp index ──────────────────────────────────────────────────────────────
    async _fetchKp() {
        try {
            const r    = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
            const data = await r.json();
            if (Array.isArray(data) && data.length > 1) {
                const kp = parseFloat(data[data.length - 1][1]);
                if (!isNaN(kp)) {
                    this.uKp.value   = kp;
                    this.state.kp    = kp;
                    this.state.status.kp = 'ok';
                }
            }
        } catch (e) {
            this.state.status.kp = 'error';
            console.warn('[SpaceWeather] Kp fetch failed:', e.message);
        }
    }

    // ── Auroral electrojet index ──────────────────────────────────────────────
    async _fetchAE() {
        try {
            const r    = await fetch('https://services.swpc.noaa.gov/products/kyoto-ae.json');
            const data = await r.json();
            if (Array.isArray(data) && data.length > 1) {
                const ae     = parseFloat(data[data.length - 1][1]);
                if (!isNaN(ae)) {
                    const safeAE     = Math.max(0, ae);
                    this.uAE.value   = safeAE;
                    this.state.ae    = safeAE;
                    this.state.status.ae = 'ok';
                }
            }
        } catch (e) {
            this.state.status.ae = 'error';
            console.warn('[SpaceWeather] AE fetch failed:', e.message);
        }
    }

    // ── Solar wind plasma (speed + density → pressure) ────────────────────────
    // Endpoint returns rows: [time_tag, density (p/cm³), speed (km/s), temperature (K)]
    async _fetchSolarWindPlasma() {
        try {
            const r    = await fetch('https://services.swpc.noaa.gov/products/solar-wind/plasma-7-day.json');
            const data = await r.json();
            if (Array.isArray(data) && data.length > 1) {
                const row     = data[data.length - 1];
                const density = parseFloat(row[1]);
                const speed   = parseFloat(row[2]);

                if (!isNaN(speed) && speed > 0) {
                    // Dynamic ram pressure: P (nPa) = 1.67×10⁻⁶ × n × v²
                    const safeDensity = isNaN(density) ? 5.0 : Math.max(0, density);
                    const pressure    = 1.67e-6 * safeDensity * speed * speed;

                    this.uSolarWindSpeed.value    = speed;
                    this.uSolarWindDensity.value  = safeDensity;
                    this.uSolarWindPressure.value = pressure;

                    this.state.solarWindSpeed    = speed;
                    this.state.solarWindDensity  = safeDensity;
                    this.state.solarWindPressure = pressure;
                    this.state.status.plasma = 'ok';
                }
            }
        } catch (e) {
            this.state.status.plasma = 'error';
            console.warn('[SpaceWeather] Solar wind plasma fetch failed:', e.message);
        }
    }

    // ── Solar wind magnetic field — IMF Bz ───────────────────────────────────
    // Endpoint returns rows: [time_tag, bx_gsm, by_gsm, bz_gsm, lon_gsm, lat_gsm, bt]
    // Bz GSM is the component most relevant to magnetospheric coupling.
    // Southward (negative) Bz drives geomagnetic storms via dayside reconnection.
    async _fetchSolarWindMag() {
        try {
            const r    = await fetch('https://services.swpc.noaa.gov/products/solar-wind/mag-7-day.json');
            const data = await r.json();
            if (Array.isArray(data) && data.length > 1) {
                const row = data[data.length - 1];
                const bz  = parseFloat(row[3]);   // GSM Bz
                if (!isNaN(bz)) {
                    this.uIMFBz.value  = bz;
                    this.state.imfBz   = bz;
                    this.state.status.mag = 'ok';
                }
            }
        } catch (e) {
            this.state.status.mag = 'error';
            console.warn('[SpaceWeather] Solar wind mag fetch failed:', e.message);
        }
    }

    // ── Aurora activity level — derived classification for HUD display ────────
    // Returns a string label based on current AE and Kp.
    getAuroraLevel() {
        const ae = this.state.ae;
        const kp = this.state.kp;
        if (ae > 600 || kp >= 6) return 'STORM';
        if (ae > 200 || kp >= 4) return 'ACTIVE';
        return 'QUIET';
    }
}
