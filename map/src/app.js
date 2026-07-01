'use strict';

const $ = (id) => document.getElementById(id);

const ui = {
  panelToggle: $('panel-toggle'),
  panelClose: $('panel-close'),
  sidePanel: $('side-panel'),
  plotTabBtn: $('plot-tab-btn'),
  elementsTabBtn: $('elements-tab-btn'),
  plotPanel: $('plot-panel'),
  elementsPanel: $('elements-panel'),
  elementTree: $('element-tree'),
  basemapSelect: $('basemap-select'),
  locateBtn: $('locate-btn'),
  drawPointBtn: $('draw-point-btn'),
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
  fitElementsBtn: $('fit-elements-btn'),
  clearElementsBtn: $('clear-elements-btn'),
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
  paths: 'mapPlotter.paths',
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
  restoreSavedPaths();
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
  ui.plotTabBtn.addEventListener('click', () => setPanelTab('plot'));
  ui.elementsTabBtn.addEventListener('click', () => setPanelTab('elements'));
  ui.basemapSelect.addEventListener('change', changeBasemap);
  ui.locateBtn.addEventListener('click', locateUser);

  ui.drawPointBtn.addEventListener('click', () => toggleDrawMode('point'));
  ui.drawPathBtn.addEventListener('click', () => toggleDrawMode('path'));
  ui.drawSegmentBtn.addEventListener('click', () => toggleDrawMode('segment'));
  ui.finishPathBtn.addEventListener('click', finishActivePath);
  ui.undoPointBtn.addEventListener('click', undoActivePoint);
  ui.clearActiveBtn.addEventListener('click', clearActivePath);
  ui.clearPathsBtn.addEventListener('click', () => clearAllPaths());
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
  ui.fitElementsBtn.addEventListener('click', fitAllFeatures);
  ui.clearElementsBtn.addEventListener('click', clearAllElements);
  ui.elementTree.addEventListener('click', handleElementTreeClick);
  ui.elementTree.addEventListener('change', handleElementTreeChange);
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

function setPanelTab(tab) {
  const showElements = tab === 'elements';
  ui.plotTabBtn.classList.toggle('active', !showElements);
  ui.elementsTabBtn.classList.toggle('active', showElements);
  ui.plotTabBtn.setAttribute('aria-selected', String(!showElements));
  ui.elementsTabBtn.setAttribute('aria-selected', String(showElements));
  ui.plotPanel.classList.toggle('active', !showElements);
  ui.elementsPanel.classList.toggle('active', showElements);
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
  const defaults = currentPointDefaults();

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

function currentPointDefaults() {
  return {
    type: normalizeMarkerType(ui.defaultType.value) || 'circle',
    size: clampNumber(Number(ui.defaultSize.value), 4, 48, 14),
    color: sanitizeColor(ui.defaultColor.value, '#ff6b35'),
  };
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
  const record = {
    lat: point.lat,
    lon: point.lon,
    type: normalizeMarkerType(point.type) || 'circle',
    size: clampNumber(Number(point.size), 4, 48, 14),
    color: sanitizeColor(point.color, '#ff6b35'),
    marker: null,
  };
  const marker = L.marker([point.lat, point.lon], {
    icon: makeMarkerIcon(record.type, record.size, record.color),
    keyboard: false,
  });
  record.marker = marker;
  updatePointTooltip(record);
  marker.addTo(state.pointLayer);
  state.pointRecords.push(record);
  return record;
}

function updatePointMarker(point) {
  point.marker.setLatLng([point.lat, point.lon]);
  point.marker.setIcon(makeMarkerIcon(point.type, point.size, point.color));
  updatePointTooltip(point);
}

function updatePointTooltip(point) {
  const text = point.lat.toFixed(6) + ', ' + point.lon.toFixed(6) + '<br>' + point.type + ', ' + point.size + ' px';
  const tooltip = point.marker.getTooltip();
  if (tooltip) tooltip.setContent(text);
  else point.marker.bindTooltip(text, { direction: 'top', opacity: 0.95 });
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
    if (mode === 'point') state.drawMode = null;
    else clearActivePath(false);
    updateDrawUi();
    return;
  }

  if (mode === 'point') {
    clearActivePath(false);
    state.drawMode = 'point';
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

  if (state.drawMode === 'point') {
    const defaults = currentPointDefaults();
    addPoint({
      lat: event.latlng.lat,
      lon: event.latlng.lng,
      type: defaults.type,
      size: defaults.size,
      color: defaults.color,
    });
    updateStats();
    savePoints();
    showToast('Added point.');
    return;
  }

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
  const finishedMode = state.drawMode;
  const path = addFinishedPath(points, style);
  state.activeLayer.clearLayers();
  state.activePath = null;
  if (finishedMode === 'segment') {
    state.drawMode = 'segment';
    createActivePath();
  } else {
    state.drawMode = null;
  }
  updateStats();
  savePaths();
  updateDrawUi();
  showToast('Saved path: ' + formatDistance(path.distanceMeters) + '.');
}

function addFinishedPath(points, style) {
  const pathStyle = normalizePathStyle(style);
  const line = L.polyline(points, pathStyle).addTo(state.pathLayer);
  const distanceMeters = totalDistance(points);
  line.bindTooltip(formatDistance(distanceMeters), { sticky: true, opacity: 0.95 });
  const vertices = points.map((point) => L.circleMarker(point, { ...vertexStyle(pathStyle.color), radius: 3 }).addTo(state.pathLayer));
  const path = {
    points,
    line,
    vertices,
    distanceMeters,
    segmentLabelMarkers: [],
    totalLabelMarker: null,
    color: pathStyle.color,
    width: pathStyle.weight,
  };
  state.drawnPaths.push(path);
  updatePathDistanceDisplay(path);
  return path;
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

function clearAllPaths(showMessage = true) {
  clearActivePath(false);
  state.pathLayer.clearLayers();
  state.drawnPaths = [];
  updateStats();
  savePaths();
  updateDrawUi();
  if (showMessage) showToast('Cleared paths.');
}

function clearAllElements() {
  if (state.pointRecords.length === 0 && state.drawnPaths.length === 0 && !state.activePath) {
    showToast('Nothing to clear.');
    return;
  }
  if (!confirm('Clear all points and paths?')) return;
  clearPoints(false);
  clearAllPaths(false);
  showToast('Cleared all elements.');
}

function refreshActivePathStyle() {
  if (!state.activePath) return;
  const style = currentPathStyle();
  state.activePath.line.setStyle({ ...style, dashArray: '6 7' });
  state.activePath.vertices.forEach((vertex) => vertex.setStyle(vertexStyle()));
}

function currentPathStyle() {
  return normalizePathStyle({
    color: sanitizeColor(ui.pathColor.value, '#1c7ed6'),
    weight: clampNumber(Number(ui.pathWidth.value), 1, 12, 4),
    opacity: 0.95,
    lineCap: 'round',
    lineJoin: 'round',
  });
}

function normalizePathStyle(style) {
  return {
    color: sanitizeColor(style && style.color, '#1c7ed6'),
    weight: clampNumber(Number(style && (style.weight ?? style.width)), 1, 12, 4),
    opacity: 0.95,
    lineCap: 'round',
    lineJoin: 'round',
  };
}

function vertexStyle(color) {
  return {
    radius: 4,
    color: '#ffffff',
    weight: 2,
    fillColor: sanitizeColor(color || ui.pathColor.value, '#1c7ed6'),
    fillOpacity: 0.95,
  };
}

function updateDrawUi() {
  const activePoints = state.activePath ? state.activePath.points.length : 0;
  ui.drawPointBtn.classList.toggle('active', state.drawMode === 'point');
  ui.drawPathBtn.classList.toggle('active', state.drawMode === 'path');
  ui.drawSegmentBtn.classList.toggle('active', state.drawMode === 'segment');
  ui.finishPathBtn.disabled = activePoints < 2;
  ui.undoPointBtn.disabled = activePoints === 0;
  ui.clearActiveBtn.disabled = activePoints === 0;
  ui.clearPathsBtn.disabled = state.drawnPaths.length === 0 && activePoints === 0;
  state.map.getContainer().classList.toggle('is-drawing', Boolean(state.drawMode));

  if (state.drawMode === 'point') {
    ui.drawStatus.textContent = 'Point: click map';
  } else if (state.drawMode === 'segment') {
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
    updateSegmentDistanceLabels(path);
    updateTotalDistanceLabel(path, text);
  } else {
    removeDistanceLabels(path);
  }
}

function updateSegmentDistanceLabels(path) {
  if (!Array.isArray(path.segmentLabelMarkers)) path.segmentLabelMarkers = [];
  const segmentCount = Math.max(0, path.points.length - 1);

  for (let i = 0; i < segmentCount; i += 1) {
    const start = path.points[i];
    const end = path.points[i + 1];
    const text = formatDistance(start.distanceTo(end));
    const latlng = segmentMidpoint(start, end);
    const icon = makeDistanceLabelIcon(text, 'segment');

    if (path.segmentLabelMarkers[i]) {
      path.segmentLabelMarkers[i].setLatLng(latlng);
      path.segmentLabelMarkers[i].setIcon(icon);
    } else {
      path.segmentLabelMarkers[i] = makeDistanceLabelMarker(latlng, icon);
    }
  }

  while (path.segmentLabelMarkers.length > segmentCount) {
    const marker = path.segmentLabelMarkers.pop();
    state.pathLayer.removeLayer(marker);
  }
}

function updateTotalDistanceLabel(path, text) {
  const labelLatLng = totalLabelLatLng(path.points);
  if (!labelLatLng) return;
  const icon = makeDistanceLabelIcon('Total: ' + text, 'total');
  if (path.totalLabelMarker) {
    path.totalLabelMarker.setLatLng(labelLatLng);
    path.totalLabelMarker.setIcon(icon);
  } else {
    path.totalLabelMarker = makeDistanceLabelMarker(labelLatLng, icon);
  }
}

function removeDistanceLabels(path) {
  if (Array.isArray(path.segmentLabelMarkers)) {
    path.segmentLabelMarkers.forEach((marker) => state.pathLayer.removeLayer(marker));
  }
  path.segmentLabelMarkers = [];
  if (path.totalLabelMarker) {
    state.pathLayer.removeLayer(path.totalLabelMarker);
    path.totalLabelMarker = null;
  }
}

function makeDistanceLabelMarker(latlng, icon) {
  return L.marker(latlng, {
    icon,
    interactive: false,
    keyboard: false,
  }).addTo(state.pathLayer);
}

function makeDistanceLabelIcon(text, type) {
  return L.divIcon({
    className: 'distance-label-icon',
    html: '<span class="distance-label ' + type + '">' + escapeHtml(text) + '</span>',
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

function renderElementTree() {
  ui.elementTree.innerHTML = [
    renderPointGroup(),
    renderPathGroup(),
  ].join('');
}

function renderPointGroup() {
  if (state.pointRecords.length === 0) {
    return '<details class="tree-group" open><summary>Points (0)</summary><div class="tree-empty">No points plotted.</div></details>';
  }

  const items = state.pointRecords.map((point, index) => {
    const lat = point.lat.toFixed(6);
    const lon = point.lon.toFixed(6);
    return '<div class="tree-item">' +
      '<div class="tree-item-head">' +
      '<div><div class="tree-title">Point ' + (index + 1) + '</div><div class="tree-meta">' + lat + ', ' + lon + '</div></div>' +
      '<button class="tree-btn" type="button" data-action="focus-point" data-index="' + index + '">Go</button>' +
      '<button class="tree-btn danger" type="button" data-action="delete-point" data-index="' + index + '">Del</button>' +
      '</div>' +
      '<div class="tree-grid">' +
      '<label><span>Lat</span><input type="number" step="0.000001" data-kind="point" data-field="lat" data-index="' + index + '" value="' + point.lat + '"></label>' +
      '<label><span>Lon</span><input type="number" step="0.000001" data-kind="point" data-field="lon" data-index="' + index + '" value="' + point.lon + '"></label>' +
      '<label><span>Type</span><select data-kind="point" data-field="type" data-index="' + index + '">' + markerTypeOptions(point.type) + '</select></label>' +
      '<label><span>Size</span><input type="number" min="4" max="48" data-kind="point" data-field="size" data-index="' + index + '" value="' + point.size + '"></label>' +
      '<label><span>Color</span><input type="color" data-kind="point" data-field="color" data-index="' + index + '" value="' + point.color + '"></label>' +
      '</div>' +
      '</div>';
  }).join('');

  return '<details class="tree-group" open><summary>Points (' + state.pointRecords.length + ')</summary><div class="tree-items">' + items + '</div></details>';
}

function renderPathGroup() {
  if (state.drawnPaths.length === 0) {
    return '<details class="tree-group" open><summary>Paths (0)</summary><div class="tree-empty">No paths or segments drawn.</div></details>';
  }

  const items = state.drawnPaths.map((path, index) => {
    const label = path.points.length === 2 ? 'Segment ' : 'Path ';
    const meta = path.points.length + ' pts, ' + formatDistance(path.distanceMeters);
    return '<div class="tree-item">' +
      '<div class="tree-item-head">' +
      '<div><div class="tree-title">' + label + (index + 1) + '</div><div class="tree-meta">' + escapeHtml(meta) + '</div></div>' +
      '<button class="tree-btn" type="button" data-action="focus-path" data-index="' + index + '">Go</button>' +
      '<button class="tree-btn danger" type="button" data-action="delete-path" data-index="' + index + '">Del</button>' +
      '</div>' +
      '<div class="tree-grid">' +
      '<label><span>Color</span><input type="color" data-kind="path" data-field="color" data-index="' + index + '" value="' + path.color + '"></label>' +
      '<label><span>Width</span><input type="number" min="1" max="12" data-kind="path" data-field="width" data-index="' + index + '" value="' + path.width + '"></label>' +
      '</div>' +
      '</div>';
  }).join('');

  return '<details class="tree-group" open><summary>Paths (' + state.drawnPaths.length + ')</summary><div class="tree-items">' + items + '</div></details>';
}

function markerTypeOptions(selectedType) {
  return Array.from(MARKER_TYPES).map((type) => {
    return '<option value="' + type + '"' + (type === selectedType ? ' selected' : '') + '>' + capitalize(type) + '</option>';
  }).join('');
}

function handleElementTreeClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const index = Number(button.dataset.index);
  if (!Number.isInteger(index)) return;

  switch (button.dataset.action) {
    case 'focus-point':
      focusPoint(index);
      break;
    case 'delete-point':
      deletePoint(index);
      break;
    case 'focus-path':
      focusPath(index);
      break;
    case 'delete-path':
      deletePath(index);
      break;
  }
}

function handleElementTreeChange(event) {
  const control = event.target;
  const kind = control.dataset.kind;
  const field = control.dataset.field;
  const index = Number(control.dataset.index);
  if (!kind || !field || !Number.isInteger(index)) return;

  if (kind === 'point') updatePointField(index, field, control.value);
  if (kind === 'path') updatePathField(index, field, control.value);
}

function updatePointField(index, field, value) {
  const point = state.pointRecords[index];
  if (!point) return;

  if (field === 'lat' || field === 'lon') {
    const numeric = Number(value);
    const min = field === 'lat' ? -90 : -180;
    const max = field === 'lat' ? 90 : 180;
    if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
      showToast('Bad ' + field + ' value.');
      renderElementTree();
      return;
    }
    point[field] = numeric;
  } else if (field === 'type') {
    point.type = normalizeMarkerType(value) || point.type;
  } else if (field === 'size') {
    point.size = clampNumber(Number(value), 4, 48, point.size);
  } else if (field === 'color') {
    point.color = sanitizeColor(value, point.color);
  }

  updatePointMarker(point);
  savePoints();
  renderElementTree();
}

function updatePathField(index, field, value) {
  const path = state.drawnPaths[index];
  if (!path) return;

  if (field === 'color') {
    path.color = sanitizeColor(value, path.color);
  } else if (field === 'width') {
    path.width = clampNumber(Number(value), 1, 12, path.width);
  }

  path.line.setStyle({ color: path.color, weight: path.width });
  path.vertices.forEach((vertex) => vertex.setStyle(vertexStyle(path.color)));
  updatePathDistanceDisplay(path);
  savePaths();
  renderElementTree();
}

function focusPoint(index) {
  const point = state.pointRecords[index];
  if (!point) return;
  state.map.setView([point.lat, point.lon], Math.max(state.map.getZoom(), 16));
  point.marker.openTooltip();
}

function focusPath(index) {
  const path = state.drawnPaths[index];
  if (!path) return;
  fitLatLngs(path.points);
  path.line.openTooltip(distanceLabelLatLng(path.points, path.distanceMeters));
}

function deletePoint(index) {
  const point = state.pointRecords[index];
  if (!point) return;
  state.pointLayer.removeLayer(point.marker);
  state.pointRecords.splice(index, 1);
  updateStats();
  savePoints();
  showToast('Deleted point.');
}

function deletePath(index) {
  const path = state.drawnPaths[index];
  if (!path) return;
  state.pathLayer.removeLayer(path.line);
  path.vertices.forEach((vertex) => state.pathLayer.removeLayer(vertex));
  removeDistanceLabels(path);
  state.drawnPaths.splice(index, 1);
  updateStats();
  savePaths();
  updateDrawUi();
  showToast('Deleted path.');
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

function segmentMidpoint(start, end) {
  return L.latLng(
    start.lat + (end.lat - start.lat) / 2,
    start.lng + (end.lng - start.lng) / 2
  );
}

function totalLabelLatLng(points) {
  if (!points.length) return null;
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

function savePaths() {
  writeStoredJson(STORAGE_KEYS.paths, state.drawnPaths.map((path) => ({
    points: path.points.map((point) => ({ lat: point.lat, lng: point.lng })),
    color: path.color,
    width: path.width,
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

function restoreSavedPaths() {
  const paths = readStoredJson(STORAGE_KEYS.paths);
  if (!Array.isArray(paths)) return;

  paths.forEach((path) => {
    const restored = normalizeStoredPath(path);
    if (restored) addFinishedPath(restored.points, restored.style);
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

function normalizeStoredPath(path) {
  if (!path || typeof path !== 'object' || !Array.isArray(path.points)) return null;
  const points = path.points.map((point) => {
    const lat = Number(point.lat);
    const lng = Number(point.lng ?? point.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return L.latLng(lat, lng);
  });
  if (points.some((point) => !point) || points.length < 2) return null;
  return {
    points,
    style: normalizePathStyle({
      color: path.color,
      width: path.width,
    }),
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

function capitalize(value) {
  const text = String(value || '');
  return text.charAt(0).toUpperCase() + text.slice(1);
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
  renderElementTree();
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
