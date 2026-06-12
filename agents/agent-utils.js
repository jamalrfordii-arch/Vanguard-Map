/**
 * Shared utilities for all Vanguard1 browser agents.
 */

/**
 * Call the Anthropic API and automatically continue if the response is
 * truncated due to hitting max_tokens.  Returns the full concatenated text.
 *
 * This fixes the truncation bug where code-heavy proposals were cut off
 * mid-file because max_tokens was too low for a single response.
 *
 * @param {import('@anthropic-ai/sdk').default} client - Anthropic client
 * @param {object} params - Same params as client.messages.create()
 * @param {number} [maxContinuations=4] - Safety limit on continuation rounds
 * @returns {Promise<string>} Full concatenated text output
 */
export async function generateComplete(client, params, maxContinuations = 4) {
  let fullText = '';
  let messages = [...(params.messages || [])];
  let continuations = 0;

  while (true) {
    const response = await client.messages.create({ ...params, messages });

    const textBlocks = response.content.filter(b => b.type === 'text');
    fullText += textBlocks.map(b => b.text).join('');

    // Done — model finished naturally
    if (response.stop_reason !== 'max_tokens') break;

    // Safety limit
    if (++continuations > maxContinuations) {
      console.warn(`[generateComplete] Hit continuation limit (${maxContinuations}). Output may still be incomplete.`);
      break;
    }

    // Continue from where the model left off
    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user',      content: 'Continue exactly from where you left off. Do not repeat anything already written.' },
    ];
  }

  return fullText;
}

/**
 * Wait for the Three.js scene to initialise, then dismiss all blocking modals.
 *
 * The AIS Stream Integration modal is a dynamically-created div appended to
 * document.body — no CSS class, just inline styles. Its child button has
 * id="ais-connect-btn". We walk up from that button to find the fixed-position
 * wrapper and remove it entirely.
 */
export async function waitForSceneAndDismissModals(page) {
  // Wait for Three.js to be ready
  await page.waitForFunction(
    () => window.scene && window.controls && window.scene.children.length > 5,
    { timeout: 30_000 }
  );

  // Give the AIS manager time to append its modal to the DOM
  await new Promise(r => setTimeout(r, 1000));

  // Remove the AIS modal and seed localStorage so it won't reappear
  await page.evaluate(() => {
    // 1. Seed the AIS key in localStorage — modal skips if key exists
    localStorage.setItem('vanguard_ais_key', 'AGENT_BYPASS');

    // 2. Find the modal by its known child button id and remove the overlay
    const aisBtn = document.getElementById('ais-connect-btn');
    if (aisBtn) {
      let el = aisBtn;
      while (el && el !== document.body) {
        if (el.style && el.style.position === 'fixed') {
          el.remove();
          break;
        }
        el = el.parentElement;
      }
    }

    // 3. Also handle context-card "GOT IT" buttons
    document.querySelectorAll('button').forEach(b => {
      if (/^got it$/i.test(b.textContent.trim())) b.click();
    });

    // 4. Last resort: remove any full-screen fixed divs with high z-index
    // (catches any other overlay we haven't anticipated)
    document.querySelectorAll('div').forEach(el => {
      if (
        el.style.position === 'fixed' &&
        parseInt(el.style.zIndex || '0') >= 100 &&
        el.style.inset === '0px'
      ) {
        el.remove();
      }
    });
  });

  // Let shaders and post-processing fully settle after modal removal
  await new Promise(r => setTimeout(r, 2500));
}

/**
 * Move the camera to a position and wait for tiles/LOD to settle.
 */
export async function setCamera(page, cam, tgt, settleMs = 1500) {
  await page.evaluate(([cx, cy, cz], [tx, ty, tz]) => {
    window.controls.object.position.set(cx, cy, cz);
    window.controls.target.set(tx, ty, tz);
    window.controls.update();
  }, cam, tgt);
  await new Promise(r => setTimeout(r, settleMs));
}

/**
 * Launch a standard headless browser pointed at the map URL.
 * Uses extra stability flags to survive heavy Three.js / WebGL scenes.
 */
export async function launchBrowser(puppeteer, viewport = { width: 1280, height: 720 }) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=swiftshader',          // software renderer — no GPU crash
      '--disable-dev-shm-usage',       // prevent /dev/shm OOM on low-mem systems
      '--disable-gpu-sandbox',
      '--js-flags=--max-old-space-size=4096',  // 4 GB JS heap
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
    timeout: 60_000,
  });
  const page = await browser.newPage();
  await page.setViewport(viewport);

  // Kill the page if it crashes rather than hanging forever
  page.on('error', err => console.error('[BROWSER] Page error:', err.message));
  page.on('pageerror', err => console.error('[BROWSER] Page JS error:', err.message));

  return { browser, page };
}
