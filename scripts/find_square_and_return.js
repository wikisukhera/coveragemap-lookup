// scripts/find_square_and_return.js
// Usage env inputs: ADDRESS, LAT, LON, CALLBACK_URL, CALLBACK_SECRET
const fs = require('fs');
const fetch = require('node-fetch'); // included via npm in workflow
const { chromium } = require('playwright');

const ADDRESS = process.env.ADDRESS || '';
const LAT = process.env.LAT ? Number(process.env.LAT) : null;
const LON = process.env.LON ? Number(process.env.LON) : null;
const CALLBACK_URL = process.env.CALLBACK_URL;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET;

if (!CALLBACK_URL || !CALLBACK_SECRET) {
  console.error('Missing CALLBACK_URL or CALLBACK_SECRET');
  process.exit(2);
}

async function run() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setDefaultTimeout(60000);

  let capturedSquare = null;

  page.on('response', async res => {
    try {
      const u = res.url();
      if (!u.includes('/api/v1/')) return;
      // capture any square JSON
      if (u.includes('/api/v1/speedTests/square') || u.includes('/api/v1/speedTests/squares/lookup')) {
        try {
          const text = await res.text();
          const j = JSON.parse(text);
          capturedSquare = { url: u, status: res.status(), json: j };
          // save a local copy for debugging
          fs.writeFileSync('captured_square.json', JSON.stringify(capturedSquare, null, 2), 'utf8');
        } catch (e) {
          // ignore non-json
        }
      }
      // sometimes site emits the square data via other endpoints; also capture any /api/v1 responses
      if (!capturedSquare && res.headers()['content-type'] && res.headers()['content-type'].includes('application/json')) {
        try {
          const text = await res.text();
          const j = JSON.parse(text);
          // heuristics: look for id, provider fields
          if (j && j.data && (j.data.id || j.data.squareNumber || j.data.providers)) {
            capturedSquare = { url: u, status: res.status(), json: j };
            fs.writeFileSync('captured_square.json', JSON.stringify(capturedSquare, null, 2), 'utf8');
          }
        } catch(e){}
      }
    } catch(e){}
  });

  await page.goto('https://map.coveragemap.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // If lat/lon present, set URL query to center map, else try to search address
  if (LAT != null && LON != null) {
    try {
      await page.evaluate(({ lat, lon }) => {
        try {
          if (window.map && typeof window.map.setView === 'function') {
            window.map.setView([lat, lon], 14);
            return;
          }
          history.replaceState(null, null, `?lat=${lat}&lng=${lon}&z=14`);
        } catch(e){}
      }, { lat: LAT, lon: LON });
      await page.waitForTimeout(1200);
    } catch(e){}
  } else if (ADDRESS) {
    try {
      // try common search inputs
      const selectors = ['input[placeholder*="Search"]','input[type="search"]','input[aria-label*="Search"]','input[id*="search"]','input[class*="search"]','input'];
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) { await el.fill(ADDRESS); await el.press('Enter'); break; }
        } catch(e) {}
      }
      await page.waitForTimeout(1200);
    } catch(e){}
  }

  // attempt a sequence of interactions (grid clicks + pointer events) to force the page to request square JSON
  const vp = page.viewportSize() || { width: 1200, height: 800 };
  const cx = Math.floor(vp.width / 2), cy = Math.floor(vp.height / 2);

  // try some direct pointer events first
  await page.evaluate(({ cx, cy }) => {
    function dispatch(x,y, type){
      const el = document.elementFromPoint(x,y) || document.body;
      const ev = new PointerEvent(type, {bubbles:true,cancelable:true,clientX:x,clientY:y,pointerType:'mouse'});
      el.dispatchEvent(ev);
    }
    dispatch(cx, cy, 'pointerover'); dispatch(cx, cy, 'pointerdown'); dispatch(cx, cy, 'click'); dispatch(cx, cy, 'pointerup'); dispatch(cx, cy, 'contextmenu');
  }, { cx, cy });
  await page.waitForTimeout(400);

  // click a small grid if nothing captured yet
  if (!capturedSquare) {
    const gridSize = 7; const spacing = 30;
    const half = Math.floor(gridSize/2);
    for (let rx=-half; rx<=half && !capturedSquare; rx++) {
      for (let ry=-half; ry<=half && !capturedSquare; ry++) {
        try {
          await page.mouse.click(cx + rx*spacing, cy + ry*spacing, {delay:50});
        } catch(e){}
        await page.waitForTimeout(250);
      }
    }
  }

  // As a final attempt: call tile endpoint for a few tile coordinates around center then decode to find a candidate id.
  // But first wait for capturedSquare from network listeners for up to 6s
  const start = Date.now();
  while (!capturedSquare && Date.now() - start < 6000) {
    await page.waitForTimeout(200);
  }

  // If we captured square json -> extract square id and provider set
  let result = { found: false, reason: 'no-square-captured' };
  if (capturedSquare && capturedSquare.json && capturedSquare.json.data) {
    const d = capturedSquare.json.data;
    // normalize providers
    const providerSet = new Set();
    if (Array.isArray(d.providers)) {
      for (const p of d.providers) {
        const code = (p.provider && p.provider.providerCode) || p.providerCode || (p.provider && p.providerCode);
        if (code) providerSet.add(code);
      }
    }
    if (d.minimumProvider && d.minimumProvider.providerCode) providerSet.add(d.minimumProvider.providerCode);
    if (d.maximumProvider && d.maximumProvider.providerCode) providerSet.add(d.maximumProvider.providerCode);
    result = {
      found: true,
      squareId: d.id || d.squareId || null,
      squareNumber: d.squareNumber || null,
      latitude: d.latitude || d.lat || null,
      longitude: d.longitude || d.lon || null,
      providers: Array.from(providerSet),
      raw: d
    };
  }

  await browser.close();

  // POST result back to n8n callback
  try {
    const resp = await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-callback-secret': CALLBACK_SECRET
      },
      body: JSON.stringify(result)
    });
    console.log('Callback status:', resp.status);
  } catch (e) {
    console.error('Callback failed:', e.message || e);
    // still write result to file
    fs.writeFileSync('result_local.json', JSON.stringify(result, null, 2), 'utf8');
    process.exit(0);
  }
  // also write locally
  fs.writeFileSync('result_local.json', JSON.stringify(result, null, 2), 'utf8');
  process.exit(0);
}

run().catch(err => { console.error(err); process. Exit(3); });
