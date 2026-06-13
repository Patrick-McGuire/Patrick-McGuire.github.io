# Ocean depth visualization — build

Single-page interactive figure of global bathymetry: a Mollweide world map plus a
cumulative depth/area chart, both driven by one selectable depth threshold.

Served at `/ocean_depth/` (the compiled page is `../index.html`).

## Build

```sh
python build_ocean_depth.py
```

This reads `etopo_surface_0p5deg.txt`, embeds the bathymetry grid (as base64 int16)
plus precomputed spherical cell-area weights, and writes a fully self-contained
`../index.html` (no runtime network calls).

## Files

- `build_ocean_depth.py` — the builder (data parsing, area weighting, HTML/CSS/JS template).
- `etopo_surface_0p5deg.txt` — NOAA NCEI ETOPO 2022 60-arc-second surface relief,
  sampled to ~0.5° (360×720 grid).

## Notes

- Area estimates use per-row spherical cell areas, so percentages are equal-area-correct
  rather than pixel counts.
- The chart's "Max depth shown" selector only changes the x-axis range; the map and
  all statistics use the full depth range.
- Intended for figure-making, not navigation or coastal engineering.
