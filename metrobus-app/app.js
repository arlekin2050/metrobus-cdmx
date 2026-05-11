// Metrobús CDMX — Real-time GTFS Simulation (Canvas renderer)
let data = null;
let map = null;
let shapeLayers = L.layerGroup();
let stopLayers = L.layerGroup();
let activeRoute = null;
let activeTrip = null;
let clockEl = null;

// Simulation
let simRunning = false;
let simTrips = [];
let simCanvas = null;
let simCtx = null;
let animFrame = null;

// Caches
const shapeDistances = {};
const tripStopDists = {};

// ============================================================
// INIT
// ============================================================
async function init() {
    initMap();
    const resp = await fetch('metrobus_data.json');
    data = await resp.json();
    precomputeAll();
    renderRouteList();
    showAllRoutes();
    document.getElementById('loading-overlay').classList.add('hidden');

    document.getElementById('back-btn').addEventListener('click', () => {
        activeRoute = null;
        activeTrip = null;
        document.getElementById('route-list').classList.remove('hidden');
        document.getElementById('route-detail').classList.add('hidden');
        showAllRoutes();
    });
}

function initMap() {
    map = L.map('map', { center: [19.4326, -99.1332], zoom: 12, zoomControl: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CARTO | Datos GTFS Metrobús CDMX', maxZoom: 19
    }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
    shapeLayers.addTo(map);
    stopLayers.addTo(map);

    clockEl = document.createElement('div');
    clockEl.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:999;' +
        'background:#fff;border:2px solid #333;border-radius:4px;padding:6px 16px;' +
        'color:#222;font-size:1rem;font-weight:700;font-family:Helvetica Neue,Helvetica,sans-serif;pointer-events:none;' +
        'box-shadow:2px 2px 0 rgba(0,0,0,0.1);';
    document.getElementById('map-container').appendChild(clockEl);

    const pane = map.createPane('busPane');
    pane.style.zIndex = 650;
    simCanvas = document.createElement('canvas');
    simCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
    pane.appendChild(simCanvas);
    simCtx = simCanvas.getContext('2d');
    map.on('move zoom viewreset resize', resizeCanvas);
    resizeCanvas();
}

function resizeCanvas() {
    const s = map.getSize();
    simCanvas.width = s.x;
    simCanvas.height = s.y;
}

// ============================================================
// GEOMETRY
// ============================================================
function haversine(a, b) {
    const R = 6371000;
    const dLat = (b[0] - a[0]) * Math.PI / 180;
    const dLon = (b[1] - a[1]) * Math.PI / 180;
    const lat1 = a[0] * Math.PI / 180;
    const lat2 = b[0] * Math.PI / 180;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function precomputeAll() {
    for (const sid in data.shapes) {
        const pts = data.shapes[sid];
        const d = [0];
        for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + haversine(pts[i - 1], pts[i]));
        shapeDistances[sid] = d;
    }
    for (const route of data.routes) {
        for (const trip of route.trips) {
            if (!trip.shape_id || !trip.stops.length) continue;
            const pts = data.shapes[trip.shape_id];
            const dists = shapeDistances[trip.shape_id];
            if (!pts) continue;
            tripStopDists[trip.trip_id] = trip.stops.map(s => {
                const stop = data.stops[s.id];
                if (!stop) return { dist: 0, arr: s.arr, dep: s.dep };
                let best = Infinity, bestD = 0;
                for (let i = 0; i < pts.length; i++) {
                    const d = haversine([stop.lat, stop.lon], pts[i]);
                    if (d < best) { best = d; bestD = dists[i]; }
                }
                return { dist: bestD, arr: s.arr, dep: s.dep };
            });
        }
    }
}

function posAtDist(shapeId, meters) {
    const pts = data.shapes[shapeId];
    const d = shapeDistances[shapeId];
    if (!pts || !d) return [19.43, -99.13];
    const total = d[d.length - 1];
    const m = Math.max(0, Math.min(total, meters));
    let lo = 0, hi = d.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; d[mid] <= m ? lo = mid : hi = mid; }
    const seg = d[hi] - d[lo];
    const f = seg > 0 ? (m - d[lo]) / seg : 0;
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f];
}

function tripDistAtTime(tripId, elapsed) {
    const sd = tripStopDists[tripId];
    if (!sd || !sd.length) return 0;
    if (elapsed <= sd[0].arr) return sd[0].dist;
    if (elapsed >= sd[sd.length - 1].arr) return sd[sd.length - 1].dist;
    for (let i = 0; i < sd.length - 1; i++) {
        if (elapsed >= sd[i].arr && elapsed <= sd[i].dep) return sd[i].dist;
        if (elapsed >= sd[i].dep && elapsed <= sd[i + 1].arr) {
            const t = sd[i + 1].arr - sd[i].dep;
            const f = t > 0 ? (elapsed - sd[i].dep) / t : 0;
            return sd[i].dist + (sd[i + 1].dist - sd[i].dist) * f;
        }
    }
    return sd[sd.length - 1].dist;
}

function tripDuration(trip) {
    return trip.stops.length ? trip.stops[trip.stops.length - 1].arr : 0;
}

function nowCDMX() {
    const n = new Date();
    let s = (n.getUTCHours() - 6) * 3600 + n.getUTCMinutes() * 60 + n.getUTCSeconds();
    if (s < 0) s += 86400;
    return s;
}

function fmtTime(s) {
    const h = Math.floor(s / 3600) % 24, m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
}

// ============================================================
// SIMULATION — Canvas only, no DOM for buses
// ============================================================
function getUniqueTrips(route) {
    const byDir = {};
    for (const t of route.trips) {
        if (!t.shape_id || !data.shapes[t.shape_id]) continue;
        if (!data.frequencies[t.trip_id] || !data.frequencies[t.trip_id].length) continue;
        const dir = t.direction || '0';
        if (!byDir[dir] || t.stops.length > byDir[dir].stops.length) byDir[dir] = t;
    }
    return Object.values(byDir);
}

function stopSim() {
    simRunning = false;
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    simTrips = [];
    if (simCtx) simCtx.clearRect(0, 0, simCanvas.width, simCanvas.height);
}

function startSim(routeFilter) {
    stopSim();
    simRunning = true;
    simTrips = [];
    const routes = routeFilter ? [routeFilter] : data.routes;
    routes.forEach(r => {
        const color = '#' + (r.color || 'E94560');
        getUniqueTrips(r).forEach(t => simTrips.push({ trip: t, color, routeId: r.route_id }));
    });
    let last = 0;
    function tick(ts) {
        if (!simRunning) return;
        if (ts - last >= 50) { drawBuses(); last = ts; } // ~20fps is plenty for 1-second resolution
        animFrame = requestAnimationFrame(tick);
    }
    animFrame = requestAnimationFrame(tick);
}

function darkenColor(hex, amt) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    const f = 1 - amt;
    return `rgb(${Math.round(r*f)},${Math.round(g*f)},${Math.round(b*f)})`;
}

function drawBuses() {
    const now = nowCDMX();
    clockEl.textContent = '🕐 ' + fmtTime(now) + ' CDMX';

    const ctx = simCtx;
    const w = simCanvas.width, h = simCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const panePos = map.getPane('busPane')._leaflet_pos || { x: 0, y: 0 };
    const ox = -panePos.x, oy = -panePos.y;

    // Group buses by trip (same shape, same direction)
    const tripGroups = []; // [{color, points}]

    for (let i = 0; i < simTrips.length; i++) {
        const { trip, color } = simTrips[i];
        const dur = tripDuration(trip);
        if (dur === 0) continue;
        const freqs = data.frequencies[trip.trip_id];
        if (!freqs) continue;

        const points = [];
        for (let fi = 0; fi < freqs.length; fi++) {
            const fw = freqs[fi];
            for (let dep = fw.start; dep < fw.end; dep += fw.headway) {
                const elapsed = now - dep;
                if (elapsed < 0 || elapsed > dur) continue;
                const dist = tripDistAtTime(trip.trip_id, elapsed);
                const pos = posAtDist(trip.shape_id, dist);
                const lp = map.latLngToLayerPoint([pos[0], pos[1]]);
                points.push({ x: lp.x + ox, y: lp.y + oy, dist });
            }
        }

        if (points.length > 0) {
            // Sort by distance along THIS trip's shape — consecutive order
            points.sort((a, b) => a.dist - b.dist);
            tripGroups.push({ color, points });
        }
    }

    // Draw connecting lines per trip
    for (let i = 0; i < tripGroups.length; i++) {
        const { color, points } = tripGroups[i];
        if (points.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let j = 1; j < points.length; j++) {
            ctx.lineTo(points[j].x, points[j].y);
        }
        ctx.strokeStyle = darkenColor(color, 0.5);
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // Draw bus diamonds on top
    for (let i = 0; i < tripGroups.length; i++) {
        const { color, points } = tripGroups[i];
        ctx.fillStyle = color;
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1.5;
        for (let j = 0; j < points.length; j++) {
            const p = points[j];
            if (p.x < -10 || p.x > w + 10 || p.y < -10 || p.y > h + 10) continue;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(Math.PI / 4);
            ctx.fillRect(-4, -4, 8, 8);
            ctx.strokeRect(-4, -4, 8, 8);
            ctx.restore();
        }
    }
}

// ============================================================
// UI — Stations + Routes
// ============================================================
function addStationMarker(lat, lon, color, popup, size, labelMarker) {
    const icon = L.divIcon({
        className: 'station-marker',
        html: '', iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        popupAnchor: [0, -size / 2 - 6],
    });
    const m = L.marker([lat, lon], { icon });
    m.bindPopup(popup);
    m.on('add', () => { const el = m.getElement(); if (el) el.style.borderColor = color; });
    if (labelMarker) {
        m.on('mouseover', () => { const el = labelMarker.getElement(); if (el) el.style.opacity = '1'; });
        m.on('mouseout', () => { const el = labelMarker.getElement(); if (el) el.style.opacity = '0'; });
    }
    return m;
}

function addStationLabel(lat, lon, name) {
    return L.marker([lat, lon], {
        icon: L.divIcon({ className: 'station-label', html: name, iconSize: [0,0], iconAnchor: [-12, 5] }),
        interactive: false, zIndexOffset: -100,
    });
}

function countUniqueStops(route) {
    const s = new Set();
    route.trips.forEach(t => t.stops.forEach(st => s.add(st.id)));
    return s.size;
}

function renderRouteList() {
    const el = document.getElementById('route-list');
    const sorted = [...data.routes].sort((a, b) => (parseInt(a.short_name)||999) - (parseInt(b.short_name)||999));
    el.innerHTML = sorted.map(r => {
        const c = '#'+(r.color||'E94560'), tc = '#'+(r.text_color||'FFFFFF');
        return `<div class="route-card" data-route="${r.route_id}">
            <div class="route-badge" style="background:${c};color:${tc}">${r.short_name}</div>
            <div class="route-card-info"><div class="name">${r.long_name}</div>
            <div class="meta">🚏 ${countUniqueStops(r)} estaciones · 🔄 ${r.trips.length} servicios</div></div></div>`;
    }).join('');
    el.querySelectorAll('.route-card').forEach(c => c.addEventListener('click', () => selectRoute(c.dataset.route)));
}

function showAllRoutes() {
    shapeLayers.clearLayers();
    stopLayers.clearLayers();
    const bounds = [];
    const added = new Set();

    data.routes.forEach(r => {
        const c = '#' + (r.color || 'E94560');
        r.shape_ids.forEach(sid => {
            const pts = data.shapes[sid];
            if (!pts || !pts.length) return;
            pts.forEach(p => bounds.push(p));
            // Gray outline + colored line — DC Metro map style
            L.polyline(pts, { color: '#999', weight: 10, opacity: 0.4 }).addTo(shapeLayers);
            L.polyline(pts, { color: c, weight: 7, opacity: 1 }).addTo(shapeLayers);
        });

        // Add stations — only from the longest trip per direction to avoid duplicates
        const mainTrips = getUniqueTrips(r);
        mainTrips.forEach(trip => {
            trip.stops.forEach(s => {
                if (added.has(s.id)) return;
                const stop = data.stops[s.id];
                if (!stop) return;
                added.add(s.id);
                const popup = `<strong>${stop.name}</strong><br>Línea ${r.short_name}`;
                const label = addStationLabel(stop.lat, stop.lon, stop.name);
                stopLayers.addLayer(label);
                stopLayers.addLayer(addStationMarker(stop.lat, stop.lon, c, popup, 11, label));
            });
        });
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
    startSim(null);
}

function selectRoute(routeId) {
    activeRoute = data.routes.find(r => r.route_id === routeId);
    if (!activeRoute) return;
    document.getElementById('route-list').classList.add('hidden');
    document.getElementById('route-detail').classList.remove('hidden');
    const c = '#'+(activeRoute.color||'E94560'), tc = '#'+(activeRoute.text_color||'FFFFFF');
    document.getElementById('route-info').innerHTML = `
        <div class="route-title"><div class="badge" style="background:${c};color:${tc}">${activeRoute.short_name}</div>
        <div class="text">${activeRoute.long_name}</div></div>
        <div class="route-stats"><span>🚏 ${countUniqueStops(activeRoute)} estaciones</span>
        <span>🔄 ${activeRoute.trips.length} servicios</span></div>`;
    renderTripSelector();
    if (activeRoute.trips.length) selectTrip(activeRoute.trips[0]);
}

function renderTripSelector() {
    const el = document.getElementById('trip-selector');
    el.innerHTML = activeRoute.trips.map((t, i) => {
        const dir = t.direction === '1' || t.direction === '1.0' ? '→' : '←';
        const dur = Math.round(tripDuration(t) / 60);
        return `<button class="trip-btn" data-idx="${i}">${dir} ${t.headsign||'Servicio '+(i+1)} (${dur}min)</button>`;
    }).join('');
    el.querySelectorAll('.trip-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            selectTrip(activeRoute.trips[parseInt(btn.dataset.idx)]);
            el.querySelectorAll('.trip-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
    const first = el.querySelector('.trip-btn');
    if (first) first.classList.add('active');
}

function selectTrip(trip) {
    activeTrip = trip;
    const color = '#' + (activeRoute.color || 'E94560');
    shapeLayers.clearLayers();
    stopLayers.clearLayers();
    const bounds = [];

    activeRoute.shape_ids.forEach(sid => {
        const pts = data.shapes[sid];
        if (!pts || !pts.length) return;
        if (sid === trip.shape_id) {
            pts.forEach(p => bounds.push(p));
            L.polyline(pts, { color: '#999', weight: 11, opacity: 0.4 }).addTo(shapeLayers);
            L.polyline(pts, { color, weight: 8, opacity: 1 }).addTo(shapeLayers);
        } else {
            L.polyline(pts, { color, weight: 3, opacity: 0.25, dashArray: '6,8' }).addTo(shapeLayers);
        }
    });

    let html = '';
    trip.stops.forEach((s, i) => {
        const stop = data.stops[s.id];
        if (!stop) return;
        bounds.push([stop.lat, stop.lon]);
        const wc = stop.wheelchair === 1 ? '♿ Accesible' : stop.wheelchair === 2 ? '🚫 No accesible' : '';
        const t = `${Math.floor(s.arr/60)}:${String(s.arr%60).padStart(2,'0')}`;
        const popup = `<strong>${stop.name}</strong><br>Estación ${i+1} de ${trip.stops.length}<br>⏱ ${t} desde inicio${wc?'<br>'+wc:''}`;
        const label = addStationLabel(stop.lat, stop.lon, stop.name);
        stopLayers.addLayer(label);
        stopLayers.addLayer(addStationMarker(stop.lat, stop.lon, color, popup, 13, label));
        const wi = stop.wheelchair === 1 ? ' ♿' : '';
        html += `<div class="stop-item" data-lat="${stop.lat}" data-lon="${stop.lon}">
            <div class="stop-line"><div class="stop-dot" style="border-color:${color}"></div>
            <div class="stop-connector" style="background:${color}"></div></div>
            <div class="stop-info"><div class="stop-name">${stop.name}${wi}</div>
            <div class="stop-meta">Est. ${i+1} · ${t}</div></div></div>`;
    });

    document.getElementById('stop-list').innerHTML = html;
    document.getElementById('stop-list').querySelectorAll('.stop-item').forEach(item => {
        item.addEventListener('click', () => {
            const lat = parseFloat(item.dataset.lat), lon = parseFloat(item.dataset.lon);
            map.setView([lat, lon], 16);
            stopLayers.eachLayer(l => {
                if (l.getLatLng) {
                    const ll = l.getLatLng();
                    if (Math.abs(ll.lat-lat)<0.0001 && Math.abs(ll.lng-lon)<0.0001) l.openPopup();
                }
            });
        });
    });

    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] });
    startSim(activeRoute);
}

init();
