// imageryCircuitBreaker.js — outage detector for the ArcGIS imagery endpoint.
//
// WHY (2026-07-25): the free ArcGIS export endpoint does not fail cleanly under
// load. It answers 200 OK with a solid-colour placeholder, which decodes fine,
// applies fine, and leaves the tile a flat black or olive rectangle forever.
// _isBlankImagery (tileStreamManager.js) detects these reliably — measured 0.0014
// colour SD versus 0.1016 for a healthy neighbour, a 70x gap.
//
// Detecting them was never the hard part. ACTING on them was: blank responses are
// caused by rate limiting, which is SYSTEMIC — every in-flight tile goes blank at
// the same moment. So a naive "blank → retry" turns one endpoint hiccup into ~180
// simultaneous retries, each costing a 512² readback plus a potential 28k-point
// rebuild. That is an amplifier pointed at an endpoint which is already struggling,
// and it is why the 2026-07-24 attempt was reverted the same day it shipped.
//
// This module is the missing piece that reverted note asked for. It distinguishes:
//
//   • ONE tile came back blank      → isolated glitch, retrying it is cheap and
//                                     probably works. Breaker stays CLOSED.
//   • MANY tiles blank in a window  → the endpoint is rate-limiting us. Retrying
//                                     makes it worse. Breaker OPENS and all retries
//                                     are suppressed until it recovers.
//
// Pure: no DOM, no THREE, no timers of its own — the caller passes `now`. That
// keeps it unit-testable without faking clocks, which matters because every
// interesting property here is about TIME (see tests/imageryCircuitBreaker.test.mjs).

/** Blanks within WINDOW_MS needed to call it an outage rather than a glitch. */
const DEFAULT_WINDOW_MS      = 10_000;
const DEFAULT_BLANK_THRESHOLD = 8;
/** How long to suppress retries once open. Re-armed by each new blank. */
const DEFAULT_COOL_OFF_MS    = 30_000;
/** Consecutive healthy responses that close the breaker early. */
const DEFAULT_HEALTHY_TO_CLOSE = 5;


export class ImageryCircuitBreaker {
    constructor(opts = {}) {
        this.windowMs       = opts.windowMs       ?? DEFAULT_WINDOW_MS;
        this.blankThreshold = opts.blankThreshold ?? DEFAULT_BLANK_THRESHOLD;
        this.coolOffMs      = opts.coolOffMs      ?? DEFAULT_COOL_OFF_MS;
        this.healthyToClose = opts.healthyToClose ?? DEFAULT_HEALTHY_TO_CLOSE;
        this._blanks        = [];     // timestamps, pruned to windowMs
        this._openedAt      = null;   // null = closed
        this._lastBlankAt   = null;
        this._healthyStreak = 0;
        // Lifetime counters — diagnosis only, never drive behaviour.
        this.totalBlanks    = 0;
        this.totalHealthy   = 0;
        this.timesOpened    = 0;
    }

    _prune(now) {
        const cutoff = now - this.windowMs;
        // Timestamps are appended in order, so drop from the front.
        let i = 0;
        while (i < this._blanks.length && this._blanks[i] < cutoff) i++;
        if (i > 0) this._blanks.splice(0, i);
    }

    /**
     * A blank/placeholder response arrived.
     * @returns {boolean} true if this blank tripped the breaker open.
     */
    recordBlank(now) {
        this.totalBlanks++;
        this._healthyStreak = 0;
        this._lastBlankAt = now;
        this._blanks.push(now);
        this._prune(now);

        if (this._openedAt !== null) return false;   // already open — nothing to trip
        if (this._blanks.length >= this.blankThreshold) {
            this._openedAt = now;
            this.timesOpened++;
            return true;
        }
        return false;
    }

    /** A genuine, non-blank image arrived. */
    recordHealthy(now) {
        this.totalHealthy++;
        this._healthyStreak++;
        // Early close: the endpoint is demonstrably serving real imagery again, so
        // sitting out the rest of the cool-off would just leave tiles on their
        // elevation-colour fallback for no reason. Requires a STREAK, not a single
        // success, because during rate limiting a few real responses still slip
        // through and one of those must not reopen the floodgates.
        if (this._openedAt !== null && this._healthyStreak >= this.healthyToClose) {
            this._openedAt = null;
            this._blanks.length = 0;
        }
    }

    /**
     * Should imagery retries be suppressed right now?
     * Cool-off is measured from the LAST blank, not from when it opened: a
     * sustained outage keeps re-arming it, so the breaker cannot flap back open
     * while the endpoint is still actively returning placeholders.
     */
    isOpen(now) {
        if (this._openedAt === null) return false;
        if (now - this._lastBlankAt >= this.coolOffMs) {
            this._openedAt = null;
            this._blanks.length = 0;
            return false;
        }
        return true;
    }


    stats(now = this._lastBlankAt ?? 0) {
        return {
            open:          this._openedAt !== null,
            blanksInWindow: this._blanks.length,
            threshold:     this.blankThreshold,
            healthyStreak: this._healthyStreak,
            totalBlanks:   this.totalBlanks,
            totalHealthy:  this.totalHealthy,
            timesOpened:   this.timesOpened,
            coolOffRemainingMs: this._openedAt === null ? 0
                : Math.max(0, this.coolOffMs - (now - this._lastBlankAt)),
        };
    }
}
