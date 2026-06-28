// layerManager.js — Central System for all map layer state.
// Every visible layer registers here. This file owns:
//   · Which layers exist and what category they belong to
//   · On/off state and opacity per layer
//   · localStorage persistence (survives page refresh)
//   · Event dispatch so managers can react to changes
//
// Public API:
//   layerManager.register(def)          — called once per layer at init
//   layerManager.set(id, on)            — turn a layer on or off
//   layerManager.setOpacity(id, value)  — set opacity 0–1
//   layerManager.toggle(id)             — flip current state
//   layerManager.getState(id)           — { on, opacity }
//   layerManager.getCategory(cat)       — all layers in a category
//   layerManager.getAllCategories()      — ordered category list
//
// Events (window):
//   vg1:layerChanged   → { id, on, opacity }
//   vg1:layerRegistered → { id }

import { LAYER } from './config.js';

// Category display order and labels
const CATEGORIES = [
    { id: 'surface',      label: 'SURFACE',           color: '#40c4ff' },
    { id: 'atmosphere',   label: 'ATMOSPHERE',         color: '#64a0ff' },
    { id: 'geomagnetic',  label: 'GEOMAGNETIC',        color: '#ff50b4' },
    { id: 'space',        label: 'SPACE',              color: '#ff8c32' },
    { id: 'operational',  label: 'HUMAN / OPERATIONAL', color: '#ff4444' },
];

class LayerManager {
    constructor() {
        this._layers    = new Map();   // id → layer definition + live state
        this._persisted = this._load();
    }

    // ── Registration ──────────────────────────────────────────────────────────
    // Call once per layer during app init. def shape:
    // {
    //   id:         string   — unique key e.g. 'magnetic-field'
    //   category:   string   — 'surface' | 'atmosphere' | 'geomagnetic' | 'space' | 'operational'
    //   label:      string   — display name e.g. 'Magnetic Field Lines'
    //   color:      string   — signature hex color for this layer's dot
    //   defaultOn:  bool     — initial state if no saved preference exists
    //   defaultOpacity: number  — 0–1, default 1.0
    //   reserved:   bool     — if true, shown grayed out in UI (coming soon)
    // }
    register(def) {
        const saved = this._persisted[def.id] ?? {};
        const layer = {
            ...def,
            defaultOpacity: def.defaultOpacity ?? 1.0,
            on:      saved.on      ?? def.defaultOn ?? false,
            opacity: saved.opacity ?? def.defaultOpacity ?? 1.0,
        };
        this._layers.set(def.id, layer);
        window.dispatchEvent(new CustomEvent('vg1:layerRegistered', { detail: { id: def.id } }));
        return this;
    }

    // ── State reads ───────────────────────────────────────────────────────────
    getState(id) {
        const l = this._layers.get(id);
        if (!l) return { on: false, opacity: 1.0 };
        return { on: l.on, opacity: l.opacity };
    }

    isOn(id) {
        return this._layers.get(id)?.on ?? false;
    }

    getCategory(catId) {
        return [...this._layers.values()].filter(l => l.category === catId);
    }

    getAllCategories() {
        return CATEGORIES;
    }

    getLayers() {
        return [...this._layers.values()];
    }

    // ── State writes ──────────────────────────────────────────────────────────
    set(id, on) {
        const l = this._layers.get(id);
        if (!l || l.reserved) return;
        l.on = !!on;
        this._save();
        this._emit(id);
        return this;
    }

    toggle(id) {
        const l = this._layers.get(id);
        if (!l || l.reserved) return;
        return this.set(id, !l.on);
    }

    setOpacity(id, value) {
        const l = this._layers.get(id);
        if (!l || l.reserved) return;
        l.opacity = Math.max(0, Math.min(1, value));
        this._save();
        this._emit(id);
        return this;
    }

    // ── Persistence ───────────────────────────────────────────────────────────
    _load() {
        try {
            return JSON.parse(localStorage.getItem(LAYER.STORAGE_KEY) || '{}');
        } catch { return {}; }
    }

    _save() {
        const out = {};
        this._layers.forEach((l, id) => {
            out[id] = { on: l.on, opacity: l.opacity };
        });
        try { localStorage.setItem(LAYER.STORAGE_KEY, JSON.stringify(out)); } catch {}
    }

    // ── Events ────────────────────────────────────────────────────────────────
    _emit(id) {
        const l = this._layers.get(id);
        window.dispatchEvent(new CustomEvent('vg1:layerChanged', {
            detail: { id, on: l.on, opacity: l.opacity }
        }));
    }
}

// Singleton — import this everywhere
export const layerManager = new LayerManager();

// ── Layer definitions ─────────────────────────────────────────────────────────
// Register all layers here. Add new layers by appending to the relevant category.

// SURFACE
layerManager
    .register({ id: 'ais-vessels',    category: 'surface',     label: 'AIS Vessels',         color: '#40c4ff', defaultOn: true  })
    .register({ id: 'vessel-trails',  category: 'surface',     label: 'Vessel Trails',        color: '#40c4ff', defaultOn: true  })
    .register({ id: 'chokepoints',    category: 'surface',     label: 'Chokepoint Labels',    color: '#40c4ff', defaultOn: true  })
    .register({ id: 'city-labels',    category: 'surface',     label: 'City Labels',          color: '#40c4ff', defaultOn: true  })
    .register({ id: 'city-halos',     category: 'surface',     label: 'City Halos',           color: '#40c4ff', defaultOn: true  })
    .register({ id: 'borders',        category: 'surface',     label: 'Country Borders',      color: '#40c4ff', defaultOn: true  });

// ATMOSPHERE
layerManager
    .register({ id: 'clouds',         category: 'atmosphere',  label: 'Cloud Cover',          color: '#64a0ff', defaultOn: false })
    .register({ id: 'weather',        category: 'atmosphere',  label: 'Surface Wind (10m)',   color: '#64a0ff', defaultOn: false })
    .register({ id: 'wind-low',       category: 'atmosphere',  label: 'Low-Level (850mb)',    color: '#8ab8ff', defaultOn: false })
    .register({ id: 'wind-jet',       category: 'atmosphere',  label: 'Jet Stream (250mb)',   color: '#b8d8ff', defaultOn: false })
    .register({ id: 'storm-history',  category: 'atmosphere',  label: 'IBTrACS Cyclones',     color: '#ff8c5a', defaultOn: false })
    .register({ id: 'lightning',      category: 'atmosphere',  label: 'Lightning',            color: '#64a0ff', defaultOn: false, reserved: true })
    .register({ id: 'precipitation',  category: 'atmosphere',  label: 'Precipitation',        color: '#64a0ff', defaultOn: false, reserved: true });

// GEOMAGNETIC
layerManager
    .register({ id: 'magnetic-field',   category: 'geomagnetic', label: 'Magnetic Field (All)',  color: '#ff50b4', defaultOn: false })
    .register({ id: 'iono-d',           category: 'geomagnetic', label: 'D Layer  (~75 km)',      color: '#ff50b4', defaultOn: false })
    .register({ id: 'iono-e',           category: 'geomagnetic', label: 'E Layer  (~120 km)',     color: '#ff50b4', defaultOn: false })
    .register({ id: 'iono-f1',          category: 'geomagnetic', label: 'F1 Layer (~200 km)',     color: '#ff50b4', defaultOn: false })
    .register({ id: 'iono-f2',          category: 'geomagnetic', label: 'F2 Layer (~375 km)',     color: '#ff50b4', defaultOn: false })
    .register({ id: 'van-allen-inner',  category: 'geomagnetic', label: 'Inner Van Allen Belt',   color: '#ff50b4', defaultOn: false })
    .register({ id: 'van-allen-outer',  category: 'geomagnetic', label: 'Outer Van Allen Belt',   color: '#ff50b4', defaultOn: false })
    .register({ id: 'schumann',         category: 'geomagnetic', label: 'Schumann Shell',         color: '#ff50b4', defaultOn: false, reserved: true });

// SPACE
layerManager
    .register({ id: 'satellites',     category: 'space',       label: 'Satellites',           color: '#ff8c32', defaultOn: false, reserved: true })
    .register({ id: 'magnetosphere',  category: 'space',       label: 'Magnetosphere',        color: '#ff8c32', defaultOn: false, reserved: true })
    .register({ id: 'solar-wind',     category: 'space',       label: 'Solar Wind / IMF',     color: '#ff8c32', defaultOn: false, reserved: true });

// HUMAN / OPERATIONAL
layerManager
    .register({ id: 'gps-jamming',    category: 'operational', label: 'GPS Jamming Zones',    color: '#ff4444', defaultOn: false, reserved: true })
    .register({ id: 'ais-spoofing',   category: 'operational', label: 'AIS Spoofing Events',  color: '#ff4444', defaultOn: false, reserved: true })
    .register({ id: 'em-warfare',     category: 'operational', label: 'EM Warfare Overlay',   color: '#ff4444', defaultOn: false, reserved: true });
