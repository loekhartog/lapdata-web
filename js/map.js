/* Track map: Leaflet + Esri World Imagery (satellite), lap traces, cursor markers, corner labels. */
(function () {
  class TrackMap {
    constructor(el, app) {
      this.app = app; this.el = el;
      this.map = L.map(el, { zoomControl: false, attributionControl: false, zoomSnap: 0.25, zoomDelta: 0.5 });
      this.layers = {
        sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 19 }),
        none: L.tileLayer('', { maxZoom: 19 })
      };
      this.layers.sat.addTo(this.map);
      this.traceGroup = L.layerGroup().addTo(this.map);
      this.cornerGroup = L.layerGroup().addTo(this.map);
      this.markerGroup = L.layerGroup().addTo(this.map);
      this.sfGroup = L.layerGroup().addTo(this.map);
      this.centreOnVehicle = false;
      this.map.on('click', e => this.app.setCursorFromLatLng(e.latlng.lat, e.latlng.lng));
    }
    setProvider(p) { Object.values(this.layers).forEach(l => this.map.removeLayer(l)); (p === 'None' ? this.layers.none : this.layers.sat).addTo(this.map); this.el.style.background = p === 'None' ? getComputedStyle(document.documentElement).getPropertyValue('--app-bg-3') : '#223'; }
    fit() {
      const s = this.app.session; if (!s) return;
      const laps = this.app.selectedLaps().filter(l => l.session === s); const src = laps.length ? laps[0] : (s.laps.find(l => l.kind === 'lap') || s.laps[0]); if (!src) return;
      const pts = src.samples.filter((_, i) => i % 5 === 0).map(x => [x.lat, x.lon]);
      this.bounds = L.latLngBounds(pts); this.map.fitBounds(this.bounds, { padding: [10, 10] });
    }
    drawTraces() {
      const app = this.app; this.traceGroup.clearLayers(); this.sfGroup.clearLayers(); const s = app.session; if (!s) return;
      const outline = getComputedStyle(document.documentElement).getPropertyValue('--track-outline-map').trim();
      if (app.settings.alwaysShowTrackOutline || app.settings.mapProvider === 'None') {
        const col = app.settings.mapProvider === 'None' ? getComputedStyle(document.documentElement).getPropertyValue('--track-outline').trim() : outline;
        let ll;
        if (s.path) { const p = s.path; ll = p.xy.filter((_, i) => i % 4 === 0).map(x => app.xyToLatLon(x)); ll.push(ll[0]); }
        else { const best = s.laps.filter(l => l.kind === 'lap').sort((a, b) => a.time - b.time)[0] || s.laps[0]; ll = best ? best.samples.filter((_, i) => i % 3 === 0).map(x => [x.lat, x.lon]) : []; }
        if (ll.length) L.polyline(ll, { color: col, weight: 9, opacity: .35, lineCap: 'round' }).addTo(this.traceGroup);
      }
      const laps = app.selectedLaps().slice().reverse();
      for (const lap of laps) {
        const pts = lap.samples.map(x => [x.lat, x.lon]);
        if (app.settings.showSectorsOnMap) {
          const sm = app.sectorModel(); const ns = sm.n;
          for (let s = 0; s < ns; s++) {
            const f0 = s ? sm.fr[s - 1] : 0, f1 = s + 1 < ns ? sm.fr[s] : 1;
            const seg = lap.samples.filter(x => x.dist >= lap.lengthM * f0 && x.dist <= lap.lengthM * f1 + 2).map(x => [x.lat, x.lon]);
            L.polyline(seg, { color: lap.colour, weight: 3, opacity: s % 2 ? .55 : 1 }).addTo(this.traceGroup);
          }
        } else L.polyline(pts, { color: lap.colour, weight: 3, opacity: .95 }).addTo(this.traceGroup);
      }
      // start / finish gate
      if (s.gate) {
        const [a, b] = s.gate;
        L.polyline([a, b], { color: '#fff', weight: 4, opacity: .9 }).addTo(this.sfGroup);
        L.polyline([a, b], { color: '#000', weight: 2, dashArray: '4 4' }).addTo(this.sfGroup);
      }
      // user-placed sector splits (saved per track)
      if (app.settings.sectorMode === 'UserDefined') {
        const ref = app.refLap(); const kc = ref ? Math.cos(ref.samples[0].lat * Math.PI / 180) : 1;
        const distOf = p => { if (!ref) return 0; let bd = Infinity, bi = 0; const S = ref.samples; for (let i = 0; i < S.length; i += 2) { const dd = (S[i].lat - p[0]) ** 2 + ((S[i].lon - p[1]) * kc) ** 2; if (dd < bd) { bd = dd; bi = i; } } return S[bi].dist; };
        app.trackSplits(s).map(p => ({ p, d: distOf(p) })).sort((a, b) => a.d - b.d).forEach(({ p }, i) => { // numbered in track order: marker Sn = end of sector n
          L.circleMarker(p, { radius: 6, color: '#fff', weight: 2, fillColor: '#1F4FD8', fillOpacity: 1 }).addTo(this.sfGroup);
          L.marker(p, { icon: L.divIcon({ className: 'split-label', html: 'S' + (i + 1), iconSize: [26, 14], iconAnchor: [13, -7] }), interactive: false }).addTo(this.sfGroup);
        });
      }
      // separate finish line (point-to-point): chequered yellow/black
      if (s.finish) {
        const [a, b] = s.finish;
        L.polyline([a, b], { color: '#FFD400', weight: 4, opacity: .95 }).addTo(this.sfGroup);
        L.polyline([a, b], { color: '#000', weight: 2, dashArray: '4 4' }).addTo(this.sfGroup);
        L.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], { icon: L.divIcon({ className: 'finish-label', html: 'FINISH', iconSize: [44, 14], iconAnchor: [22, -6] }), interactive: false }).addTo(this.sfGroup);
      }
      this.drawCorners();
    }
    drawCorners() {
      const app = this.app; this.cornerGroup.clearLayers();
      const mode = app.settings.cornerLabels; if (mode === 'None' || !app.session) return;
      for (const c of (app.session.corners || [])) {
        const mid = [(c.start[0] + c.end[0]) / 2, (c.start[1] + c.end[1]) / 2];
        if (app.settings.showCorners) L.polyline([c.start, c.end], { color: '#ffd400', weight: 2, opacity: .7 }).addTo(this.cornerGroup);
        L.circleMarker(c.start, { radius: 3, color: '#ffd400', fillColor: '#ffd400', fillOpacity: 1, weight: 1 }).addTo(this.cornerGroup);
        if (mode === 'WithNotes' && !app.cornerNotes[c.name]) continue;
        L.marker(mid, { icon: L.divIcon({ className: 'corner-label', html: c.name.trim(), iconAnchor: [-6, 8] }), interactive: false }).addTo(this.cornerGroup);
      }
    }
    updateCursor() {
      const app = this.app; const laps = app.selectedLaps(); let first = null;
      const t = app.settings.cursorType; this._markers = this._markers || {};
      const live = new Set();
      laps.forEach((lap) => {
        const s = app.sampleAtCursor(lap); if (!s) return; if (!first) first = s; if (t === 'None') return;
        live.add(lap.id); let m = this._markers[lap.id];
        const sig = t + '|' + lap.colour;
        if (m && m._sig !== sig) { this.markerGroup.removeLayer(m); m = null; }
        if (!m) {
          if (t === 'Cross') m = L.marker([s.lat, s.lon], { icon: L.divIcon({ className: '', html: `<div style="width:14px;height:14px;margin:-7px;border:2px solid ${lap.colour};border-radius:50%;box-shadow:0 0 0 1px #000"></div>` }), interactive: false });
          else if (t === 'Rectangle') m = L.marker([s.lat, s.lon], { icon: L.divIcon({ className: '', html: `<div class="car-rect" style="width:10px;height:16px;margin:-8px -5px;background:${lap.colour};border:1px solid #000"></div>` }), interactive: false });
          else m = L.circleMarker([s.lat, s.lon], { radius: 6, color: '#fff', weight: 1.5, fillColor: lap.colour, fillOpacity: 1 });
          m._sig = sig; m.addTo(this.markerGroup); this._markers[lap.id] = m;
        } else m.setLatLng([s.lat, s.lon]);
        if (t === 'Rectangle') { const el = m.getElement && m.getElement(); const r = el && el.firstElementChild; if (r) r.style.transform = `rotate(${90 - s.heading * 180 / Math.PI}deg)`; }
      });
      for (const id in this._markers) if (!live.has(+id)) { this.markerGroup.removeLayer(this._markers[id]); delete this._markers[id]; }
      if (this.centreOnVehicle && first) this.map.panTo([first.lat, first.lon], { animate: false });
    }
    resetZoom() { if (this.bounds) this.map.fitBounds(this.bounds, { padding: [10, 10] }); }
    invalidate() { this.map.invalidateSize(); }
  }
  window.CTMap = { TrackMap };
})();
