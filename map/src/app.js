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
  filesTabBtn: $('files-tab-btn'),
  filesPanel: $('files-panel'),
  elementTree: $('element-tree'),
  toolOptions: $('tool-options'),
  toolOptionsTitle: $('tool-options-title'),
  toolPointType: $('tool-point-type'),
  toolPointSize: $('tool-point-size'),
  toolPointColor: $('tool-point-color'),
  featureMenu: $('feature-menu'),
  featureMenuTitle: $('feature-menu-title'),
  featureMenuFields: $('feature-menu-fields'),
  featureMenuTreeBtn: $('feature-menu-tree-btn'),
  featureMenuDeleteBtn: $('feature-menu-delete-btn'),
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
  plotMode: $('plot-mode'),
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
  fileNameInput: $('file-name-input'),
  saveFileBtn: $('save-file-btn'),
  openComputerBtn: $('open-computer-btn'),
  openFileInput: $('open-file-input'),
  fileList: $('file-list'),
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
  files: 'mapPlotter.files',
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
  panelTab: 'plot',
  selected: null,
  dragEdit: null,
  files: [],
  toastTimer: null,
};

init();

function init() {
  initMap();
  wireUi();
  restorePreferences();
  restoreFileLibrary();
  restoreSavedPoints();
  restoreSavedPaths();
  updateStats();
  updateDrawUi();
  renderFileList();
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
  state.map.on('contextmenu', hideFeatureMenu);
  state.map.on('moveend', saveMapView);
}

function wireUi() {
  ui.panelToggle.addEventListener('click', togglePanel);
  ui.panelClose.addEventListener('click', () => setPanelCollapsed(true));
  ui.plotTabBtn.addEventListener('click', () => setPanelTab('plot'));
  ui.elementsTabBtn.addEventListener('click', () => setPanelTab('elements'));
  ui.filesTabBtn.addEventListener('click', () => setPanelTab('files'));
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
    renderElementTree();
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
  ui.clearElementsBtn.addEventListener('click', () => clearAllElements());
  ui.elementTree.addEventListener('click', handleElementTreeClick);
  ui.elementTree.addEventListener('change', handleElementTreeChange);
  ui.saveFileBtn.addEventListener('click', saveCurrentFile);
  ui.openComputerBtn.addEventListener('click', () => ui.openFileInput.click());
  ui.openFileInput.addEventListener('change', openComputerFile);
  ui.fileList.addEventListener('click', handleFileListClick);
  ui.featureMenu.addEventListener('click', (event) => event.stopPropagation());
  ui.featureMenu.addEventListener('change', handleFeatureMenuChange);
  ui.featureMenuTreeBtn.addEventListener('click', () => jumpSelectionToTree());
  ui.featureMenuDeleteBtn.addEventListener('click', deleteSelectedFeature);
  document.addEventListener('click', (event) => {
    if (!ui.featureMenu.hidden && !ui.featureMenu.contains(event.target)) hideFeatureMenu();
  });
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
  state.panelTab = tab;
  const showElements = tab === 'elements';
  const showFiles = tab === 'files';
  const showPlot = !showElements && !showFiles;
  ui.plotTabBtn.classList.toggle('active', showPlot);
  ui.elementsTabBtn.classList.toggle('active', showElements);
  ui.filesTabBtn.classList.toggle('active', showFiles);
  ui.plotTabBtn.setAttribute('aria-selected', String(showPlot));
  ui.elementsTabBtn.setAttribute('aria-selected', String(showElements));
  ui.filesTabBtn.setAttribute('aria-selected', String(showFiles));
  ui.plotPanel.classList.toggle('active', showPlot);
  ui.elementsPanel.classList.toggle('active', showElements);
  ui.filesPanel.classList.toggle('active', showFiles);
  if (showElements && state.selected) scrollSelectedTreeItem();
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

  showErrors(parsed.errors);
  if (ui.replaceExisting.checked) clearAllElements(false, false);

  if (ui.plotMode.value === 'path') {
    if (parsed.points.length < 2) {
      showToast('A connected path needs at least two points.');
      return;
    }
    const latlngs = parsed.points.map((point) => L.latLng(point.lat, point.lon));
    const path = addFinishedPath(latlngs, currentPathStyle());
    updateStats();
    savePaths();
    fitLatLngs(latlngs);
    showToast('Plotted connected path: ' + formatDistance(path.distanceMeters) + '.');
    return;
  }

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

function currentToolPointStyle() {
  return {
    type: normalizeMarkerType(ui.toolPointType.value) || 'circle',
    size: clampNumber(Number(ui.toolPointSize.value), 4, 48, 14),
    color: sanitizeColor(ui.toolPointColor.value, '#ff6b35'),
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
    draggable: true,
  });
  record.marker = marker;
  updatePointTooltip(record);
  wirePointMarker(record);
  marker.addTo(state.pointLayer);
  state.pointRecords.push(record);
  return record;
}

function wirePointMarker(point) {
  point.marker.on('click', (event) => {
    if (!canEditMapFeatures()) return;
    stopLeafletEvent(event);
    selectFeature({ kind: 'point', point }, true);
  });
  point.marker.on('contextmenu', (event) => {
    if (!canEditMapFeatures()) return;
    stopLeafletEvent(event);
    selectFeature({ kind: 'point', point }, true);
    showFeatureMenuForSelection(event.originalEvent);
  });
  point.marker.on('dragstart', () => {
    if (!canEditMapFeatures()) point.marker.dragging.disable();
    else hideFeatureMenu();
  });
  point.marker.on('dragend', () => {
    const latlng = point.marker.getLatLng();
    point.lat = latlng.lat;
    point.lon = latlng.lng;
    updatePointTooltip(point);
    savePoints();
    selectFeature({ kind: 'point', point }, false);
  });
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
  if (state.selected && state.selected.kind === 'point') state.selected = null;
  hideFeatureMenu();
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
    const defaults = currentToolPointStyle();
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
  wirePathFeature(path);
  state.drawnPaths.push(path);
  updatePathDistanceDisplay(path);
  return path;
}

function wirePathFeature(path) {
  path.line.on('click', (event) => {
    if (!canEditMapFeatures()) return;
    stopLeafletEvent(event);
    selectFeature({ kind: 'path', path }, true);
  });
  path.line.on('contextmenu', (event) => {
    if (!canEditMapFeatures()) return;
    stopLeafletEvent(event);
    selectFeature({ kind: 'path', path }, true);
    showFeatureMenuForSelection(event.originalEvent);
  });
  path.line.on('mousedown', (event) => {
    if (!canEditMapFeatures() || isRightClick(event)) return;
    stopLeafletEvent(event);
    selectFeature({ kind: 'path', path }, true);
    startPathDrag(path, event.latlng);
  });
  path.vertices.forEach((vertex, pointIndex) => wirePathVertex(path, vertex, pointIndex));
}

function wirePathVertex(path, vertex, pointIndex) {
  vertex.on('click', (event) => {
    if (!canEditMapFeatures()) return;
    stopLeafletEvent(event);
    selectFeature({ kind: 'path-point', path, pointIndex }, true);
  });
  vertex.on('contextmenu', (event) => {
    if (!canEditMapFeatures()) return;
    stopLeafletEvent(event);
    selectFeature({ kind: 'path-point', path, pointIndex }, true);
    showFeatureMenuForSelection(event.originalEvent);
  });
  vertex.on('mousedown', (event) => {
    if (!canEditMapFeatures() || isRightClick(event)) return;
    stopLeafletEvent(event);
    selectFeature({ kind: 'path-point', path, pointIndex }, true);
    startPathPointDrag(path, pointIndex);
  });
}

function startPathDrag(path, startLatLng) {
  hideFeatureMenu();
  state.dragEdit = {
    kind: 'path',
    path,
    startLatLng,
    originalPoints: path.points.map((point) => L.latLng(point.lat, point.lng)),
  };
  state.map.dragging.disable();
  state.map.getContainer().classList.add('is-editing');
  state.map.on('mousemove', handlePathDragMove);
  state.map.once('mouseup', finishPathDrag);
}

function handlePathDragMove(event) {
  const drag = state.dragEdit;
  if (!drag || drag.kind !== 'path') return;
  const deltaLat = event.latlng.lat - drag.startLatLng.lat;
  const deltaLng = event.latlng.lng - drag.startLatLng.lng;
  drag.path.points = drag.originalPoints.map((point) => L.latLng(point.lat + deltaLat, point.lng + deltaLng));
  updatePathGeometry(drag.path);
}

function finishPathDrag() {
  state.map.off('mousemove', handlePathDragMove);
  state.map.dragging.enable();
  state.map.getContainer().classList.remove('is-editing');
  if (state.dragEdit && state.dragEdit.kind === 'path') {
    savePaths();
    selectFeature({ kind: 'path', path: state.dragEdit.path }, false);
  }
  state.dragEdit = null;
}

function startPathPointDrag(path, pointIndex) {
  hideFeatureMenu();
  state.dragEdit = { kind: 'path-point', path, pointIndex };
  state.map.dragging.disable();
  state.map.getContainer().classList.add('is-editing');
  state.map.on('mousemove', handlePathPointDragMove);
  state.map.once('mouseup', finishPathPointDrag);
}

function handlePathPointDragMove(event) {
  const drag = state.dragEdit;
  if (!drag || drag.kind !== 'path-point' || !drag.path.points[drag.pointIndex]) return;
  drag.path.points[drag.pointIndex] = event.latlng;
  updatePathGeometry(drag.path);
}

function finishPathPointDrag() {
  state.map.off('mousemove', handlePathPointDragMove);
  state.map.dragging.enable();
  state.map.getContainer().classList.remove('is-editing');
  if (state.dragEdit && state.dragEdit.kind === 'path-point') {
    savePaths();
    selectFeature({
      kind: 'path-point',
      path: state.dragEdit.path,
      pointIndex: state.dragEdit.pointIndex,
    }, false);
  }
  state.dragEdit = null;
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
  if (state.selected && (state.selected.kind === 'path' || state.selected.kind === 'path-point')) state.selected = null;
  hideFeatureMenu();
  updateStats();
  savePaths();
  updateDrawUi();
  if (showMessage) showToast('Cleared paths.');
}

function clearAllElements(confirmFirst = true, showMessage = true) {
  if (state.pointRecords.length === 0 && state.drawnPaths.length === 0 && !state.activePath) {
    if (showMessage) showToast('Nothing to clear.');
    return;
  }
  if (confirmFirst && !confirm('Clear all points and paths?')) return;
  clearPoints(false);
  clearAllPaths(false);
  if (showMessage) showToast('Cleared all elements.');
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
  hideFeatureMenu();
  updateEditableInteractions();
  updateToolOptionsUi();
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

function updateEditableInteractions() {
  const editable = canEditMapFeatures();
  state.pointRecords.forEach((point) => {
    if (point.marker.dragging) {
      if (editable) point.marker.dragging.enable();
      else point.marker.dragging.disable();
    }
  });
}

function canEditMapFeatures() {
  return !state.drawMode && !state.dragEdit;
}

function selectFeature(selection, scrollTree) {
  state.selected = selection;
  renderElementTree();
  highlightSelectedFeature();
  if (scrollTree && state.panelTab === 'elements') scrollSelectedTreeItem();
}

function highlightSelectedFeature() {
  state.drawnPaths.forEach((path) => {
    path.line.setStyle({
      color: path.color,
      weight: path.width + (isSelectedPath(path) ? 2 : 0),
      opacity: isSelectedPath(path) ? 1 : 0.95,
    });
  });
}

function isSelectedPath(path) {
  return state.selected
    && (state.selected.kind === 'path' || state.selected.kind === 'path-point')
    && state.selected.path === path;
}

function selectedTreeKey() {
  if (!state.selected) return null;
  if (state.selected.kind === 'point') {
    const index = state.pointRecords.indexOf(state.selected.point);
    return index >= 0 ? 'point-' + index : null;
  }
  if (state.selected.kind === 'path') {
    const index = state.drawnPaths.indexOf(state.selected.path);
    return index >= 0 ? 'path-' + index : null;
  }
  if (state.selected.kind === 'path-point') {
    const index = state.drawnPaths.indexOf(state.selected.path);
    return index >= 0 ? 'path-' + index + '-point-' + state.selected.pointIndex : null;
  }
  return null;
}

function scrollSelectedTreeItem() {
  const key = selectedTreeKey();
  if (!key) return;
  requestAnimationFrame(() => {
    const node = ui.elementTree.querySelector('[data-tree-key="' + key + '"]');
    if (node) node.scrollIntoView({ block: 'nearest' });
  });
}

function showFeatureMenuForSelection(originalEvent) {
  if (!state.selected) return;
  renderFeatureMenuFields();
  const left = Math.min(originalEvent.clientX, window.innerWidth - 220);
  const top = Math.min(originalEvent.clientY, window.innerHeight - 170);
  ui.featureMenu.style.left = Math.max(8, left) + 'px';
  ui.featureMenu.style.top = Math.max(8, top) + 'px';
  ui.featureMenu.hidden = false;
}

function renderFeatureMenuFields() {
  const selected = state.selected;
  if (!selected) return;

  if (selected.kind === 'point') {
    ui.featureMenuTitle.textContent = 'Point';
    ui.featureMenuFields.innerHTML =
      '<label><span>Type</span><select data-menu-field="type">' + markerTypeOptions(selected.point.type) + '</select></label>' +
      '<label><span>Size</span><input type="number" min="4" max="48" data-menu-field="size" value="' + selected.point.size + '"></label>' +
      '<label><span>Color</span><input type="color" data-menu-field="color" value="' + selected.point.color + '"></label>';
    return;
  }

  if (selected.kind === 'path' || selected.kind === 'path-point') {
    const path = selected.path;
    ui.featureMenuTitle.textContent = selected.kind === 'path-point' ? 'Path Point' : (path.points.length === 2 ? 'Segment' : 'Path');
    ui.featureMenuFields.innerHTML =
      '<label><span>Color</span><input type="color" data-menu-field="color" value="' + path.color + '"></label>' +
      '<label><span>Width</span><input type="number" min="1" max="12" data-menu-field="width" value="' + path.width + '"></label>';
  }
}

function handleFeatureMenuChange(event) {
  const field = event.target.dataset.menuField;
  if (!field || !state.selected) return;

  if (state.selected.kind === 'point') {
    const index = state.pointRecords.indexOf(state.selected.point);
    if (index >= 0) updatePointField(index, field, event.target.value);
  } else if (state.selected.kind === 'path' || state.selected.kind === 'path-point') {
    const index = state.drawnPaths.indexOf(state.selected.path);
    if (index >= 0) updatePathField(index, field, event.target.value);
  }
  renderElementTree();
  renderFeatureMenuFields();
}

function jumpSelectionToTree() {
  if (!state.selected) return;
  setPanelTab('elements');
  renderElementTree();
  scrollSelectedTreeItem();
}

function deleteSelectedFeature() {
  if (!state.selected) return;
  if (state.selected.kind === 'point') {
    const index = state.pointRecords.indexOf(state.selected.point);
    if (index >= 0) deletePoint(index);
  } else if (state.selected.kind === 'path') {
    const index = state.drawnPaths.indexOf(state.selected.path);
    if (index >= 0) deletePath(index);
  } else if (state.selected.kind === 'path-point') {
    const pathIndex = state.drawnPaths.indexOf(state.selected.path);
    if (pathIndex >= 0) {
      if (state.selected.path.points.length <= 2) deletePath(pathIndex);
      else deletePathPoint(pathIndex, state.selected.pointIndex);
    }
  }
  hideFeatureMenu();
}

function hideFeatureMenu() {
  if (ui.featureMenu) ui.featureMenu.hidden = true;
}

function stopLeafletEvent(event) {
  if (event && event.originalEvent) L.DomEvent.stop(event.originalEvent);
}

function isRightClick(event) {
  return event && event.originalEvent && event.originalEvent.button === 2;
}

function updateToolOptionsUi() {
  const hasTool = state.drawMode === 'point' || state.drawMode === 'path' || state.drawMode === 'segment';
  ui.toolOptions.hidden = !hasTool;
  ui.toolOptions.classList.toggle('point-mode', state.drawMode === 'point');
  ui.toolOptions.classList.toggle('line-mode', state.drawMode === 'path' || state.drawMode === 'segment');
  if (state.drawMode === 'point') ui.toolOptionsTitle.textContent = 'Point Style';
  else if (state.drawMode === 'segment') ui.toolOptionsTitle.textContent = 'Segment Style';
  else if (state.drawMode === 'path') ui.toolOptionsTitle.textContent = 'Path Style';
  else ui.toolOptionsTitle.textContent = 'Tool Options';
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
  if (path.points.length <= 2) {
    if (path.totalLabelMarker) {
      state.pathLayer.removeLayer(path.totalLabelMarker);
      path.totalLabelMarker = null;
    }
    return;
  }
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
  const selectedKey = selectedTreeKey();
  const rows = [];
  state.pointRecords.forEach((point, index) => rows.push(renderPointFeature(point, index, selectedKey)));
  state.drawnPaths.forEach((path, index) => rows.push(renderPathFeature(path, index, selectedKey)));
  ui.elementTree.innerHTML = rows.length
    ? '<div class="tree-items">' + rows.join('') + '</div>'
    : '<div class="tree-empty">No plotted elements.</div>';
}

function renderPointFeature(point, index, selectedKey) {
  const key = 'point-' + index;
  const selected = selectedKey === key;
  const lat = point.lat.toFixed(6);
  const lon = point.lon.toFixed(6);
  return '<details class="tree-item' + (selected ? ' selected' : '') + '" data-tree-key="' + key + '"' + (selected ? ' open' : '') + '>' +
    '<summary>' +
    '<span class="tree-toggle"></span>' +
    '<span><span class="tree-title">Point ' + (index + 1) + '</span><span class="tree-meta">' + lat + ', ' + lon + '</span></span>' +
    '<button class="tree-btn" type="button" data-action="focus-point" data-index="' + index + '">Go</button>' +
    '<button class="tree-btn danger" type="button" data-action="delete-point" data-index="' + index + '">Del</button>' +
    '</summary>' +
    '<div class="tree-body">' +
    '<div class="tree-grid">' +
    '<label><span>Lat</span><input type="number" step="0.000001" data-kind="point" data-field="lat" data-index="' + index + '" value="' + point.lat + '"></label>' +
    '<label><span>Lon</span><input type="number" step="0.000001" data-kind="point" data-field="lon" data-index="' + index + '" value="' + point.lon + '"></label>' +
    '<label><span>Type</span><select data-kind="point" data-field="type" data-index="' + index + '">' + markerTypeOptions(point.type) + '</select></label>' +
    '<label><span>Size</span><input type="number" min="4" max="48" data-kind="point" data-field="size" data-index="' + index + '" value="' + point.size + '"></label>' +
    '<label><span>Color</span><input type="color" data-kind="point" data-field="color" data-index="' + index + '" value="' + point.color + '"></label>' +
    '</div>' +
    '</div>' +
    '</details>';
}

function renderPathFeature(path, index, selectedKey) {
  const key = 'path-' + index;
  const selected = selectedKey === key || (selectedKey && selectedKey.startsWith(key + '-point-'));
  const label = path.points.length === 2 ? 'Segment ' : 'Path ';
  const meta = path.points.length + ' pts, ' + formatDistance(path.distanceMeters);
  const pointRows = path.points.map((point, pointIndex) => renderPathPointFeature(path, index, point, pointIndex, selectedKey)).join('');
  return '<details class="tree-item' + (selected ? ' selected' : '') + '" data-tree-key="' + key + '"' + (selected ? ' open' : '') + '>' +
    '<summary>' +
    '<span class="tree-toggle"></span>' +
    '<span><span class="tree-title">' + label + (index + 1) + '</span><span class="tree-meta">' + escapeHtml(meta) + '</span></span>' +
    '<button class="tree-btn" type="button" data-action="focus-path" data-index="' + index + '">Go</button>' +
    '<button class="tree-btn danger" type="button" data-action="delete-path" data-index="' + index + '">Del</button>' +
    '</summary>' +
    '<div class="tree-body">' +
    '<div class="tree-grid">' +
    '<label><span>Color</span><input type="color" data-kind="path" data-field="color" data-index="' + index + '" value="' + path.color + '"></label>' +
    '<label><span>Width</span><input type="number" min="1" max="12" data-kind="path" data-field="width" data-index="' + index + '" value="' + path.width + '"></label>' +
    '</div>' +
    '<div class="tree-subhead">Points</div>' +
    '<div class="element-tree">' + pointRows + '</div>' +
    '</div>' +
    '</details>';
}

function renderPathPointFeature(path, pathIndex, point, pointIndex, selectedKey) {
  const key = 'path-' + pathIndex + '-point-' + pointIndex;
  const selected = selectedKey === key;
  const canDelete = path.points.length > 2;
  return '<details class="tree-point' + (selected ? ' selected' : '') + '" data-tree-key="' + key + '"' + (selected ? ' open' : '') + '>' +
    '<summary>' +
    '<span class="tree-toggle"></span>' +
    '<span><span class="tree-title">Point ' + (pointIndex + 1) + '</span><span class="tree-meta">' + point.lat.toFixed(6) + ', ' + point.lng.toFixed(6) + '</span></span>' +
    '<button class="tree-btn" type="button" data-action="focus-path-point" data-path-index="' + pathIndex + '" data-point-index="' + pointIndex + '">Go</button>' +
    (canDelete ? '<button class="tree-btn danger" type="button" data-action="delete-path-point" data-path-index="' + pathIndex + '" data-point-index="' + pointIndex + '">Del</button>' : '') +
    '</summary>' +
    '<div class="tree-body">' +
    '<div class="tree-grid">' +
    '<label><span>Lat</span><input type="number" step="0.000001" data-kind="path-point" data-field="lat" data-path-index="' + pathIndex + '" data-point-index="' + pointIndex + '" value="' + point.lat + '"></label>' +
    '<label><span>Lon</span><input type="number" step="0.000001" data-kind="path-point" data-field="lng" data-path-index="' + pathIndex + '" data-point-index="' + pointIndex + '" value="' + point.lng + '"></label>' +
    '</div>' +
    '</div>' +
    '</details>';
}

function markerTypeOptions(selectedType) {
  return Array.from(MARKER_TYPES).map((type) => {
    return '<option value="' + type + '"' + (type === selectedType ? ' selected' : '') + '>' + capitalize(type) + '</option>';
  }).join('');
}

function handleElementTreeClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const index = Number(button.dataset.index);
  const pathIndex = Number(button.dataset.pathIndex);
  const pointIndex = Number(button.dataset.pointIndex);

  switch (button.dataset.action) {
    case 'focus-point':
      if (!Number.isInteger(index)) return;
      focusPoint(index);
      break;
    case 'delete-point':
      if (!Number.isInteger(index)) return;
      deletePoint(index);
      break;
    case 'focus-path':
      if (!Number.isInteger(index)) return;
      focusPath(index);
      break;
    case 'delete-path':
      if (!Number.isInteger(index)) return;
      deletePath(index);
      break;
    case 'focus-path-point':
      if (!Number.isInteger(pathIndex) || !Number.isInteger(pointIndex)) return;
      focusPathPoint(pathIndex, pointIndex);
      break;
    case 'delete-path-point':
      if (!Number.isInteger(pathIndex) || !Number.isInteger(pointIndex)) return;
      deletePathPoint(pathIndex, pointIndex);
      break;
  }
}

function handleElementTreeChange(event) {
  const control = event.target;
  const kind = control.dataset.kind;
  const field = control.dataset.field;
  const index = Number(control.dataset.index);
  if (!kind || !field) return;

  if (kind === 'point' && Number.isInteger(index)) updatePointField(index, field, control.value);
  if (kind === 'path' && Number.isInteger(index)) updatePathField(index, field, control.value);
  if (kind === 'path-point') {
    const pathIndex = Number(control.dataset.pathIndex);
    const pointIndex = Number(control.dataset.pointIndex);
    if (Number.isInteger(pathIndex) && Number.isInteger(pointIndex)) {
      updatePathPointField(pathIndex, pointIndex, field, control.value);
    }
  }
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
  highlightSelectedFeature();
  updatePathDistanceDisplay(path);
  savePaths();
}

function updatePathPointField(pathIndex, pointIndex, field, value) {
  const path = state.drawnPaths[pathIndex];
  if (!path || !path.points[pointIndex]) return;

  const numeric = Number(value);
  const isLat = field === 'lat';
  const min = isLat ? -90 : -180;
  const max = isLat ? 90 : 180;
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
    showToast('Bad ' + (isLat ? 'lat' : 'lon') + ' value.');
    renderElementTree();
    return;
  }

  path.points[pointIndex] = L.latLng(
    isLat ? numeric : path.points[pointIndex].lat,
    isLat ? path.points[pointIndex].lng : numeric
  );
  updatePathGeometry(path);
  savePaths();
}

function updatePathGeometry(path) {
  path.distanceMeters = totalDistance(path.points);
  path.line.setLatLngs(path.points);
  path.vertices.forEach((vertex, index) => {
    if (path.points[index]) vertex.setLatLng(path.points[index]);
  });
  updatePathDistanceDisplay(path);
}

function rebuildPathVertices(path) {
  path.vertices.forEach((vertex) => state.pathLayer.removeLayer(vertex));
  path.vertices = path.points.map((point, pointIndex) => {
    const vertex = L.circleMarker(point, { ...vertexStyle(path.color), radius: 3 }).addTo(state.pathLayer);
    wirePathVertex(path, vertex, pointIndex);
    return vertex;
  });
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

function focusPathPoint(pathIndex, pointIndex) {
  const path = state.drawnPaths[pathIndex];
  if (!path || !path.points[pointIndex]) return;
  state.map.setView(path.points[pointIndex], Math.max(state.map.getZoom(), 16));
}

function deletePoint(index) {
  const point = state.pointRecords[index];
  if (!point) return;
  state.pointLayer.removeLayer(point.marker);
  state.pointRecords.splice(index, 1);
  if (state.selected && state.selected.point === point) state.selected = null;
  hideFeatureMenu();
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
  if (state.selected && state.selected.path === path) state.selected = null;
  hideFeatureMenu();
  updateStats();
  savePaths();
  updateDrawUi();
  showToast('Deleted path.');
}

function deletePathPoint(pathIndex, pointIndex) {
  const path = state.drawnPaths[pathIndex];
  if (!path || path.points.length <= 2 || !path.points[pointIndex]) return;
  path.points.splice(pointIndex, 1);
  const vertex = path.vertices.splice(pointIndex, 1)[0];
  if (vertex) state.pathLayer.removeLayer(vertex);
  rebuildPathVertices(path);
  updatePathGeometry(path);
  savePaths();
  state.selected = { kind: 'path', path };
  renderElementTree();
  showToast('Deleted path point.');
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

function restoreFileLibrary() {
  const files = readStoredJson(STORAGE_KEYS.files);
  state.files = Array.isArray(files) ? files.filter(isValidSnapshot).map(normalizeSnapshotSummary) : [];
}

function saveFileLibrary() {
  writeStoredJson(STORAGE_KEYS.files, state.files);
  renderFileList();
}

function saveCurrentFile() {
  const name = cleanFileName(ui.fileNameInput.value || 'map-file');
  const snapshot = createMapSnapshot(name);
  state.files.unshift(snapshot);
  state.files = state.files.slice(0, 30);
  saveFileLibrary();
  downloadText(name + '.json', JSON.stringify(snapshot, null, 2), 'application/json');
  showToast('Saved ' + name + '.');
}

function createMapSnapshot(name) {
  const center = state.map.getCenter();
  return {
    version: 1,
    id: 'map-' + Date.now().toString(36),
    name,
    savedAt: new Date().toISOString(),
    view: {
      lat: roundCoord(center.lat),
      lng: roundCoord(center.lng),
      zoom: state.map.getZoom(),
    },
    basemap: ui.basemapSelect.value,
    distanceUnits: ui.distanceUnits.value,
    showDistanceLabels: ui.showDistanceLabels.checked,
    points: state.pointRecords.map((point) => ({
      lat: point.lat,
      lon: point.lon,
      type: point.type,
      size: point.size,
      color: point.color,
    })),
    paths: state.drawnPaths.map((path) => ({
      points: path.points.map((point) => ({ lat: point.lat, lng: point.lng })),
      color: path.color,
      width: path.width,
    })),
  };
}

function renderFileList() {
  if (!ui.fileList) return;
  if (state.files.length === 0) {
    ui.fileList.innerHTML = '<div class="tree-empty">No saved files in this browser.</div>';
    return;
  }
  ui.fileList.innerHTML = state.files.map((file, index) => {
    const meta = (file.points ? file.points.length : 0) + ' pts, ' + (file.paths ? file.paths.length : 0) + ' paths';
    return '<div class="file-item">' +
      '<div><div class="file-name">' + escapeHtml(file.name || 'map-file') + '</div><div class="file-meta">' + escapeHtml(meta) + '</div></div>' +
      '<button class="tree-btn" type="button" data-action="open-file" data-index="' + index + '">Open</button>' +
      '<button class="tree-btn" type="button" data-action="download-file" data-index="' + index + '">Save</button>' +
      '<button class="tree-btn danger" type="button" data-action="delete-file" data-index="' + index + '">Del</button>' +
      '</div>';
  }).join('');
}

function handleFileListClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const index = Number(button.dataset.index);
  if (!Number.isInteger(index) || !state.files[index]) return;
  const file = state.files[index];

  if (button.dataset.action === 'open-file') {
    applyMapSnapshot(file);
  } else if (button.dataset.action === 'download-file') {
    const name = cleanFileName(file.name || 'map-file');
    downloadText(name + '.json', JSON.stringify(file, null, 2), 'application/json');
  } else if (button.dataset.action === 'delete-file') {
    state.files.splice(index, 1);
    saveFileLibrary();
    showToast('Deleted saved file.');
  }
}

function openComputerFile() {
  const file = ui.openFileInput.files && ui.openFileInput.files[0];
  ui.openFileInput.value = '';
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || ''));
      if (!isValidSnapshot(parsed)) throw new Error('Not a map file');
      const snapshot = normalizeImportedSnapshot(parsed, file.name.replace(/\.json$/i, ''));
      state.files.unshift(snapshot);
      state.files = state.files.slice(0, 30);
      saveFileLibrary();
      applyMapSnapshot(snapshot);
    } catch (err) {
      showToast(err.message || 'Could not open file.');
    }
  };
  reader.onerror = () => showToast('Could not read file.');
  reader.readAsText(file);
}

function applyMapSnapshot(snapshot) {
  const file = normalizeImportedSnapshot(snapshot, snapshot.name || 'map-file');
  clearAllElements(false, false);

  if (file.basemap && state.baseLayers[file.basemap]) {
    ui.basemapSelect.value = file.basemap;
    changeBasemap();
  }
  if (file.distanceUnits && DISTANCE_UNITS[file.distanceUnits]) {
    ui.distanceUnits.value = file.distanceUnits;
    localStorage.setItem(STORAGE_KEYS.distanceUnits, file.distanceUnits);
  }
  ui.showDistanceLabels.checked = Boolean(file.showDistanceLabels);
  localStorage.setItem(STORAGE_KEYS.showDistanceLabels, String(ui.showDistanceLabels.checked));

  file.points.forEach((point) => addPoint(point));
  file.paths.forEach((path) => {
    const restored = normalizeStoredPath(path);
    if (restored) addFinishedPath(restored.points, restored.style);
  });

  updateStats();
  savePoints();
  savePaths();
  if (isValidView(file.view)) {
    state.map.setView([Number(file.view.lat), Number(file.view.lng)], Number(file.view.zoom));
  } else {
    fitAllFeatures();
  }
  showToast('Opened ' + (file.name || 'map-file') + '.');
}

function isValidSnapshot(file) {
  return file && typeof file === 'object' && Array.isArray(file.points) && Array.isArray(file.paths);
}

function normalizeSnapshotSummary(file) {
  return normalizeImportedSnapshot(file, file.name || 'map-file');
}

function normalizeImportedSnapshot(file, fallbackName) {
  return {
    version: 1,
    id: file.id || ('map-' + Date.now().toString(36)),
    name: cleanFileName(file.name || fallbackName || 'map-file'),
    savedAt: file.savedAt || new Date().toISOString(),
    view: isValidView(file.view) ? file.view : null,
    basemap: state.baseLayers[file.basemap] ? file.basemap : 'satellite',
    distanceUnits: DISTANCE_UNITS[file.distanceUnits] ? file.distanceUnits : 'meters',
    showDistanceLabels: Boolean(file.showDistanceLabels),
    points: file.points.map(normalizeStoredPoint).filter(Boolean),
    paths: file.paths.filter((path) => normalizeStoredPath(path)).map((path) => ({
      points: path.points,
      color: sanitizeColor(path.color, '#1c7ed6'),
      width: clampNumber(Number(path.width), 1, 12, 4),
    })),
  };
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

function cleanFileName(value) {
  const cleaned = String(value || 'map-file')
    .trim()
    .replace(/\.json$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '_')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'map-file';
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
