import base64
import html
import json
import math
import re
import struct
from pathlib import Path


HERE = Path(__file__).resolve().parent
PAGE_DIR = HERE.parent
SOURCE = HERE / "etopo_surface_0p5deg.txt"
OUTPUT = PAGE_DIR / "index.html"

ROWS = 360
COLS = 720
LAT0 = -89.99166666666666
LON0 = -179.99166666666667
STEP = 0.5
EARTH_RADIUS_KM = 6371.0088


def parse_grid(path: Path) -> list[int]:
    rows = []
    row_pattern = re.compile(r"^\[(\d+)\],\s*(.*)$")
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            match = row_pattern.match(line)
            if not match:
                continue
            values = [int(round(float(v))) for v in match.group(2).split(",")]
            rows.append((int(match.group(1)), values))
            if len(rows) == ROWS:
                break

    if len(rows) != ROWS:
        raise ValueError(f"Expected {ROWS} rows, found {len(rows)}")

    rows.sort(key=lambda item: item[0])
    flat: list[int] = []
    for index, values in rows:
        if len(values) != COLS:
            raise ValueError(f"Row {index} has {len(values)} columns, expected {COLS}")
        flat.extend(values)
    return flat


def encode_int16(values: list[int]) -> str:
    packed = struct.pack("<" + "h" * len(values), *values)
    return base64.b64encode(packed).decode("ascii")


def row_areas(values: list[int]) -> tuple[list[float], float, float, int]:
    dlon = math.radians(STEP)
    half = STEP / 2
    total_ocean_km2 = 0.0
    total_shallow_200_km2 = 0.0
    ocean_cells = 0
    areas = []
    for row in range(ROWS):
        lat = LAT0 + row * STEP
        lat1 = math.radians(max(-90.0, lat - half))
        lat2 = math.radians(min(90.0, lat + half))
        area = EARTH_RADIUS_KM * EARTH_RADIUS_KM * dlon * abs(math.sin(lat2) - math.sin(lat1))
        areas.append(area)
        offset = row * COLS
        for col in range(COLS):
            z = values[offset + col]
            if z < 0:
                ocean_cells += 1
                total_ocean_km2 += area
                if -z <= 200:
                    total_shallow_200_km2 += area
    return areas, total_ocean_km2, total_shallow_200_km2, ocean_cells


def build_html(data_b64: str, areas: list[float], total_ocean_km2: float, default_shallow_km2: float, ocean_cells: int) -> str:
    metadata = {
        "rows": ROWS,
        "cols": COLS,
        "lat0": LAT0,
        "lon0": LON0,
        "step": STEP,
        "earthRadiusKm": EARTH_RADIUS_KM,
        "totalOceanKm2": round(total_ocean_km2, 3),
        "defaultThreshold": 200,
        "defaultShallowKm2": round(default_shallow_km2, 3),
        "oceanCells": ocean_cells,
        "rowAreas": [round(a, 8) for a in areas],
    }
    metadata_json = json.dumps(metadata, separators=(",", ":"))
    source = "NOAA NCEI ETOPO 2022 Global Relief Model, 60 arc-second surface relief, sampled every 30 grid cells (~0.5 degree)."
    source_html = html.escape(source)

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ocean Area Shallower Than a Given Depth</title>
  <style>
    :root {{
      --land: #b8b8b8;
      --land-edge: #9e9e9e;
      --deep: #8fc0d8;
      --shallow: #083f73;
      --ink: #16212b;
      --muted: #5e6a73;
      --paper: #f7f5ef;
      --panel: rgba(255, 255, 255, 0.92);
      --line: rgba(22, 33, 43, 0.16);
      --accent: #d59434;
      --shadow: 0 20px 60px rgba(22, 33, 43, 0.13);
    }}

    * {{
      box-sizing: border-box;
    }}

    body {{
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.76), rgba(247,245,239,0.92)),
        repeating-linear-gradient(90deg, rgba(22,33,43,0.035) 0 1px, transparent 1px 64px),
        var(--paper);
    }}

    main {{
      width: min(1500px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 24px 0 28px;
    }}

    .figure-shell {{
      display: grid;
      grid-template-columns: minmax(0, 1fr) 330px;
      gap: 22px;
      align-items: start;
    }}

    .map-stage {{
      position: relative;
      min-height: 520px;
      padding: 20px;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background:
        radial-gradient(circle at 50% 50%, rgba(255,255,255,0.94) 0%, rgba(255,255,255,0.86) 54%, rgba(245,242,234,0.56) 100%);
      box-shadow: var(--shadow);
    }}

    canvas {{
      display: block;
      width: 100%;
      aspect-ratio: 2 / 1;
      border-radius: 4px;
    }}

    .graticule {{
      position: absolute;
      inset: 20px;
      pointer-events: none;
      border-radius: 4px;
      opacity: 0.4;
      mix-blend-mode: multiply;
    }}

    .caption {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin-top: 14px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }}

    .panel {{
      display: flex;
      flex-direction: column;
      gap: 18px;
      min-height: 520px;
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
      backdrop-filter: blur(8px);
    }}

    h1 {{
      margin: 0;
      font-size: clamp(24px, 3vw, 42px);
      line-height: 1.02;
      letter-spacing: 0;
    }}

    .subtitle {{
      margin: -8px 0 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.45;
    }}

    .metric {{
      padding: 18px 0 14px;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }}

    .metric .value {{
      display: block;
      color: var(--shallow);
      font-size: clamp(44px, 7vw, 72px);
      line-height: 0.92;
      font-weight: 800;
      letter-spacing: 0;
    }}

    .metric .label {{
      margin-top: 9px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }}

    .relation {{
      display: grid;
      gap: 8px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--line);
    }}

    .relation-head {{
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      color: var(--ink);
      font-size: 14px;
      font-weight: 800;
    }}

    .relation-head span:last-child {{
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }}

    .relation-controls {{
      display: flex;
      align-items: center;
      gap: 8px;
    }}

    .relation-controls label {{
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }}

    .relation-controls select {{
      padding: 5px 8px;
      color: var(--ink);
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      cursor: pointer;
    }}

    .relation canvas {{
      display: block;
      width: 100%;
      height: 230px;
    }}

    .control {{
      display: grid;
      gap: 10px;
    }}

    .control-row {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }}

    label {{
      color: var(--ink);
      font-size: 13px;
      font-weight: 700;
    }}

    input[type="number"] {{
      width: 112px;
      padding: 9px 10px;
      color: var(--ink);
      font: inherit;
      font-size: 14px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
    }}

    input[type="range"] {{
      width: 100%;
      accent-color: var(--shallow);
    }}

    .ticks {{
      display: flex;
      justify-content: space-between;
      color: var(--muted);
      font-size: 11px;
    }}

    .presets {{
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }}

    button {{
      min-height: 38px;
      padding: 8px 10px;
      color: var(--ink);
      font: inherit;
      font-size: 13px;
      font-weight: 700;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease;
    }}

    button:hover,
    button:focus-visible {{
      transform: translateY(-1px);
      border-color: rgba(8, 63, 115, 0.46);
      outline: none;
    }}

    button.active {{
      color: #fff;
      border-color: var(--shallow);
      background: var(--shallow);
    }}

    .legend {{
      display: grid;
      gap: 10px;
      margin-top: auto;
    }}

    .legend-item {{
      display: grid;
      grid-template-columns: 22px 1fr;
      gap: 9px;
      align-items: center;
      color: var(--muted);
      font-size: 13px;
    }}

    .swatch {{
      width: 22px;
      height: 14px;
      border-radius: 3px;
      border: 1px solid rgba(22, 33, 43, 0.14);
    }}

    .source {{
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
    }}

    .source a {{
      color: var(--shallow);
      text-decoration: none;
      border-bottom: 1px solid rgba(8, 63, 115, 0.28);
    }}

    .export-row {{
      display: flex;
      gap: 10px;
      align-items: center;
    }}

    .export-row button {{
      flex: 1;
    }}

    .micro {{
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
    }}

    @media (max-width: 980px) {{
      main {{
        width: min(100vw - 22px, 760px);
        padding-top: 12px;
      }}

      .figure-shell {{
        grid-template-columns: 1fr;
      }}

      .map-stage,
      .panel {{
        min-height: auto;
      }}

      .caption {{
        flex-direction: column;
        align-items: flex-start;
      }}

      .relation canvas {{
        height: 220px;
      }}
    }}

    @media print {{
      body {{
        background: #fff;
      }}

      main {{
        width: 100%;
        padding: 0;
      }}

      .figure-shell {{
        grid-template-columns: 1fr 300px;
        gap: 14px;
      }}

      .map-stage,
      .panel {{
        box-shadow: none;
      }}

      .export-row {{
        display: none;
      }}
    }}
  </style>
</head>
<body>
  <main>
    <section class="figure-shell" aria-label="Ocean area shallower than a selected depth">
      <div class="map-stage">
        <canvas id="map" width="1600" height="800" aria-label="World map colored by ocean depth threshold"></canvas>
        <canvas id="graticule" class="graticule" width="1600" height="800" aria-hidden="true"></canvas>
        <div class="caption">
          <span>Mollweide equal-area projection. Dark blue marks ocean cells shallower than the selected depth.</span>
          <span id="areaReadout">Calculating...</span>
        </div>
        <div class="relation" aria-label="Graph of selected depth and ocean area shallower than that depth">
          <div class="relation-head">
            <span>Cumulative relation</span>
            <span class="relation-controls">
              <label for="chartMaxDepth">Max depth shown</label>
              <select id="chartMaxDepth" aria-label="Maximum depth shown on the chart x-axis">
                <option value="1000">1 km</option>
                <option value="2000">2 km</option>
                <option value="4000">4 km</option>
                <option value="6000">6 km</option>
                <option value="11000" selected>11 km (full)</option>
              </select>
              <span id="chartPoint">200 m: --%</span>
            </span>
          </div>
          <canvas id="relationChart" aria-label="Line chart of depth threshold versus percent of ocean area shallower"></canvas>
        </div>
      </div>

      <aside class="panel">
        <h1>Ocean shallower than <span id="titleDepth">200 m</span></h1>
        <p class="subtitle">A compact global bathymetry figure from ETOPO 2022, with land held in grey and ocean split by the selected depth.</p>

        <div class="metric">
          <span class="value" id="percentValue">--%</span>
          <div class="label" id="metricLabel">of ocean area is shallower than 200 m</div>
        </div>

        <div class="control">
          <div class="control-row">
            <label for="depthRange">Depth threshold</label>
            <input id="depthNumber" type="number" min="0" max="11000" step="10" value="200" aria-label="Depth threshold in meters">
          </div>
          <input id="depthRange" type="range" min="0" max="11000" step="10" value="200" aria-label="Depth threshold in meters">
          <div class="ticks" aria-hidden="true">
            <span>0 m</span>
            <span>2,000</span>
            <span>6,000</span>
            <span>11,000 m</span>
          </div>
        </div>

        <div class="presets" aria-label="Depth presets">
          <button type="button" data-depth="50">50 m</button>
          <button type="button" data-depth="200" class="active">200 m</button>
          <button type="button" data-depth="1000">1 km</button>
          <button type="button" data-depth="4000">4 km</button>
        </div>

        <div class="legend" aria-label="Map legend">
          <div class="legend-item"><span class="swatch" style="background: var(--land);"></span><span>Land</span></div>
          <div class="legend-item"><span class="swatch" style="background: var(--shallow);"></span><span>Ocean shallower than threshold</span></div>
          <div class="legend-item"><span class="swatch" style="background: var(--deep);"></span><span>Ocean deeper than threshold</span></div>
        </div>

        <div class="export-row">
          <button type="button" id="downloadPng">Export PNG</button>
        </div>

        <p class="source">Data: <a href="https://www.ncei.noaa.gov/products/etopo-global-relief-model" target="_blank" rel="noreferrer">{source_html}</a> Area estimates use spherical cell-area weighting.</p>
        <p class="micro">This file embeds a 0.5 degree sampled grid. It is intended for figure-making rather than navigation or coastal engineering.</p>
      </aside>
    </section>
  </main>

  <script>
    const META = {metadata_json};
    const DATA_B64 = "{data_b64}";

    const colors = {{
      land: [184, 184, 184, 255],
      landEdge: [158, 158, 158, 255],
      shallow: [8, 63, 115, 255],
      deep: [143, 192, 216, 255],
      empty: [0, 0, 0, 0],
      grid: "rgba(22, 33, 43, 0.18)"
    }};

    const canvas = document.getElementById("map");
    const ctx = canvas.getContext("2d", {{ alpha: true }});
    const graticuleCanvas = document.getElementById("graticule");
    const graticuleCtx = graticuleCanvas.getContext("2d");
    const depthRange = document.getElementById("depthRange");
    const depthNumber = document.getElementById("depthNumber");
    const percentValue = document.getElementById("percentValue");
    const metricLabel = document.getElementById("metricLabel");
    const titleDepth = document.getElementById("titleDepth");
    const areaReadout = document.getElementById("areaReadout");
    const relationChart = document.getElementById("relationChart");
    const relationCtx = relationChart.getContext("2d");
    const chartPoint = document.getElementById("chartPoint");
    const presetButtons = Array.from(document.querySelectorAll("[data-depth]"));
    const chartMaxDepthSelect = document.getElementById("chartMaxDepth");
    const downloadPng = document.getElementById("downloadPng");

    function decodeInt16(base64) {{
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {{
        bytes[i] = binary.charCodeAt(i);
      }}
      return new Int16Array(bytes.buffer);
    }}

    const elevations = decodeInt16(DATA_B64);
    const pixelIndex = new Int32Array(canvas.width * canvas.height);
    const rowArea = META.rowAreas;
    const totalOceanKm2 = META.totalOceanKm2;
    const DEPTH_STEP = 10;
    const MAX_DEPTH = 11000;
    const depthArea = new Float64Array(MAX_DEPTH / DEPTH_STEP + 1);
    const cumulativeArea = new Float64Array(depthArea.length);
    const SQRT2 = Math.SQRT2;
    const TWO_SQRT2 = 2 * SQRT2;
    let currentThreshold = META.defaultThreshold;
    let chartMaxDepth = MAX_DEPTH;
    let chartResizeFrame = 0;

    function niceTicks(maxValue) {{
      const target = 4;
      const raw = maxValue / target;
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const norm = raw / mag;
      let step;
      if (norm < 1.5) step = 1 * mag;
      else if (norm < 3) step = 2 * mag;
      else if (norm < 7) step = 5 * mag;
      else step = 10 * mag;
      const ticks = [];
      for (let d = 0; d <= maxValue + 1e-6; d += step) ticks.push(Math.round(d));
      const last = ticks[ticks.length - 1];
      if (maxValue - last > step * 0.35) ticks.push(Math.round(maxValue));
      return ticks;
    }}

    function buildDepthDistribution() {{
      for (let row = 0; row < META.rows; row++) {{
        const area = rowArea[row];
        const offset = row * META.cols;
        for (let col = 0; col < META.cols; col++) {{
          const z = elevations[offset + col];
          if (z < 0) {{
            const depth = Math.min(MAX_DEPTH, Math.max(0, -z));
            depthArea[Math.ceil(depth / DEPTH_STEP)] += area;
          }}
        }}
      }}

      let running = 0;
      for (let i = 0; i < depthArea.length; i++) {{
        running += depthArea[i];
        cumulativeArea[i] = running;
      }}
    }}

    function areaForDepth(threshold) {{
      const index = Math.max(0, Math.min(cumulativeArea.length - 1, Math.round(threshold / DEPTH_STEP)));
      return cumulativeArea[index];
    }}

    function buildProjectionIndex() {{
      const w = canvas.width;
      const h = canvas.height;
      pixelIndex.fill(-1);

      for (let y = 0; y < h; y++) {{
        const yy = (1 - (2 * (y + 0.5)) / h) * SQRT2;
        if (Math.abs(yy) > SQRT2) continue;
        const theta = Math.asin(yy / SQRT2);
        const cosTheta = Math.cos(theta);
        const lat = Math.asin((2 * theta + Math.sin(2 * theta)) / Math.PI) * 180 / Math.PI;
        const row = Math.max(0, Math.min(META.rows - 1, Math.round((lat - META.lat0) / META.step)));

        for (let x = 0; x < w; x++) {{
          const xx = ((2 * (x + 0.5)) / w - 1) * TWO_SQRT2;
          const lonRad = (Math.PI * xx) / (TWO_SQRT2 * Math.max(0.000001, cosTheta));
          if (lonRad < -Math.PI || lonRad > Math.PI) continue;
          const lon = lonRad * 180 / Math.PI;
          let col = Math.round((lon - META.lon0) / META.step);
          if (col < 0) col += META.cols;
          if (col >= META.cols) col -= META.cols;
          pixelIndex[y * w + x] = row * META.cols + col;
        }}
      }}
    }}

    function drawGraticule() {{
      const w = graticuleCanvas.width;
      const h = graticuleCanvas.height;
      graticuleCtx.clearRect(0, 0, w, h);
      graticuleCtx.strokeStyle = colors.grid;
      graticuleCtx.lineWidth = 1;

      function project(lon, lat) {{
        const phi = lat * Math.PI / 180;
        const lambda = lon * Math.PI / 180;
        let theta = phi;
        for (let i = 0; i < 8; i++) {{
          const numerator = 2 * theta + Math.sin(2 * theta) - Math.PI * Math.sin(phi);
          const denominator = 2 + 2 * Math.cos(2 * theta);
          if (Math.abs(denominator) < 1e-9) break;
          theta -= numerator / denominator;
        }}
        const x = TWO_SQRT2 / Math.PI * lambda * Math.cos(theta);
        const y = SQRT2 * Math.sin(theta);
        return [
          (x / TWO_SQRT2 + 1) * w / 2,
          (1 - y / SQRT2) * h / 2
        ];
      }}

      function traceLine(points) {{
        graticuleCtx.beginPath();
        points.forEach((point, i) => {{
          if (i === 0) graticuleCtx.moveTo(point[0], point[1]);
          else graticuleCtx.lineTo(point[0], point[1]);
        }});
        graticuleCtx.stroke();
      }}

      for (let lat = -60; lat <= 60; lat += 30) {{
        const points = [];
        for (let lon = -180; lon <= 180; lon += 2) points.push(project(lon, lat));
        traceLine(points);
      }}

      for (let lon = -150; lon <= 150; lon += 30) {{
        const points = [];
        for (let lat = -89; lat <= 89; lat += 2) points.push(project(lon, lat));
        traceLine(points);
      }}

      graticuleCtx.strokeStyle = "rgba(22, 33, 43, 0.26)";
      graticuleCtx.lineWidth = 1.2;
      const outline = [];
      for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.01) {{
        outline.push([
          w / 2 + Math.cos(a) * w / 2,
          h / 2 + Math.sin(a) * h / 2
        ]);
      }}
      traceLine(outline);
    }}

    function render(threshold) {{
      currentThreshold = threshold;
      const w = canvas.width;
      const h = canvas.height;
      const image = ctx.createImageData(w, h);
      const out = image.data;
      const shallowArea = areaForDepth(threshold);

      for (let i = 0; i < pixelIndex.length; i++) {{
        const dataIndex = pixelIndex[i];
        const base = i * 4;
        if (dataIndex < 0) {{
          out[base + 3] = 0;
          continue;
        }}

        const z = elevations[dataIndex];
        const color = z >= 0 ? colors.land : (-z <= threshold ? colors.shallow : colors.deep);
        out[base] = color[0];
        out[base + 1] = color[1];
        out[base + 2] = color[2];
        out[base + 3] = color[3];
      }}

      ctx.putImageData(image, 0, 0);

      updateLabels(threshold, shallowArea);
    }}

    function prepareChartCanvas() {{
      const rect = relationChart.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(300, rect.width || relationChart.clientWidth || 760);
      const h = Math.max(180, rect.height || relationChart.clientHeight || 230);
      const pixelW = Math.round(w * dpr);
      const pixelH = Math.round(h * dpr);
      if (relationChart.width !== pixelW || relationChart.height !== pixelH) {{
        relationChart.width = pixelW;
        relationChart.height = pixelH;
      }}
      relationCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return {{ w, h }};
    }}

    function drawRelationChart(threshold) {{
      const {{ w, h }} = prepareChartCanvas();
      const margin = {{ left: 52, right: 18, top: 18, bottom: 38 }};
      const plotW = w - margin.left - margin.right;
      const plotH = h - margin.top - margin.bottom;
      const x = depth => margin.left + (Math.min(depth, chartMaxDepth) / chartMaxDepth) * plotW;
      const y = percent => margin.top + (1 - percent / 100) * plotH;

      relationCtx.clearRect(0, 0, w, h);
      relationCtx.fillStyle = "rgba(255, 255, 255, 0.55)";
      relationCtx.fillRect(0, 0, w, h);

      relationCtx.strokeStyle = "rgba(22, 33, 43, 0.12)";
      relationCtx.lineWidth = 1;
      relationCtx.fillStyle = "rgba(94, 106, 115, 0.9)";
      relationCtx.font = "11px Inter, system-ui, sans-serif";
      relationCtx.textBaseline = "middle";

      [0, 25, 50, 75, 100].forEach(percent => {{
        const yy = y(percent);
        relationCtx.beginPath();
        relationCtx.moveTo(margin.left, yy);
        relationCtx.lineTo(w - margin.right, yy);
        relationCtx.stroke();
        relationCtx.textAlign = "right";
        relationCtx.fillText(`${{percent}}`, margin.left - 10, yy);
      }});

      const xTicks = niceTicks(chartMaxDepth);
      xTicks.forEach(depth => {{
        const xx = x(depth);
        relationCtx.beginPath();
        relationCtx.moveTo(xx, margin.top);
        relationCtx.lineTo(xx, h - margin.bottom);
        relationCtx.stroke();
        relationCtx.textAlign = depth === 0 ? "left" : depth === xTicks[xTicks.length - 1] ? "right" : "center";
        relationCtx.textBaseline = "top";
        relationCtx.fillText(depth.toLocaleString(), xx, h - margin.bottom + 12);
      }});

      const gradient = relationCtx.createLinearGradient(0, margin.top, 0, h - margin.bottom);
      gradient.addColorStop(0, "rgba(8, 63, 115, 0.26)");
      gradient.addColorStop(1, "rgba(143, 192, 216, 0.06)");

      relationCtx.beginPath();
      relationCtx.moveTo(x(0), y(0));
      for (let i = 0; i < cumulativeArea.length; i++) {{
        const depth = i * DEPTH_STEP;
        if (depth > chartMaxDepth) break;
        const percent = cumulativeArea[i] / totalOceanKm2 * 100;
        relationCtx.lineTo(x(depth), y(percent));
      }}
      relationCtx.lineTo(x(chartMaxDepth), y(0));
      relationCtx.closePath();
      relationCtx.fillStyle = gradient;
      relationCtx.fill();

      relationCtx.beginPath();
      let started = false;
      for (let i = 0; i < cumulativeArea.length; i++) {{
        const depth = i * DEPTH_STEP;
        if (depth > chartMaxDepth) break;
        const percent = cumulativeArea[i] / totalOceanKm2 * 100;
        const xx = x(depth);
        const yy = y(percent);
        if (!started) {{ relationCtx.moveTo(xx, yy); started = true; }}
        else relationCtx.lineTo(xx, yy);
      }}
      relationCtx.strokeStyle = "rgb(8, 63, 115)";
      relationCtx.lineWidth = 2.5;
      relationCtx.lineJoin = "round";
      relationCtx.stroke();

      const selectedPercent = areaForDepth(threshold) / totalOceanKm2 * 100;
      const selectedX = x(threshold);
      const selectedY = y(selectedPercent);
      relationCtx.strokeStyle = "rgba(213, 148, 52, 0.75)";
      relationCtx.lineWidth = 1;
      relationCtx.beginPath();
      relationCtx.moveTo(selectedX, margin.top);
      relationCtx.lineTo(selectedX, h - margin.bottom);
      relationCtx.stroke();

      relationCtx.fillStyle = "rgb(213, 148, 52)";
      relationCtx.beginPath();
      relationCtx.arc(selectedX, selectedY, 3, 0, Math.PI * 2);
      relationCtx.fill();
      relationCtx.strokeStyle = "#fff";
      relationCtx.lineWidth = 1;
      relationCtx.stroke();

      relationCtx.save();
      relationCtx.translate(16, margin.top + plotH / 2);
      relationCtx.rotate(-Math.PI / 2);
      relationCtx.fillStyle = "rgba(94, 106, 115, 0.95)";
      relationCtx.font = "11px Inter, system-ui, sans-serif";
      relationCtx.textAlign = "center";
      relationCtx.textBaseline = "middle";
      relationCtx.fillText("Ocean area shallower (%)", 0, 0);
      relationCtx.restore();

      relationCtx.fillStyle = "rgba(94, 106, 115, 0.95)";
      relationCtx.font = "11px Inter, system-ui, sans-serif";
      relationCtx.textAlign = "center";
      relationCtx.textBaseline = "bottom";
      relationCtx.fillText("Depth threshold (m)", margin.left + plotW / 2, h - 3);
    }}

    function formatDepth(value) {{
      return value >= 1000 && value % 1000 === 0
        ? `${{value / 1000}} km`
        : `${{value.toLocaleString()}} m`;
    }}

    function updateLabels(threshold, shallowArea) {{
      const percent = shallowArea / totalOceanKm2 * 100;
      const millionKm2 = shallowArea / 1_000_000;
      const totalMillionKm2 = totalOceanKm2 / 1_000_000;
      const depthLabel = formatDepth(threshold);

      titleDepth.textContent = depthLabel;
      percentValue.textContent = `${{percent.toFixed(percent < 10 ? 1 : 0)}}%`;
      metricLabel.textContent = `of ocean area is shallower than ${{depthLabel}}`;
      areaReadout.textContent = `${{millionKm2.toFixed(1)}} million km2 of ${{totalMillionKm2.toFixed(1)}} million km2 ocean area`;
      chartPoint.textContent = `${{depthLabel}}: ${{percent.toFixed(percent < 10 ? 1 : 0)}}%`;
      drawRelationChart(threshold);

      const selectedButton = presetButtons.find(button => Number(button.dataset.depth) === threshold);
      presetButtons.forEach(button => button.classList.remove("active"));
      if (selectedButton) selectedButton.classList.add("active");
    }}

    function setDepth(rawValue) {{
      const depth = Math.max(0, Math.min(11000, Math.round(Number(rawValue) / 10) * 10));
      depthRange.value = depth;
      depthNumber.value = depth;
      render(depth);
    }}

    depthRange.addEventListener("input", event => setDepth(event.target.value));
    depthNumber.addEventListener("change", event => setDepth(event.target.value));
    presetButtons.forEach(button => {{
      button.addEventListener("click", () => setDepth(button.dataset.depth));
    }});

    chartMaxDepthSelect.addEventListener("change", event => {{
      chartMaxDepth = Math.max(200, Math.min(MAX_DEPTH, Number(event.target.value)));
      drawRelationChart(currentThreshold);
    }});

    window.addEventListener("resize", () => {{
      window.cancelAnimationFrame(chartResizeFrame);
      chartResizeFrame = window.requestAnimationFrame(() => drawRelationChart(currentThreshold));
    }});

    downloadPng.addEventListener("click", () => {{
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = canvas.width;
      exportCanvas.height = canvas.height;
      const exportCtx = exportCanvas.getContext("2d");
      exportCtx.fillStyle = "#f7f5ef";
      exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
      exportCtx.drawImage(canvas, 0, 0);
      exportCtx.drawImage(graticuleCanvas, 0, 0);
      const link = document.createElement("a");
      link.download = `ocean-shallower-than-${{depthRange.value}}m.png`;
      link.href = exportCanvas.toDataURL("image/png");
      link.click();
    }});

    buildDepthDistribution();
    buildProjectionIndex();
    drawGraticule();
    render(META.defaultThreshold);
  </script>
</body>
</html>
"""


def main() -> None:
    values = parse_grid(SOURCE)
    data_b64 = encode_int16(values)
    areas, total_ocean_km2, default_shallow_km2, ocean_cells = row_areas(values)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(build_html(data_b64, areas, total_ocean_km2, default_shallow_km2, ocean_cells), encoding="utf-8")
    print(f"Wrote {OUTPUT}")
    print(f"Ocean area: {total_ocean_km2 / 1_000_000:.2f} million km2")
    print(f"Shallow <= 200 m: {default_shallow_km2 / total_ocean_km2 * 100:.2f}%")


if __name__ == "__main__":
    main()
