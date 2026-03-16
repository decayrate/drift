/* =========================================================
   Car ride — app.js
   Leaflet + OSRM loop route generator
   Map tiles: Carto Dark Matter (no API key needed)
   Routing:   OSRM public demo API (no API key needed)
   Geocoding: Nominatim / OpenStreetMap (no API key needed)
   ========================================================= */

'use strict';

// ---- Constants -------------------------------------------------------

const ROUTE_COLOURS = [
  '#4f8ef7', // blue
  '#3fb950', // green
  '#f78166', // coral
  '#d2a679', // amber
  '#bc8cff', // purple
  '#39c5cf', // teal
];

// Compass bearings for waypoint generation (degrees from North)
const BEARINGS = [0, 60, 120, 180, 240, 300];
const BEARING_NAMES = ['North', 'North-East', 'South-East', 'South', 'South-West', 'North-West'];

// Average speeds (kph) used to estimate waypoint distance
const AVG_SPEED = {
  motorway: 110,
  balanced: 70,
  scenic:   45,
};

const EARTH_RADIUS_KM = 6371;

// OSRM public demo — for production deploy your own instance
const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';

// Nominatim
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const NOMINATIM_HEADERS = { 'Accept-Language': 'en', 'User-Agent': 'CarRideApp/1.0' };

// ---- State -----------------------------------------------------------

let map = null;
let startLatLng = null;        // { lat, lng }
let roadPreference = 'balanced';
let routeLayers = [];          // { polyline: L.Polyline, data, colour }
let startMarker = null;
let selectedIndex = null;
let searchTimeout = null;

// ---- DOM References --------------------------------------------------

const startInput      = document.getElementById('start-input');
const suggestionsEl   = document.getElementById('suggestions');
const locateBtn       = document.getElementById('locate-btn');
const durationSlider  = document.getElementById('duration-slider');
const durationDisplay = document.getElementById('duration-display');
const roadPrefBtns    = document.querySelectorAll('.toggle-btn');
const findRoutesBtn   = document.getElementById('find-routes-btn');
const resultsPanel    = document.getElementById('results');
const resultsCount    = document.getElementById('results-count');
const routeList       = document.getElementById('route-list');
const loadingPanel    = document.getElementById('loading');
const errorMsg        = document.getElementById('error-msg');
const mapPlaceholder  = document.getElementById('map-placeholder');
const routeCardTpl    = document.getElementById('route-card-template');

// ---- Map init --------------------------------------------------------

function initMap() {
  map = L.map('map', { zoomControl: true }).setView([51.505, -0.09], 12);

  // Carto Dark Matter tiles — free, no API key
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(map);
}

// Run immediately — Leaflet doesn't need a callback
initMap();

// ---- Geocoding / Autocomplete ----------------------------------------

startInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  const query = startInput.value.trim();
  if (query.length < 3) { hideSuggestions(); return; }
  searchTimeout = setTimeout(() => fetchSuggestions(query), 400);
});

startInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') hideSuggestions();
  if (e.key === 'Enter') {
    e.preventDefault();
    const highlighted = suggestionsEl.querySelector('.highlighted');
    if (highlighted) highlighted.click();
    else geocodeSearch(startInput.value.trim());
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    navigateSuggestions(e.key === 'ArrowDown' ? 1 : -1);
    e.preventDefault();
  }
});

document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrap')) hideSuggestions();
});

async function fetchSuggestions(query) {
  try {
    const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=0`;
    const res = await fetch(url, { headers: NOMINATIM_HEADERS });
    const data = await res.json();
    showSuggestions(data);
  } catch {
    hideSuggestions();
  }
}

function showSuggestions(results) {
  suggestionsEl.innerHTML = '';
  if (!results.length) { hideSuggestions(); return; }

  results.forEach(r => {
    const li = document.createElement('li');
    li.textContent = r.display_name;
    li.addEventListener('mousedown', e => e.preventDefault()); // keep focus on input
    li.addEventListener('click', () => {
      startInput.value = r.display_name;
      setStart({ lat: parseFloat(r.lat), lng: parseFloat(r.lon) });
      hideSuggestions();
    });
    suggestionsEl.appendChild(li);
  });

  suggestionsEl.classList.remove('hidden');
}

function hideSuggestions() {
  suggestionsEl.classList.add('hidden');
  suggestionsEl.innerHTML = '';
}

function navigateSuggestions(dir) {
  const items = [...suggestionsEl.querySelectorAll('li')];
  if (!items.length) return;
  const cur = suggestionsEl.querySelector('.highlighted');
  const idx = cur ? items.indexOf(cur) : -1;
  const next = Math.max(0, Math.min(items.length - 1, idx + dir));
  items.forEach(li => li.classList.remove('highlighted'));
  items[next].classList.add('highlighted');
}

async function geocodeSearch(query) {
  if (!query) return;
  try {
    const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const res = await fetch(url, { headers: NOMINATIM_HEADERS });
    const [r] = await res.json();
    if (r) {
      startInput.value = r.display_name;
      setStart({ lat: parseFloat(r.lat), lng: parseFloat(r.lon) });
    }
  } catch { /* silent */ }
}

// ---- Locate Me -------------------------------------------------------

locateBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    showError('Geolocation is not supported by your browser.');
    return;
  }
  locateBtn.style.opacity = '0.5';
  navigator.geolocation.getCurrentPosition(
    async pos => {
      locateBtn.style.opacity = '';
      const latlng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      // Reverse geocode via Nominatim
      try {
        const url = `${NOMINATIM_BASE}/reverse?lat=${latlng.lat}&lon=${latlng.lng}&format=json`;
        const res = await fetch(url, { headers: NOMINATIM_HEADERS });
        const data = await res.json();
        startInput.value = data.display_name || `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
      } catch {
        startInput.value = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
      }
      setStart(latlng);
    },
    err => {
      locateBtn.style.opacity = '';
      showError(`Could not get your location: ${err.message}`);
    }
  );
});

// ---- Set start point -------------------------------------------------

function setStart(latlng) {
  startLatLng = latlng;

  if (startMarker) startMarker.remove();
  startMarker = L.circleMarker([latlng.lat, latlng.lng], {
    radius: 8,
    fillColor: '#4f8ef7',
    color: '#fff',
    weight: 2,
    fillOpacity: 1,
  }).addTo(map).bindPopup('Start / Finish');

  map.setView([latlng.lat, latlng.lng], 13);
  hidePlaceholder();
  findRoutesBtn.disabled = false;
}

// ---- UI listeners ----------------------------------------------------

durationSlider.addEventListener('input', () => {
  const mins = parseInt(durationSlider.value, 10);
  durationDisplay.textContent = mins < 60
    ? `${mins} min`
    : mins % 60 === 0
      ? `${mins / 60} hr`
      : `${Math.floor(mins / 60)} hr ${mins % 60} min`;
});

roadPrefBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    roadPrefBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    roadPreference = btn.dataset.value;
  });
});

findRoutesBtn.addEventListener('click', findRoutes);

// ---- Route finding ---------------------------------------------------

async function findRoutes() {
  if (!startLatLng) return;

  clearRoutes();
  showLoading(true);
  hideError();
  hideResults();

  const durationMins  = parseInt(durationSlider.value, 10);
  const speed         = AVG_SPEED[roadPreference];
  const totalDistKm   = speed * (durationMins / 60);
  const waypointDistKm = totalDistKm * 0.40;

  const waypoints = BEARINGS.map(b => offsetLatLng(startLatLng, waypointDistKm, b));

  const promises = waypoints.map((wp, i) =>
    fetchOsrmRoute(startLatLng, wp)
      .then(route => ({ route, name: BEARING_NAMES[i], index: i }))
      .catch(() => null)
  );

  const settled = await Promise.all(promises);
  const valid   = settled.filter(Boolean);

  showLoading(false);

  if (valid.length === 0) {
    showError('No routes could be calculated. The OSRM demo server may be rate-limiting. Try again in a moment.');
    return;
  }

  const unique = deduplicateRoutes(valid);

  unique.sort((a, b) => {
    const aDiff = Math.abs(routeMins(a.route) - durationMins);
    const bDiff = Math.abs(routeMins(b.route) - durationMins);
    return aDiff - bDiff;
  });

  renderRoutes(unique, durationMins);
}

// ---- OSRM API --------------------------------------------------------

async function fetchOsrmRoute(origin, waypoint) {
  // OSRM coords are "lng,lat" (GeoJSON order)
  const pts = [origin, waypoint, origin]
    .map(p => `${p.lng},${p.lat}`)
    .join(';');

  const url = `${OSRM_BASE}/${pts}?overview=full&geometries=geojson&continue_straight=false`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes.length) throw new Error('No route');
  return data.routes[0]; // { distance (m), duration (s), geometry: GeoJSON LineString }
}

// ---- Render ----------------------------------------------------------

function renderRoutes(routes, targetMins) {
  routeList.innerHTML = '';
  resultsCount.textContent = `${routes.length} route${routes.length !== 1 ? 's' : ''}`;

  routes.forEach((data, i) => {
    const colour = ROUTE_COLOURS[i % ROUTE_COLOURS.length];

    // Convert GeoJSON [lng, lat] coords → Leaflet [lat, lng]
    const latlngs = data.route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);

    const polyline = L.polyline(latlngs, {
      color:   colour,
      weight:  i === 0 ? 5 : 3,
      opacity: i === 0 ? 0.9 : 0.45,
    }).addTo(map);

    routeLayers.push({ polyline, data, colour });

    const card = buildRouteCard(data, colour, i, targetMins);
    routeList.appendChild(card);
  });

  selectRoute(0);
  showResults();
}

function buildRouteCard(data, colour, index, targetMins) {
  const tpl  = routeCardTpl.content.cloneNode(true);
  const card = tpl.querySelector('.route-card');

  card.querySelector('.route-color-dot').style.background = colour;
  card.querySelector('.route-name').textContent = `${data.name} Loop`;

  const actualMins = routeMins(data.route);
  const distKm     = data.route.distance / 1000;
  const diff        = actualMins - targetMins;
  const diffStr     = diff === 0 ? 'On target'
    : diff > 0 ? `+${diff} min over target`
    : `${Math.abs(diff)} min under target`;

  card.querySelector('.stat-time').textContent     = formatDuration(actualMins);
  card.querySelector('.stat-distance').textContent = `${distKm.toFixed(1)} km`;
  card.querySelector('.route-summary').textContent = diffStr;

  // External map links
  const midCoord = midpoint(data.route.geometry.coordinates);
  card.querySelector('.google-link').href = googleMapsUrl(startLatLng, midCoord);
  card.querySelector('.apple-link').href  = appleMapsUrl(startLatLng, midCoord);

  card.querySelector('.route-select-btn').addEventListener('click', e => {
    e.stopPropagation();
    selectRoute(index);
  });
  card.addEventListener('click', () => selectRoute(index));

  return card;
}

function selectRoute(index) {
  selectedIndex = index;

  routeLayers.forEach(({ polyline }, i) => {
    const active = i === index;
    polyline.setStyle({
      weight:  active ? 5 : 3,
      opacity: active ? 0.9 : 0.35,
    });
    // Bring active route to front
    if (active) polyline.bringToFront();
  });

  const cards = routeList.querySelectorAll('.route-card');
  cards.forEach((card, i) => {
    const active = i === index;
    card.classList.toggle('selected', active);
    card.querySelector('.route-select-btn').textContent = active ? 'Selected' : 'Select';
    card.querySelector('.route-links').classList.toggle('hidden', !active);
  });

  // Fit map to selected route bounds
  if (routeLayers[index]) {
    map.fitBounds(routeLayers[index].polyline.getBounds(), { padding: [60, 60] });
  }
}

// ---- External map links ----------------------------------------------

/** Returns the midpoint coordinate [lng, lat] of an OSRM geometry coordinates array */
function midpoint(coords) {
  return coords[Math.floor(coords.length / 2)];
}

/**
 * Google Maps directions URL for a loop: start → waypoint → start
 * Uses the route geometry midpoint as the waypoint so the URL reflects
 * the actual path rather than the raw offset point.
 */
function googleMapsUrl(origin, midCoord) {
  const o = `${origin.lat},${origin.lng}`;
  const w = `${midCoord[1]},${midCoord[0]}`; // midCoord is [lng, lat]
  return `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${o}&waypoints=${w}&travelmode=driving`;
}

/**
 * Apple Maps URL. Apple Maps' URL scheme supports saddr + daddr but not
 * full multi-stop loops, so we direct to the midpoint and the user can
 * continue back from there.
 */
function appleMapsUrl(origin, midCoord) {
  const s = `${origin.lat},${origin.lng}`;
  const d = `${midCoord[1]},${midCoord[0]}`;
  return `https://maps.apple.com/?saddr=${s}&daddr=${d}&dirflg=d`;
}

// ---- Helpers ---------------------------------------------------------

function offsetLatLng(origin, distanceKm, bearingDeg) {
  const d   = distanceKm / EARTH_RADIUS_KM;
  const b   = (bearingDeg * Math.PI) / 180;
  const lat1 = (origin.lat * Math.PI) / 180;
  const lng1 = (origin.lng * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) +
    Math.cos(lat1) * Math.sin(d) * Math.cos(b)
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(b) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
  );

  return { lat: (lat2 * 180) / Math.PI, lng: (lng2 * 180) / Math.PI };
}

function routeMins(route) {
  return Math.round(route.duration / 60);
}

function deduplicateRoutes(routes) {
  const seen = [];
  return routes.filter(r => {
    const dist  = r.route.distance;
    const isDup = seen.some(d => Math.abs(d - dist) / d < 0.05);
    if (!isDup) seen.push(dist);
    return !isDup;
  });
}

function formatDuration(mins) {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

function clearRoutes() {
  routeLayers.forEach(({ polyline }) => polyline.remove());
  routeLayers  = [];
  selectedIndex = null;
}

// ---- UI helpers ------------------------------------------------------

function hidePlaceholder() { mapPlaceholder.classList.add('hidden'); }
function showLoading(v)    { loadingPanel.classList.toggle('hidden', !v); }
function hideError()       { errorMsg.classList.add('hidden'); }
function hideResults()     { resultsPanel.classList.add('hidden'); }
function showResults()     { resultsPanel.classList.remove('hidden'); }

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
}
