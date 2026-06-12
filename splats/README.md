# Vanguard1 — 3D Gaussian Splat captures

Drop `.splat`, `.ply` (3DGS format), or `.ksplat` files here.
Each file corresponds to a location configured in `gaussianSplatOverlay.js`.

## How to get .splat files

### Luma AI (easiest, best quality)
1. Go to https://lumalabs.ai/captures
2. Search: "port", "harbor", "container terminal", "crane", "industrial", "city"
3. Open any capture
4. Click **Export** → **3D Gaussian Splat (.splat)**
5. Save here as e.g. `rotterdam.splat`

### Polycam
1. Go to https://poly.cam/explore
2. Browse public captures → open one → **Download** → **Gaussian Splat**

### SuperSplat (optimize for faster loading)
1. Go to https://superspl.at/editor
2. Upload your .splat
3. Remove low-quality splats, compress → **Export .ksplat**
4. `.ksplat` loads ~3× faster than `.splat`

---

## Configured locations

| File                   | Location               | Lat/Lon              |
|------------------------|------------------------|----------------------|
| `rotterdam.splat`      | Port of Rotterdam      | 51.9226°N, 4.4792°E  |
| `dover.splat`          | Strait of Dover        | 51.12°N, 1.43°E      |
| `hormuz.splat`         | Strait of Hormuz       | 26.58°N, 56.25°E     |
| `jebel_ali.splat`      | Jebel Ali Port (Dubai) | 25.01°N, 55.06°E     |
| `singapore_port.splat` | Port of Singapore      | 1.265°N, 103.82°E    |
| `malacca.splat`        | Strait of Malacca      | 2.5°N, 101.5°E       |
| `long_beach.splat`     | Port of Long Beach     | 33.754°N, 118.216°W  |
| `custom.splat`         | Custom (0°N, 0°E)      | configure in JS      |

## Tuning a capture

If the capture appears at wrong scale or orientation, open the browser console:

```js
// Get the overlay entry
const entry = window.gs._overlays[0]

// Adjust scale (scene units per metre of the capture)
entry.viewer.scale.setScalar(0.005)

// Adjust height
entry.viewer.position.y = 0.8

// Rotate 90° around Y axis
entry.viewer.rotation.y = Math.PI / 2
```

Once it looks right, copy the values back into `gaussianSplatOverlay.js`.

## Add a new location at runtime

```js
window.gs.addOverlay({
    name: 'Suez Canal',
    lat:  30.42,
    lon:  32.35,
    path: './splats/suez.splat',
    sceneScale: 0.004,
    yOffset: 0.4,
})
```
