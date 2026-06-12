### In `main.js` — Post-processing chain setup

Find where the `EffectComposer` passes are added. The fog and cloud passes must be inserted **after** the bloom pass and **before** any TAA or final output pass. The order matters: