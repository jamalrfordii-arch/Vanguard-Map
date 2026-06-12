# Vanguard1 — Dev Notes

## Cleanup Items (Low Priority — Revisit After Tracking)
1. **Concentric ring pattern** — visible at extreme close zoom (e.g. Buenos Aires area). Cause: grid alignment artifact bleeding through even at 0.7 jitter. Fix: increase jitter or add a second randomization pass.
2. **Close oblique foreground darkness** — terrain facing away from sun is still slightly dark at very low camera angles. The distance-aware lift helps but shadow faces need more ambient.
3. **Polar regions** — Antarctica improved but still slightly bright at edges. snowGlow + iceShimmer combination still slightly hot at peak polar latitudes.

## Next Build: Tracking + Vessels + Bathymetry
See build plan below.
