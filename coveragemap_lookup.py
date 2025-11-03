# scripts/coveragemap_lookup.py
import os, json, time
import requests
from playwright.sync_api import sync_playwright

ADDRESS = os.getenv('ADDRESS') or None
LAT = os.getenv('LAT') or None
LON = os.getenv('LON') or None
CALLBACK_URL = os.getenv('CALLBACK_URL')
CALLBACK_SECRET = os.getenv('CALLBACK_SECRET') or None

if not CALLBACK_URL:
    raise SystemExit("CALLBACK_URL required")

def run_lookup(address=None, lat=None, lon=None):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_default_timeout(60000)
        page.goto("https://map.coveragemap.com/", wait_until="domcontentloaded")

        captured = {"url": None}

        def on_request(req):
            try:
                u = req.url
                if "/api/v1/speedTests/square" in u:
                    captured["url"] = u
            except:
                pass

        page.on("request", on_request)

        # Try to center map programmatically if lat/lon provided
        if lat and lon:
            try:
                page.evaluate("""
                    (lat, lon) => {
                        try {
                            if (window.map && typeof window.map.setView === 'function') {
                                window.map.setView([lat, lon], 14);
                                return;
                            }
                            if (window.map && typeof window.map.jumpTo === 'function') {
                                window.map.jumpTo({ center: [lon, lat], zoom: 14 });
                                return;
                            }
                            history.replaceState(null, null, `?lat=${lat}&lng=${lon}&z=14`);
                        } catch(e) {}
                    }
                """, float(lat), float(lon))
                time.sleep(1.2)
            except Exception:
                pass

        # Click center to trigger square request
        try:
            vp = page.viewport_size or {"width": 1200, "height": 800}
            page.mouse.click(vp["width"]//2, vp["height"]//2)
        except Exception:
            pass

        # Wait a bit for requests to happen
        wait_ms = 8000
        start = time.time()
        while not captured["url"] and (time.time() - start) * 1000 < wait_ms:
            time.sleep(0.25)

        # If not captured, try search box
        if not captured["url"] and (address or (lat and lon)):
            try:
                selectors = [
                    'input[placeholder*="Search"]',
                    'input[type="search"]',
                    'input[aria-label*="Search"]',
                    'input[id*="search"]',
                    'input[class*="search"]',
                ]
                filled = False
                for sel in selectors:
                    el = page.query_selector(sel)
                    if el:
                        to_type = address if address else f"{lat}, {lon}"
                        el.fill(to_type)
                        el.press("Enter")
                        filled = True
                        break
                if not filled:
                    el = page.query_selector("input")
                    if el:
                        to_type = address if address else f"{lat}, {lon}"
                        el.fill(to_type); el.press("Enter")
            except Exception:
                pass

            # wait again
            start = time.time()
            while not captured["url"] and (time.time() - start) * 1000 < wait_ms:
                time.sleep(0.25)

        if not captured["url"]:
            browser.close()
            return {"success": False, "message": "No square request observed"}

        # Parse id param
        from urllib.parse import urlparse, parse_qs
        url = captured["url"]
        qs = parse_qs(urlparse(url).query)
        id_val = qs.get("id", [None])[0]

        # fetch the API response inside page context (to preserve session)
        api_json = None
        try:
            api_json = page.evaluate("""async (u) => {
                try {
                    const r = await fetch(u, { credentials: 'include' });
                    const text = await r.text();
                    try { return JSON.parse(text); } catch(e) { return { status: r.status, text }; }
                } catch(e) { return { error: e.message }; }
            }""", url)
        except Exception as e:
            api_json = {"error": str(e)}

        browser.close()
        return {"success": True, "id": id_val, "capturedUrl": url, "apiResponse": api_json}

# Run
result = run_lookup(ADDRESS, LAT, LON)

payload = {
    "input": {"address": ADDRESS, "lat": LAT, "lon": LON},
    "result": result
}

headers = {"Content-Type": "application/json"}
if CALLBACK_SECRET:
    headers["X-Callback-Secret"] = CALLBACK_SECRET

try:
    resp = requests.post(CALLBACK_URL, json=payload, headers=headers, timeout=20)
    print("Posted to callback:", resp.status_code)
except Exception as e:
    print("Callback POST failed:", e)
    print("Result would have been:", json.dumps(payload, indent=2))
