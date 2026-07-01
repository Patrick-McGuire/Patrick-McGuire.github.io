'use strict';

const $ = (id) => document.getElementById(id);

const ui = {
  panelToggle: $('panel-toggle'),
  panelClose: $('panel-close'),
  sidePanel: $('side-panel'),
  basemapSelect: $('basemap-select'),
  locateBtn: $('locate-btn'),
  drawPathBtn: $('draw-path-btn'),
  drawSegmentBtn: $('draw-segment-btn'),
  finishPathBtn: $('finish-path-btn'),
  undoPointBtn: $('undo-point-btn'),
  clearActiveBtn: $('clear-active-btn'),
  clearPathsBtn: $('clear-paths-btn'),
  pathColor: $('path-color'),
  pathWidth: $('path-width'),
  distanceUnits: $('distance-units'),
  showDistanceLabels: $('show-distance-labels'),
  drawStatus: $('draw-status'),
  pointInput: $('point-input'),
  defaultType: $('default-type'),
  defaultSize: $('default-size'),
  defaultColor: $('default-color'),
  replaceExisting: $('replace-existing'),
  plotBtn: $('plot-btn'),
  fitBtn: $('fit-btn'),
  clearPointsBtn: $('clear-points-btn'),
  sampleBtn: $('sample-btn'),
  exportPointsBtn: $('export-points-btn'),
  pointCount: $('point-count'),
  pathCount: $('path-count'),
  errorBox: $('error-box'),
  errorList: $('error-list'),
  toast: $('toast'),
};

const MARKER_TYPES = new Set(['circle', 'pin', 'square', 'triangle', 'diamond', 'cross']);
const TYPE_ALIASES = {
  dot: 'circle',
  point: 'circle',
  marker: 'pin',
  box: 'square',
  rect: 'square',
  rectangle: 'square',
  tri: 'triangle',
  x: 'cross',
};

const SAMPLE_POINTS = [
  '42.3601,-71.0589,circle,14',
  '42.3584,-71.0636,pin,18',
  '42.3550,-71.0550,square,12',
  '42.3628,-71.0700,triangle,16',
].join('\n');

const STORAGE_KEYS = {
  panelCollapsed: 'mapPlotter.panelCollapsed',
  basemap: 'mapPlotter.basemap',
  view: 'mapPlotter.view',
  points: 'mapPlotter.points',
  distanceUnits: 'mapPlotter.distanceUnits',
  showDistanceLabels: 'mapPlotter.showDistanceLabels',
};

const DISTANCE_UNITS = {
  meters: { short: 'm', factor: 1, decimals: (value) => value < 100 ? 1 : 0 },
  kilometers: { short: 'km', factor: 0.001, decimals: (value) => value < 10 ? 3 : value < 100 ? 2 : 1 },
  feet: { short: 'ft', factor: 3.280839895, decimals: (value) => value < 100 ? 1 : 0 },
  miles: { short: 'mi', factor: 0.000621371192, decimals: (value) => value < 10 ? 3 : value < 100 ? 2 : 1 },
  nauticalMiles: { short: 'nmi', factor: 0.000539956803, decimals: (value) => value < 10 ? 3 : value < 100 ? 2 : 1 },
};

const state = {
  map: null,
  baseLayers: {},
  activeBase: null,
  pointLayer: null,
  pathLayer: null,
  activeLayer: null,
  pointRecords: [],
  drawnPaths: [],
  activePath: null,
  drawMode: null,
  toastTimer: null,
};

init();

function init() {
  initMap();
  wireUi();
  restorePreferences();
  restoreSavedPoints();
  updateStats();
  updateDrawUi();
}

function initMap() {
  state.baseLayers = {
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20,
      maxNativeZoom: 19,
      detectRetina: true,
      attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    }),
    street: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      detectRetina: true,
      attribution: '&copy; OpenStreetMap contributors',
    }),
  };

  state.pointLayer = L.layerGroup();
  state.pathLayer = L.layerGroup();
  state.activeLayer = L.layerGroup();

  state.map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    layers: [state.baseLayers.satellite, state.pathLayer, state.pointLayer, state.activeLayer],
  }).setView([39.5, -98.35], 4);

  state.activeBase = state.baseLayers.satellite;
  L.control.zoom({ position: 'bottomright' }).addTo(state.map);
  state.map.on('click', handleMapClick);
  state.map.on('moveend', saveMapView);
}

function wireUi() {
  ui.panelToggle.addEventListener('click', togglePanel);
  ui.panelClose.addEventListener('click', () => setPanelCollapsed(true));
  ui.basemapSelect.addEventListener('change', changeBasemap);
  ui.locateBtn.addEventListener('click', locateUser);

  ui.drawPathBtn.addEventListener('click', () => toggleDrawMode('path'));
  ui.drawSegmentBtn.addEventListener('click', () => toggleDrawMode('segment'));
  ui.finishPathBtn.addEventListener('click', finishActivePath);
  ui.undoPointBtn.addEventListener('click', undoActivePoint);
  ui.clearActiveBtn.addEventListener('click', clearActivePath);
  ui.clearPathsBtn.addEventListener('click', clearAllPaths);
  ui.pathColor.addEventListener('input', refreshActivePathStyle);
  ui.pathWidth.addEventListener('input', refreshActivePathStyle);
  ui.distanceUnits.addEventListener('change', () => {
    localStorage.setItem(STORAGE_KEYS.distanceUnits, ui.distanceUnits.value);
    updatePathDistanceDisplays();
  });
  ui.showDistanceLabels.addEventListener('change', () => {
    localStorage.setItem(STORAGE_KEYS.showDistanceLabels, String(ui.showDistanceLabels.checked));
    updatePathDistanceDisplays();
  });

  ui.plotBtn.addEventListener('click', plotPointsFromInput);
  ui.fitBtn.addEventListener('click', fitAllFeatures);
  ui.clearPointsBtn.addEventListener('click', clearPoints);
  ui.sampleBtn.addEventListener('click', loadSample);
  ui.exportPointsBtn.addEventListener('click', exportPoints);
}

function restorePreferences() {
  const panelCollapsed = localStorage.getItem(STORAGE_KEYS.panelCollapsed) === 'true';
  setPanelCollapsed(panelCollapsed);

  const base = localStorage.getItem(STORAGE_KEYS.basemap);
  if (base && state.baseLayers[base]) {
    ui.basemapSelect.value = base;
    changeBasemap();
  }

  const unit = localStorage.getItem(STORAGE_KEYS.distanceUnits);
  if (unit && DISTANCE_UNITS[unit]) ui.distanceUnits.value = unit;
  ui.showDistanceLabels.checked = localStorage.getItem(STORAGE_KEYS.showDistanceLabels) === 'true';

  const view = readStoredJson(STORAGE_KEYS.view);
  if (isValidView(view)) {
    state.map.setView([Number(view.lat), Number(view.lng)], Number(view.zoom));
  }
}

function setPanelCollapsed(collapsed) {
  ui.sidePanel.classList.toggle('collapsed', collapsed);
  localStorage.setItem(STORAGE_KEYS.panelCollapsed, String(collapsed));
}

function togglePanel() {
  setPanelCollapsed(!ui.sidePanel.classList.contains('collapsed'));
}

function changeBasemap() {
  const next = state.baseLayers[ui.basemapSelect.value] || state.baseLayers.satellite;
  if (next === state.activeBase) return;
  if (state.activeBase) state.map.removeLayer(state.activeBase);
  next.addTo(state.map);
  next.bringToBack();
  state.activeBase = next;
  localStorage.setItem(STORAGE_KEYS.basemap, ui.basemapSelect.value);
}

function locateUser() {
  if (!navigator.geolocation) {
    showToast('Location is not available in this browser.');
    return;
  }

  ui.locateBtn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      ui.locateBtn.disabled = false;
      const latlng = [pos.coords.latitude, pos.coords.longitude];
      state.map.setView(latlng, 16);
      L.circleMarker(latlng, {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: '#2f9e44',
        fillOpacity: 0.9,
      }).addTo(state.activeLayer);
      showToast('Centered on browser location.');
    },
    (err) => {
      ui.locateBtn.disabled = false;
      showToast(err.message || 'Could not get browser location.');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

function plotPointsFromInput() {
  const defaults = {
    type: normalizeMarkerType(ui.defaultType.value) || 'circle',
    size: clampNumber(Number(ui.defaultSize.value), 4, 48, 14),
    color: sanitizeColor(ui.defaultColor.value, '#ff6b35'),
  };

  const parsed = parsePointText(ui.pointInput.value, defaults);

  if (parsed.points.length === 0) {
    showErrors(parsed.errors);
    showToast(parsed.errors.length ? 'No valid points found.' : 'Paste points first.');
    return;
  }

  if (ui.replaceExisting.checked) clearPoints(false);
  showErrors(parsed.errors);
  parsed.points.forEach(addPoint);
  updateStats();
  savePoints();
  fitLatLngs(parsed.points.map((point) => [point.lat, point.lon]));
  showToast('Plotted ' + parsed.points.length + ' point' + (parsed.points.length === 1 ? '.' : 's.'));
}

function parsePointText(text, defaults) {
  const points = [];
  const errors = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((raw, index) => {
    const parsed = parsePointLine(raw, index + 1, defaults);
    if (!parsed) return;
    if (parsed.error) errors.push(parsed.error);
    else points.push(parsed.point);
  });

  return { points, errors };
}

function parsePointLine(raw, lineNumber, defaults) {
  let line = raw.trim();
  if (!line || line.startsWith('#') || line.startsWith('//')) return null;
  line = line.replace(/\s+#.*$/, '').trim();
  if (!line) return null;

  const parts = (line.includes(',') ? line.split(',') : line.split(/\s+/))
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) return { error: 'Line ' + lineNumber + ': missing lat/lon' };
  if (/^(lat|latitude)$/i.test(parts[0])) return null;

  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { error: 'Line ' + lineNumber + ': bad lat/lon' };
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { error: 'Line ' + lineNumber + ': lat/lon out of range' };
  }

  let type = defaults.type;
  let size = defaults.size;

  if (parts[2]) {
    const maybeSize = Number(parts[2]);
    if (Number.isFinite(maybeSize)) {
      size = maybeSize;
    } else {
      const normalized = normalizeMarkerType(parts[2]);
      if (!normalized) return { error: 'Line ' + lineNumber + ': unknown marker type' };
      type = normalized;
    }
  }

  if (parts[3]) {
    const parsedSize = Number(parts[3]);
    if (!Number.isFinite(parsedSize)) return { error: 'Line ' + lineNumber + ': bad marker size' };
    size = parsedSize;
  }

  return {
    point: {
      lat,
      lon,
      type,
      size: clampNumber(size, 4, 48, defaults.size),
      color: defaults.color,
    },
  };
}

function normalizeMarkerType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!type) return null;
  const aliased = TYPE_ALIASES[type] || type;
  return MARKER_TYPES.has(aliased) ? aliased : null;
}

function addPoint(point) {
  const marker = L.marker([point.lat, point.lon], {
    icon: makeMarkerIcon(point.type, point.size, point.color),
    keyboard: false,
  });
  marker.bindTooltip(
    point.lat.toFixed(6) + ', ' + point.lon.toFixed(6) + '<br>' + point.type + ', ' + point.size + ' px',
    { direction: 'top', opacity: 0.95 }
  );
  marker.addTo(state.pointLayer);
  state.pointRecords.push({ ...point, marker });
}

function makeMarkerIcon(type, size, color) {
  const safeType = normalizeMarkerType(type) || 'circle';
  const safeSize = clampNumber(Number(size), 4, 48, 14);
  const halfSize = safeSize / 2;
  const thickness = Math.max(4, safeSize / 4);
  const safeColor = sanitizeColor(color, '#ff6b35');
  const html = '<span class="plot-marker plot-' + safeType + '" style="--marker-size:' + safeSize + 'px;--marker-half:' + halfSize + 'px;--marker-thickness:' + thickness + 'px;--marker-color:' + safeColor + ';"></span>';
  return L.divIcon({
    className: 'plot-icon',
    html,
    iconSize: [safeSize, safeSize],
    iconAnchor: [safeSize / 2, safeSize / 2],
  });
}

function clearPoints(showMessage = true) {
  state.pointLayer.clearLayers();
  state.pointRecords = [];
  showErrors([]);
  updateStats();
  savePoints();
  if (showMessage) showToast('Cleared points.');
}

function loadSample() {
  ui.pointInput.value = SAMPLE_POINTS;
  showErrors([]);
}

function exportPoints() {
  if (state.pointRecords.length === 0) return;
  const rows = ['lat,lon,type,size'];
  state.pointRecords.forEach((point) => {
    rows.push([point.lat, point.lon, point.type, point.size].join(','));
  });
  downloadText('map_points.csv', rows.join('\n') + '\n', 'text/csv');
}

function toggleDrawMode(mode) {
  if (state.drawMode === mode) {
    state.drawMode = null;
    updateDrawUi();
    return;
  }
  state.drawMode = mode;
  if (!state.activePath) createActivePath();
  updateDrawUi();
}

function createActivePath() {
  const style = currentPathStyle();
  state.activePath = {
    points: [],
    line: L.polyline([], { ...style, dashArray: '6 7' }).addTo(state.activeLayer),
    vertices: [],
  };
}

function handleMapClick(event) {
  if (!state.drawMode) return;
  if (!state.activePath) createActivePath();

  const latlng = event.latlng;
  state.activePath.points.push(latlng);
  state.activePath.line.setLatLngs(state.activePath.points);
  const vertex = L.circleMarker(latlng, vertexStyle()).addTo(state.activeLayer);
  state.activePath.vertices.push(vertex);

  if (state.drawMode === 'segment' && state.activePath.points.length >= 2) {
    finishActivePath();
  } else {
    updateDrawUi();
  }
}

function finishActivePath() {
  const active = state.activePath;
  if (!active || active.points.length < 2) {
    showToast('A path needs at least two points.');
    updateDrawUi();
    return;
  }

  const points = active.points.map((point) => L.latLng(point.lat, point.lng));
  const style = currentPathStyle();
  const line = L.polyline(points, style).addTo(state.pathLayer);
  const distanceMeters = totalDistance(points);
  line.bindTooltip(formatDistance(distanceMeters), { sticky: true, opacity: 0.95 });
  points.forEach((point) => L.circleMarker(point, { ...vertexStyle(), radius: 3 }).addTo(state.pathLayer));

  const finishedMode = state.drawMode;
  const path = { points, line, distanceMeters, labelMarker: null };
  state.drawnPaths.push(path);
  updatePathDistanceDisplay(path);
  state.activeLayer.clearLayers();
  state.activePath = null;
  if (finishedMode === 'segment') {
    state.drawMode = 'segment';
    createActivePath();
  } else {
    state.drawMode = null;
  }
  updateStats();
  updateDrawUi();
  showToast('Saved path: ' + formatDistance(distanceMeters) + '.');
}

function undoActivePoint() {
  const active = state.activePath;
  if (!active || active.points.length === 0) return;
  const vertex = active.vertices.pop();
  if (vertex) state.activeLayer.removeLayer(vertex);
  active.points.pop();
  active.line.setLatLngs(active.points);
  if (active.points.length === 0) {
    clearActivePath(false);
  } else {
    updateDrawUi();
  }
}

function clearActivePath(showMessage = true) {
  state.activeLayer.clearLayers();
  state.activePath = null;
  state.drawMode = null;
  updateDrawUi();
  if (showMessage) showToast('Cleared active drawing.');
}

function clearAllPaths() {
  clearActivePath(false);
  state.pathLayer.clearLayers();
  state.drawnPaths = [];
  updateStats();
  updateDrawUi();
  showToast('Cleared paths.');
}

function refreshActivePathStyle() {
  if (!state.activePath) return;
  const style = currentPathStyle();
  state.activePath.line.setStyle({ ...style, dashArray: '6 7' });
  state.activePath.vertices.forEach((vertex) => vertex.setStyle(vertexStyle()));
}

function currentPathStyle() {
  return {
    color: sanitizeColor(ui.pathColor.value, '#1c7ed6'),
    weight: clampNumber(Number(ui.pathWidth.value), 1, 12, 4),
    opacity: 0.95,
    lineCap: 'round',
    lineJoin: 'round',
  };
}

function vertexStyle() {
  return {
    radius: 4,
    color: '#ffffff',
    weight: 2,
    fillColor: sanitizeColor(ui.pathColor.value, '#1c7ed6'),
    fillOpacity: 0.95,
  };
}

function updateDrawUi() {
  const activePoints = state.activePath ? state.activePath.points.length : 0;
  ui.drawPathBtn.classList.toggle('active', state.drawMode === 'path');
  ui.drawSegmentBtn.classList.toggle('active', state.drawMode === 'segment');
  ui.finishPathBtn.disabled = activePoints < 2;
  ui.undoPointBtn.disabled = activePoints === 0;
  ui.clearActiveBtn.disabled = activePoints === 0;
  ui.clearPathsBtn.disabled = state.drawnPaths.length === 0 && activePoints === 0;
  state.map.getContainer().classList.toggle('is-drawing', Boolean(state.drawMode));

  if (state.drawMode === 'segment') {
    ui.drawStatus.textContent = 'Segment: ' + activePoints + '/2';
  } else if (state.drawMode === 'path') {
    ui.drawStatus.textContent = 'Path: ' + activePoints + ' pt' + (activePoints === 1 ? '' : 's');
  } else {
    ui.drawStatus.textContent = 'Ready';
  }
}

function updatePathDistanceDisplays() {
  state.drawnPaths.forEach(updatePathDistanceDisplay);
}

function updatePathDistanceDisplay(path) {
  const text = formatDistance(path.distanceMeters);
  const tooltip = path.line.getTooltip();
  if (tooltip) tooltip.setContent(text);
  else path.line.bindTooltip(text, { sticky: true, opacity: 0.95 });

  if (ui.showDistanceLabels.checked) {
    const labelLatLng = distanceLabelLatLng(path.points, path.distanceMeters);
    if (!labelLatLng) return;
    const icon = L.divIcon({
      className: 'distance-label-icon',
      html: '<span class="distance-label">' + escapeHtml(text) + '</span>',
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    if (path.labelMarker) {
      path.labelMarker.setLatLng(labelLatLng);
      path.labelMarker.setIcon(icon);
    } else {
      path.labelMarker = L.marker(labelLatLng, {
        icon,
        interactive: false,
        keyboard: false,
      }).addTo(state.pathLayer);
    }
  } else if (path.labelMarker) {
    state.pathLayer.removeLayer(path.labelMarker);
    path.labelMarker = null;
  }
}

function fitAllFeatures() {
  const latlngs = [];
  state.pointRecords.forEach((point) => latlngs.push([point.lat, point.lon]));
  state.drawnPaths.forEach((path) => path.points.forEach((point) => latlngs.push(point)));
  if (state.activePath) state.activePath.points.forEach((point) => latlngs.push(point));

  if (latlngs.length === 0) {
    showToast('Nothing to fit.');
    return;
  }
  fitLatLngs(latlngs);
}

function fitLatLngs(latlngs) {
  if (latlngs.length === 0) return;
  if (latlngs.length === 1) {
    state.map.setView(latlngs[0], Math.max(state.map.getZoom(), 15));
    return;
  }
  state.map.fitBounds(L.latLngBounds(latlngs).pad(0.18), { maxZoom: 17 });
}

function totalDistance(points) {
  let meters = 0;
  for (let i = 1; i < points.length; i += 1) {
    meters += points[i - 1].distanceTo(points[i]);
  }
  return meters;
}

function formatDistance(meters) {
  const unit = DISTANCE_UNITS[ui.distanceUnits.value] || DISTANCE_UNITS.meters;
  const value = meters * unit.factor;
  const decimals = unit.decimals(value);
  return value.toFixed(decimals) + ' ' + unit.short;
}

function distanceLabelLatLng(points, distanceMeters) {
  if (!points.length) return null;
  if (points.length === 1 || distanceMeters <= 0) return points[0];
  const target = distanceMeters / 2;
  let traveled = 0;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    const segment = previous.distanceTo(current);
    if (traveled + segment >= target) {
      const ratio = segment > 0 ? (target - traveled) / segment : 0;
      return L.latLng(
        previous.lat + (current.lat - previous.lat) * ratio,
        previous.lng + (current.lng - previous.lng) * ratio
      );
    }
    traveled += segment;
  }
  return points[points.length - 1];
}

function saveMapView() {
  const center = state.map.getCenter();
  writeStoredJson(STORAGE_KEYS.view, {
    lat: roundCoord(center.lat),
    lng: roundCoord(center.lng),
    zoom: state.map.getZoom(),
  });
}

function savePoints() {
  writeStoredJson(STORAGE_KEYS.points, state.pointRecords.map((point) => ({
    lat: point.lat,
    lon: point.lon,
    type: point.type,
    size: point.size,
    color: point.color,
  })));
}

function restoreSavedPoints() {
  const points = readStoredJson(STORAGE_KEYS.points);
  if (!Array.isArray(points)) return;

  points.forEach((point) => {
    const restored = normalizeStoredPoint(point);
    if (restored) addPoint(restored);
  });
}

function normalizeStoredPoint(point) {
  if (!point || typeof point !== 'object') return null;
  const lat = Number(point.lat);
  const lon = Number(point.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    lat,
    lon,
    type: normalizeMarkerType(point.type) || 'circle',
    size: clampNumber(Number(point.size), 4, 48, 14),
    color: sanitizeColor(point.color, '#ff6b35'),
  };
}

function isValidView(view) {
  return view
    && Number.isFinite(Number(view.lat))
    && Number.isFinite(Number(view.lng))
    && Number.isFinite(Number(view.zoom))
    && view.lat >= -90
    && view.lat <= 90
    && view.lng >= -180
    && view.lng <= 180
    && view.zoom >= 0
    && view.zoom <= 22;
}

function readStoredJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeStoredJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {}
}

function roundCoord(value) {
  return Math.round(value * 10000000) / 10000000;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function showErrors(errors) {
  ui.errorList.textContent = '';
  ui.errorBox.hidden = errors.length === 0;
  errors.slice(0, 30).forEach((error) => {
    const item = document.createElement('li');
    item.textContent = error;
    ui.errorList.appendChild(item);
  });
  if (errors.length > 30) {
    const item = document.createElement('li');
    item.textContent = 'Plus ' + (errors.length - 30) + ' more.';
    ui.errorList.appendChild(item);
  }
}

function updateStats() {
  ui.pointCount.textContent = String(state.pointRecords.length);
  ui.pathCount.textContent = String(state.drawnPaths.length);
  ui.exportPointsBtn.disabled = state.pointRecords.length === 0;
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    ui.toast.classList.remove('show');
  }, 2400);
}

function sanitizeColor(value, fallback) {
  const color = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type: type || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
