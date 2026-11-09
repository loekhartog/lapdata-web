/* Circuit Tools 3 web replica — application shell (multi-session, real VBO files) */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const { fmtTime, fmtDelta, sectorTimes, sampleAt } = CTData;

  const LAP_PALETTE = ['#E00000', '#1F4FD8', '#00A000', '#FF8C00', '#8A2BE2', '#00B5B5', '#C71585', '#808000', '#4682B4', '#A0522D'];
  const ICON = (name, size = 'large') => `assets/icons/${size}/${name}.png`;
  const STD_COLS = new Set(['sats', 'time', 'lat', 'long', 'latitude', 'longitude', 'velocity', 'heading', 'height', 'vert-vel', 'tsample', 'solution_type', 'avifileindex', 'avitime', 'avisynctime']);
  const MAP_RULES = {
    throttle: [/^ecu_aps$/, /throttle_?position/i, /^tps$/i, /throttle/i, /^ecu_ath$/, /^ath$/i],
    brake: [/^log_pbrake_f$/, /brake_?pressure/i, /pbrake_f/i, /^brake$/i, /pbrake/i, /brake/i],
    rpm: [/^rpm$/i, /^ecu_nmot$/, /engine_?speed/i, /nmot/i, /rpm/i],
    steer: [/^log_asteer$/, /steering_?angle/i, /asteer/i, /steer/i],
    latacc: [/^sclu_acc_y$/, /lateral_?accel/i, /lat_?acc/i, /acc_?y/i],
    longacc: [/^sclu_acc_x$/, /longitudinal_?accel/i, /long_?acc/i, /acc_?x$/i],
    yaw: [/yaw_?rate/i],
    gear: [/^ecu_gear$/, /^gear$/i, /gear/i],
  };

  const DEFAULTS = {
    theme: 'Light', fontSize: 12, language: 'English', speedUnit: 'kmh', distanceUnit: 'metres', accelUnit: 'g', decimalPlaces: 2,
    sectorTimeFormat: 'SectorToSector', showVmax: true, showShortLaps: false, showUnfinishedLaps: false, sectors: 4, gateWidth: 25,
    sectorPalette: 'AlternatingDark', autoColourLaps: true, autoIdealLap: false, videoRecovery: true,
    graphMode: 'Distance', graphLineStyle: 'Smooth', accelSmoothing: 20, showSectorsOnGraph: false,
    mapProvider: 'Bing', cursorType: 'Dot', showSectorsOnMap: false, alwaysShowTrackOutline: true, cornerLabels: 'All', showCorners: false,
    useGraphSmoothing: true, showCornerMarkers: true, anthropicKey: '', mediaPlayer: 'VLC', sectorMode: 'Equal', speedOverlay: false,
    panes: { sessions: true, graph: true, video: true, map: true }, sessionMode: 'Laps', videoOffset: 0
  };

  const app = {
    settings: (() => { const st = JSON.parse(localStorage.getItem('ct3.settings') || '{}'); if ((st.v || 1) < 2) { delete st.speedUnit; delete st.graphMode; st.v = 2; } return Object.assign({}, DEFAULTS, st); })(),
    sessions: [], session: null, cursorX: 0, playing: false, playbackSpeed: 1, cornerNotes: {}, selectedChannels: ['speed', 'delta', 'throttle'], sortBy: 'time',
    insightsCorner: 0, circuits: [], sfMode: false, lapSeq: 0,
    maths: (() => { try { const m = JSON.parse(localStorage.getItem('ct3.maths') || '{}'); return { params: m.params || {}, mine: m.mine || [] }; } catch (e) { return { params: {}, mine: [] }; } })(), mathsRev: 0,
    // user-placed sector splits, saved per track as [lat, lon] points: { "<track key>": [[lat,lon], ...] }
    customSectors: (() => { try { return JSON.parse(localStorage.getItem('ct3.sectors') || '{}'); } catch (e) { return {}; } })(),
    trackKey(s) { s = s || this.session; if (!s) return ''; return s.circuit ? s.circuit.name : `sf:${s.startFinish.lat.toFixed(4)},${s.startFinish.lon.toFixed(4)}`; },
    trackSplits(s) { return this.customSectors[this.trackKey(s)] || []; },
    saveSplits(pts) { const k = this.trackKey(); if (pts.length) this.customSectors[k] = pts; else delete this.customSectors[k]; localStorage.setItem('ct3.sectors', JSON.stringify(this.customSectors)); this._sm = null; this.allLaps().forEach(l => l._cache = null); this.renderAll(); },
    addSplit(lat, lon) {
      const ref = this.selectedLaps()[0] || this.refLap(); if (!ref) return;
      let best = 0, bd = Infinity; const k = Math.cos(lat * Math.PI / 180);
      ref.samples.forEach((s, i) => { const d = (s.lat - lat) ** 2 + ((s.lon - lon) * k) ** 2; if (d < bd) { bd = d; best = i; } });
      if (Math.sqrt(bd) * 111320 > 60) return this.toast('Custom Sectors', 'Click closer to the driven line.');
      const smp = ref.samples[best]; const f = smp.dist / ref.lengthM; if (f < 0.02 || f > 0.98) return this.toast('Custom Sectors', 'Too close to the start/finish line.');
      const pts = this.trackSplits().slice(); pts.push([+smp.lat.toFixed(6), +smp.lon.toFixed(6)]);
      this.settings.sectorMode = 'UserDefined'; this.save(); this.saveSplits(pts);
      this.toast('Custom Sectors', `Split ${pts.length} placed and saved for ${this.session.trackName}. Click to add another, Esc to finish.`);
    },
    saveMaths() { localStorage.setItem('ct3.maths', JSON.stringify(this.maths)); this.mathsRev++; this._compiled = {}; this.allLaps().forEach(l => l._cache = null); },

    // ---------- lifecycle ----------
    async init() {
      const qs = new URLSearchParams(location.search);
      const q = qs.get('theme'); if (q) { this.settings.theme = q === 'dark' ? 'Dark' : 'Light'; this.save(); }
      this.applyTheme();
      this.circuits = await fetch('data/circuits.json').then(r => r.json()).catch(() => []);
      this.chart = new CTCharts.StackedChart($('#chart'), this);
      this.map = new CTMap.TrackMap($('#map'), this);
      this.bindUI();
      const load = qs.get('load');
      const spath = qs.get('path'); // dev aid / deep link: open a local .vbo through the server (auto-links its videos)
      if (spath) { await this.loadServerFile(spath); if (!this.session) await this.loadDemo(); }
      else if (load) { await this.loadUrl(load); }
      else await this.loadDemo();
      const video = qs.get('video'); // dev aid: ?video=<url>|<name-to-pretend>
      if (video) { const [url, name] = video.split('|'); const blob = await fetch(url).then(r => r.blob()); this.attachVideo(new File([blob], name || url.split('/').pop(), { type: 'video/mp4' })); }
      this.map.setProvider(this.settings.mapProvider);
      new ResizeObserver(() => { this.chart.draw(); this.map.invalidate(); }).observe($('#dock'));
      requestAnimationFrame(t => this.tick(t));
      if (qs.get('sectormode')) { this.settings.sectorMode = qs.get('sectormode'); this.settings.showSectorsOnGraph = this.settings.showSectorsOnMap = qs.get('sectorhl') === '1'; this._sm = null; this.renderAll(); } // dev aid
      if (qs.get('finish') && this.session && !this.session.isDemo && !qs.get('selftest')) { const [la, lo] = qs.get('finish').split(',').map(Number); this.session.customFinish = CTVbo.gateFromPoint(this.session.dec, [la, lo], this.settings.gateWidth, this.session.P); this.resplit(this.session); } // dev aid
      if (qs.get('channels')) { this.selectedChannels = qs.get('channels').split(','); this.renderAll(); } // dev aid
      if (qs.get('splits')) { this.sfMode = 'sector'; qs.get('splits').split(';').forEach(p => { const [la, lo] = p.split(',').map(Number); this.addSplit(la, lo); }); this.sfMode = false; } // dev aid
      if (qs.get('selftest')) setTimeout(() => this.selfTest(qs), 400);
      const open = qs.get('open');
      if (open) setTimeout(() => ({ settings: () => this.winSettings(), insights: () => this.winInsights(), report: () => this.winTrackReport(), maths: () => this.winMaths(), reports: () => this.winReports(), measure: () => this.winMeasure(), about: () => this.winAbout(), open: () => this.winOpen(), file: () => this.menuFile($('#btn-file')), track: () => this.menuTrackOptions($('#btn-trackmenu')), channels: () => this.menuChannels($('#btn-channels')) }[open] || (() => { }))(), 300);
    },
    save() { localStorage.setItem('ct3.settings', JSON.stringify(this.settings)); },
    // dev aid: ?selftest=1[&finish=lat,lon] -> dumps sector models, maths channel ranges and lap splitting into <pre id="selftest">
    selfTest(qs) {
      const out = { errors: [] }; const s = this.session; window.onerror = (m) => out.errors.push(String(m));
      try {
        const fin = qs.get('finish'); if (fin && s && !s.isDemo) { const [la, lo] = fin.split(',').map(Number); const g = CTVbo.gateFromPoint(s.dec, [la, lo], this.settings.gateWidth, s.P); s.customFinish = g; this.resplit(s); out.finishDistToTrace = +g.distToTrace.toFixed(1); }
        out.session = { name: s.name, track: s.trackName, laps: s.laps.map(l => `${l.kind}:${l.number}:${l.time.toFixed(2)}:${l.lengthM.toFixed(0)}m`), finish: !!s.finish, gateSource: s.gateSource };
        out.sectors = {};
        for (const mode of ['Equal', 'MaxSpeed', 'AccelDecel', 'UserDefined']) { this.settings.sectorMode = mode; this._sm = null; const sm = this.sectorModel(); const ref = this.refLap(); out.sectors[mode] = { n: sm.n, fr: sm.fr.map(f => +f.toFixed(3)), times: CTData.sectorTimes(ref, sm.fr).map(t => +t.toFixed(2)), sum: +CTData.sectorTimes(ref, sm.fr).reduce((a, b) => a + b, 0).toFixed(2), lapTime: +ref.time.toFixed(2) }; }
        this.settings.sectorMode = 'Equal'; this._sm = null;
        out.maths = {}; const defs = this.channelDefs(); const ref = this.refLap();
        for (const k of Object.keys(defs)) { if (!defs[k].expr) continue; const vals = this.evalMaths(ref, Object.assign({ key: k }, defs[k])); let lo = Infinity, hi = -Infinity, nan = 0; for (const v of vals) { if (isNaN(v)) { nan++; continue; } lo = Math.min(lo, v); hi = Math.max(hi, v); } out.maths[k] = { min: +lo.toFixed(3), max: +hi.toFixed(3), nan, n: vals.length, cursor: +(this.channelValueAtCursor(ref, Object.assign({ key: k }, defs[k])) || 0).toFixed(3) }; }
        const chk = ['speed * 2', 'if(brake > 5 and throttle > 10, 1, 0)', '[Brake Velocity] * 2', 'ddt(speed) / 3.6 / 9.81', 'nosuch + 1', 'speed +'].map(e => [e, this.checkMaths(e)]).map(([e, r]) => `${e} => ${r.ok ? 'ok' : r.error}`); out.check = chk;
        this.renderAll();
      } catch (e) { out.errors.push(e.stack || String(e)); }
      const pre = document.createElement('pre'); pre.id = 'selftest'; pre.textContent = JSON.stringify(out, null, 1); pre.style.display = 'none'; document.body.appendChild(pre);
    },
    applyTheme() {
      document.documentElement.dataset.theme = this.settings.theme.toLowerCase();
      document.documentElement.style.setProperty('--font-size', this.settings.fontSize + 'px');
      $$('img[data-icon]').forEach(img => { const n = img.dataset.icon; const sz = img.dataset.size || 'large'; img.src = ICON(this.settings.theme === 'Dark' && img.dataset.dark !== '0' ? n + '-light' : n, sz); img.onerror = () => { img.onerror = null; img.src = ICON(n, sz); }; });
    },

    // ---------- sessions: demo ----------
    async loadDemo() {
      const track = await fetch('data/brands_hatch_indy.json').then(r => r.json());
      const s = CTData.makeSession(track, { seed: 13, laps: 18 });
      s.name = 'VBOX0013'; s.fileName = 'VBOX0013.vbo (demo)'; s.isDemo = true; s.created = '14/03/2025 @ 10:21:00'; s.rateHz = 10;
      s.corners = track.corners.map(c => ({ name: c.name, start: c.start, end: c.end }));
      const h = s.path.heading[0], gw = 12.5; s.gate = [this.pathLL(s, [-Math.sin(h) * gw, Math.cos(h) * gw]), this.pathLL(s, [Math.sin(h) * gw, -Math.cos(h) * gw])];
      s.laps.forEach(l => { l.session = s; l.kind = 'lap'; l.id = ++this.lapSeq; l.selected = false; l.isRef = false; });
      s.channelMap = { throttle: 'obd.ThrottlePosition', brake: 'obd.BrakePressure', rpm: 'obd.EngineRPM', steer: 'obd.SteeringAngle' };
      s.fileCols = [];
      this.settings.speedUnit = this.settings.speedUnit || 'mph';
      this.addSession(s, true);
      this.toast('Demo session', `${s.name} — Brands Hatch Indy, simulated laps on the real Racelogic centreline. Drop your own .vbo files anywhere to replace it.`);
    },
    pathLL(s, xy) { const p = s.path; return [p.lat0 + xy[1] / 6371000 * 180 / Math.PI, p.lon0 + xy[0] / (6371000 * Math.cos(p.lat0 * Math.PI / 180)) * 180 / Math.PI]; },

    // ---------- sessions: real files ----------
    async loadFiles(files) {
      const list = Array.from(files); if (!list.length) return;
      const vbos = list.filter(f => /\.vbo$/i.test(f.name)), vids = list.filter(f => /\.(mp4|mov|m4v|webm)$/i.test(f.name));
      for (const f of vbos) {
        this.progress(`Loading VBO … ${f.name}`);
        try { const text = await f.text(); await this.loadVboText(text, f.name); }
        catch (e) { console.error(e); this.alert('Cannot Process File', `Unable to analyse file "${f.name}": ${e.message}`); }
      }
      let linked = 0; for (const f of vids) if (this.attachVideo(f, { quiet: true })) linked++;
      this.progress('');
      if (vids.length) { const kept = vids.length - linked; this.toast('Video', `${linked} video file(s) linked${kept ? `, ${kept} kept aside until a matching .vbo is loaded` : ''}.`); this.renderVideo(); }
      if (!vbos.length && !vids.length) this.alert('Open VBOX file', 'Drop .vbo files (and optionally their .mp4 videos), or a whole session folder.');
    },
    async loadUrl(url) { this.progress('Loading VBO …'); const r = await fetch(url); if (!r.ok) { this.progress(''); return this.alert('File not found', `Could not find "${url}".`); } const text = await r.text(); await this.loadVboText(text, decodeURIComponent(url.split('/').pop())); this.progress(''); },
    progress(msg) { const el = $('#progress'); el.textContent = msg; el.classList.toggle('hidden', !msg); },
    async loadVboText(text, fileName) {
      await new Promise(r => setTimeout(r, 20)); // let the progress label paint
      const vbo = CTVbo.parseVbo(text, fileName);
      if (!vbo.rows || !(vbo.data.lat || vbo.data.latitude)) throw new Error('No Valid GPS Data: the file does not contain valid GPS data.');
      const s = { name: fileName.replace(/\.vbo$/i, ''), fileName, vbo, isDemo: false, created: vbo.created, lonSign: -1, videos: {}, laps: [], corners: [], fileCols: vbo.cols.filter(c => !STD_COLS.has(c.toLowerCase())) };
      s.units = {}; vbo.cols.forEach((c, i) => s.units[c] = vbo.unitMap[vbo.header[i]] || '');
      s.channelMap = this.autoMap(vbo.cols);
      s.rateHz = vbo.data.Tsample ? Math.round(1 / vbo.data.Tsample[0]) : (vbo.data.time ? Math.round(1 / ((vbo.data.time[10] - vbo.data.time[0]) / 10)) : 10);
      this.rebuildSession(s);
      // circuit match check against loaded sessions
      const other = this.sessions.find(x => x !== s && !x.isDemo);
      if (other && this.distKm(other.centre, s.centre) > 5) {
        this.toast('VBO Does Not Match Current Sessions', `The data in VBO file "${fileName}" is for circuit "${s.trackName}", but currently loaded sessions are for circuit "${other.trackName}". Circuit Tools does not support comparing circuits at different locations. Previous sessions were closed.`);
        this.sessions = [];
      }
      if (this.sessions.some(x => x.isDemo)) this.sessions = this.sessions.filter(x => !x.isDemo);
      s.sourceDir = this._pendingSourceDir || null;
      this.addSession(s, true);
      this.linkPendingVideos();
      this.autoLinkVideos(s);
      if (!s.laps.some(l => l.kind === 'lap')) this.alert('No laps were detected', `The location of "${fileName}" ${s.circuit ? 'was recognised as ' + s.trackName : 'is not recognised'}, but no complete laps crossed the start/finish line. Use Track menu (…) → Set Start/Finish line and click on the map.`);
      else this.toast('Session loaded', `${fileName}: ${s.trackName} (${s.country || 'start/finish from file'}), ${s.laps.filter(l => l.kind === 'lap').length} laps, ${s.rateHz} Hz, ${s.fileCols.length} CAN channels. Throttle = ${s.channelMap.throttle || 'none'}, brake = ${s.channelMap.brake || 'none'}.`);
    },
    autoMap(cols) {
      const m = {}; const used = new Set();
      for (const key in MAP_RULES) { for (const re of MAP_RULES[key]) { const c = cols.find(c => re.test(c) && !used.has(c)); if (c) { m[key] = c; used.add(c); break; } } }
      return m;
    },
    distKm(a, b) { if (!a || !b) return 0; const k = Math.cos(a[0] * Math.PI / 180); return Math.hypot((a[1] - b[1]) * k, a[0] - b[0]) * 111.32; },

    // (re)build decoded data, circuit match, gate and laps for a session
    rebuildSession(s, opts = {}) {
      const vbo = s.vbo; const dec = CTVbo.decode(vbo, { lonSign: s.lonSign }); s.dec = dec;
      const P = CTVbo.proj(dec.lat[0], dec.lon[0]); s.P = P;
      // centre of trace
      let sl = 0, so = 0, c = 0; for (let i = 0; i < dec.lat.length; i += 25) { sl += dec.lat[i]; so += dec.lon[i]; c++; } s.centre = [sl / c, so / c];
      // candidate circuits near the trace (by distance from S/F point to trace)
      s.candidates = this.circuits.map(ci => { const d = this.distKm(ci.sf, s.centre); return d < 8 ? { ci, d } : null; }).filter(Boolean)
        .map(x => { const g = CTVbo.gateFromPoint(dec, x.ci.sf, x.ci.gate || this.settings.gateWidth, P); return { ci: x.ci, dTrace: g.distToTrace, g }; })
        .sort((a, b) => a.dTrace - b.dTrace);
      // choose gate: custom > selected layout > file gate > best DB candidate
      let gate = null, source = '';
      if (s.customGate) { gate = s.customGate; source = 'custom'; }
      else if (opts.layout) { const cand = s.candidates.find(x => x.ci.name === opts.layout); if (cand) { gate = cand.g; s.circuit = cand.ci; source = 'layout'; } }
      if (!gate && vbo.gates.length) { const fg = vbo.gates.find(g => g.kind === 'start'); if (fg) { const g = CTVbo.gateFromPoint(dec, fg.a, this.settings.gateWidth, P); if (g.distToTrace < 60) { gate = g; source = 'file'; } } }
      if (!gate || !CTVbo.crossings(dec, gate, P).length) {
        // try DB candidates near the trace, pick the one producing most laps
        let best = null;
        for (const cand of s.candidates.slice(0, 6)) { if (cand.dTrace > 80) continue; const n = CTVbo.crossings(dec, cand.g, P).length; if (!best || n > best.n) best = { cand, n }; }
        if (best && best.n) { if (gate && source === 'file') this.toast('File Start/Finish Ignored', `The start/finish line embedded in "${s.fileName}" did not produce any laps. The start/finish from circuit layout "${best.cand.ci.name}" has been used instead.`); gate = best.cand.g; s.circuit = best.cand.ci; source = 'database'; }
      }
      if (!s.circuit) { const near = s.candidates.filter(x => x.dTrace < 80)[0] || s.candidates[0]; if (near) s.circuit = near.ci; }
      s.gateSource = source; s.gateObj = gate;
      s.trackName = s.circuit ? s.circuit.name : (source === 'file' ? 'Start / Finish from file' : 'Unrecognised Location');
      s.country = s.circuit ? s.circuit.country : '';
      s.corners = s.circuit && s.circuit.corners ? s.circuit.corners.map(k => ({ name: k.n, start: k.s, end: k.e })) : [];
      s.gate = gate ? [gate.a, gate.b] : null;
      s.startFinish = gate ? { lat: (gate.a[0] + gate.b[0]) / 2, lon: (gate.a[1] + gate.b[1]) / 2 } : { lat: dec.lat[0], lon: dec.lon[0] };
      // separate finish line (point-to-point): custom > [laptiming] Finish entry
      let fin = null;
      if (s.customFinish) fin = s.customFinish;
      else if (!s.ignoreFileFinish) { const ff = vbo.gates.find(g => g.kind === 'finish'); if (ff) { const g = CTVbo.gateFromPoint(dec, ff.a, this.settings.gateWidth, P); if (g.distToTrace < 60 && CTVbo.crossings(dec, g, P).length) fin = g; } }
      if (fin && gate && this.distKm(fin.a, gate.a) < 0.03) fin = null; // same place as the start: not point-to-point
      s.finishObj = fin; s.finish = fin ? [fin.a, fin.b] : null;
      this.buildLaps(s, gate ? CTVbo.crossings(dec, gate, P) : [], fin ? CTVbo.crossings(dec, fin, P) : null);
    },
    buildLaps(s, cr, cf) {
      const dec = s.dec, d = s.vbo.data, n = dec.lat.length, m = s.channelMap;
      const col = k => m[k] ? d[m[k]] : null;
      const thr = col('throttle'), brk = col('brake'), rpm = col('rpm'), str = col('steer'), lat = col('latacc'), lon = col('longacc'), yaw = col('yaw'), gear = col('gear');
      const hdg = d.heading, avit = d.avitime, avif = d.avifileindex;
      // longG from channel if it correlates positively with dv/dt, else derivative
      let lonSign = 1; if (lon) { let sp = 0; for (let i = 5; i < n - 5; i += 7) { const dv = (dec.v[i + 5] - dec.v[i - 5]) / Math.max(0.01, dec.t[i + 5] - dec.t[i - 5]); sp += dv * lon[i]; } lonSign = sp < 0 ? -1 : 1; }
      let latSign = 1; if (lat && yaw) { let sp = 0; for (let i = 0; i < n; i += 7) sp += lat[i] * yaw[i]; latSign = sp < 0 ? -1 : 1; }
      const mk = (i, t0, dist) => {
        let longG = lon ? lonSign * lon[i] : ((dec.v[Math.min(n - 1, i + 3)] - dec.v[Math.max(0, i - 3)]) / Math.max(0.01, dec.t[Math.min(n - 1, i + 3)] - dec.t[Math.max(0, i - 3)])) / 9.81;
        let latG;
        if (lat) latG = latSign * lat[i];
        else if (yaw) latG = dec.v[i] * yaw[i] * Math.PI / 180 / 9.81;
        else { const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3); let dh = (hdg ? hdg[b] - hdg[a] : 0); if (dh > 180) dh -= 360; if (dh < -180) dh += 360; latG = dec.v[i] * (dh * Math.PI / 180) / Math.max(0.01, dec.t[b] - dec.t[a]) / 9.81; }
        return { i, session: s, t: dec.t[i] - t0, dist, speed: dec.v[i], throttle: thr ? thr[i] : 0, brake: brk ? Math.max(0, brk[i]) : 0, rpm: rpm ? rpm[i] : 0, steer: str ? str[i] : 0, gear: gear ? gear[i] : 0, latG, longG, lat: dec.lat[i], lon: dec.lon[i], heading: hdg ? (90 - hdg[i]) * Math.PI / 180 : 0, avitime: avit ? avit[i] : NaN, avifile: avif ? avif[i] : 1 };
      };
      const laps = [];
      const bounds = []; // [startIdx, startTime, endIdx, endTime, kind]
      if (!cr.length) bounds.push([0, dec.t[0], n - 1, dec.t[n - 1], 'out']);
      else if (cf) {
        // point-to-point: a lap runs from a start crossing to the next finish crossing (before the next start crossing)
        if (cr[0].idx > 10) bounds.push([0, dec.t[0], cr[0].idx, cr[0].time, 'out']);
        for (let k = 0; k < cr.length; k++) {
          const nextStart = cr[k + 1]; const f = cf.find(x => x.time > cr[k].time + 1 && (!nextStart || x.time < nextStart.time));
          if (f) bounds.push([cr[k].idx, cr[k].time, f.idx, f.time, 'lap']);
          else if (!nextStart && n - 1 - cr[k].idx > 10) bounds.push([cr[k].idx, cr[k].time, n - 1, dec.t[n - 1], 'in']);
        }
      }
      else {
        if (cr[0].idx > 10) bounds.push([0, dec.t[0], cr[0].idx, cr[0].time, 'out']);
        for (let k = 0; k < cr.length - 1; k++) bounds.push([cr[k].idx, cr[k].time, cr[k + 1].idx, cr[k + 1].time, 'lap']);
        if (n - 1 - cr[cr.length - 1].idx > 10) bounds.push([cr[cr.length - 1].idx, cr[cr.length - 1].time, n - 1, dec.t[n - 1], 'in']);
      }
      let num = 0;
      for (const [i0, t0, i1, t1, kind] of bounds) {
        const samples = []; let dist = 0; let prevT = t0, prevV = dec.v[i0];
        for (let i = i0 + 1; i <= i1; i++) { const dt = Math.min(1, Math.max(0, dec.t[i] - prevT)); dist += (dec.v[i] + prevV) / 2 * dt; prevT = dec.t[i]; prevV = dec.v[i]; const sm = mk(i, t0, dist); samples.push(sm); }
        if (samples.length < 20) continue;
        const time = kind === 'lap' ? t1 - t0 : samples[samples.length - 1].t;
        const lengthM = kind === 'lap' ? dist + (t1 - dec.t[i1]) * dec.v[i1] : dist;
        laps.push({ number: kind === 'lap' ? ++num : (kind === 'out' ? 0 : num + 1), label: kind === 'out' ? 'Out Lap' : kind === 'in' ? 'In Lap' : null, kind, samples, time, vmax: Math.max(...samples.map(x => x.speed)), lengthM, session: s, selected: false, isRef: false, id: ++this.lapSeq });
      }
      const complete = laps.filter(l => l.kind === 'lap'); if (complete.length > 2) { const med = complete.map(l => l.time).sort((a, b) => a - b)[Math.floor(complete.length / 2)]; complete.forEach(l => { if (l.time < med * 0.6) l.kind = 'short'; }); }
      s.laps = laps;
    },
    addSession(s, activate) {
      this.sessions.push(s); if (activate || !this.session) this.session = s;
      // selection: fastest lap (ref) + second fastest of this session if nothing else is selected
      const complete = s.laps.filter(l => l.kind === 'lap').sort((a, b) => a.time - b.time);
      if (!this.allLaps().some(l => l.isRef)) { if (complete[0]) { complete[0].selected = true; complete[0].isRef = true; } if (complete[1]) complete[1].selected = true; }
      else if (complete[0]) complete[0].selected = true;
      if (!s.isDemo && s.channelMap.throttle) this.selectedChannels = ['speed', 'delta', 'f:' + s.channelMap.throttle];
      else if (s.isDemo) this.selectedChannels = ['speed', 'delta', 'throttle'];
      this.assignColours(); this.allLaps().forEach(l => l._cache = null);
      this.cursorX = 0; this.insightsCorner = 0;
      this.renderAll(); this.map.fit();
    },
    closeSession(s) {
      this.sessions = this.sessions.filter(x => x !== s);
      if (this.session === s) this.session = this.sessions[0] || null;
      if (!this.sessions.length) { this.loadDemo(); return; }
      if (!this.allLaps().some(l => l.isRef && l.selected)) { const l = this.allLaps().find(l => l.selected) || this.allLaps()[0]; if (l) { l.isRef = true; l.selected = true; } }
      this.assignColours(); this.allLaps().forEach(l => l._cache = null); this.renderAll(); this.map.fit();
    },
    // Video linking, Circuit Tools style: the .vbo [AVI] section gives the prefix, the camera writes <prefix>0001.mp4, 0002.mp4 …
    // and every sample carries avifileindex + avitime (ms into that file).
    pendingVideos: [], audioLapId: null,
    videoKey(name) { const base = name.replace(/\.[^.]+$/, ''); const m = base.match(/^(.*?)(\d{4})$/); return m ? { prefix: m[1], idx: +m[2], base } : { prefix: base, idx: 1, base }; },
    sessionForVideo(name) {
      const k = this.videoKey(name); const norm = s => s.toLowerCase().replace(/[\s_\-#]+/g, '');
      // 1) exact Racelogic rule: <avi prefix><index>.mp4
      let t = this.sessions.find(s => s.vbo && s.vbo.avi[0] && k.base.toLowerCase().startsWith(s.vbo.avi[0].toLowerCase()));
      // 2) same base name as the .vbo (VBOX0004.vbo + VBOX0004_0001.mp4 or VBOX0004.mp4)
      if (!t) t = this.sessions.find(s => !s.isDemo && norm(k.base).startsWith(norm(s.name)));
      // 3) the .vbo name starts with the video's prefix (camera prefix shorter than the file name)
      if (!t) t = this.sessions.find(s => !s.isDemo && k.prefix.length > 6 && norm(s.name).startsWith(norm(k.prefix)));
      return { target: t, idx: k.idx };
    },
    attachVideo(file, { quiet } = {}) {
      const { target, idx } = this.sessionForVideo(file.name);
      if (!target) { if (!this.pendingVideos.some(p => p.name === file.name)) this.pendingVideos.push(file); if (!quiet) this.toast('Video', `${file.name} kept aside — load its .vbo and it will be linked automatically.`); return false; }
      if (target.videos && target.videos[idx] && target.videos[idx].name === file.name) return true;
      const url = URL.createObjectURL(file);
      target.videos = target.videos || {}; target.videos[idx] = { url, name: file.name, size: file.size };
      this.pendingVideos = this.pendingVideos.filter(p => p !== file);
      this.renderVideo();
      if (!quiet) this.toast('Video linked', `${file.name} → ${target.name} (file ${idx}). ${Object.keys(target.videos).length} of ${this.videoFilesNeeded(target).length} video file(s) present.`);
      return true;
    },
    videoFilesNeeded(s) { if (!s.vbo || !s.vbo.data.avifileindex) return []; const idx = new Set(); const a = s.vbo.data.avifileindex; for (let i = 0; i < a.length; i += 25) if (!isNaN(a[i])) idx.add(Math.round(a[i])); return [...idx].sort((x, y) => x - y); },
    expectedVideoName(s, idx) { const p = s.vbo && s.vbo.avi[0] ? s.vbo.avi[0] : s.name + '_'; const ext = (s.vbo && s.vbo.avi[1]) || 'mp4'; return `${p}${String(idx).padStart(4, '0')}.${ext}`; },
    serverOk: null,
    async api(path) { try { const r = await fetch(path); if (!r.ok) throw 0; this.serverOk = true; return await r.json(); } catch (e) { if (this.serverOk === null) this.serverOk = false; return null; } },
    attachRemoteVideo(s, idx, filePath, name) {
      s.videos = s.videos || {}; if (s.videos[idx] && s.videos[idx].name === name) return false;
      s.videos[idx] = { url: '/api/file?path=' + encodeURIComponent(filePath), name, path: filePath, remote: true }; return true;
    },
    // Find <prefix>0001.mp4 … next to the .vbo (same folder) or anywhere on the Mac (Spotlight), via the local server
    async autoLinkVideos(s) {
      if (s.isDemo || !s.vbo) return; const need = this.videoFilesNeeded(s); if (!need.length) return;
      const names = need.map(i => this.expectedVideoName(s, i)); let linked = 0, where = '';
      if (s.sourceDir) { const ls = await this.api('/api/ls?path=' + encodeURIComponent(s.sourceDir)); if (ls && ls.files) for (const f of ls.files) { const k = names.indexOf(f.name); if (k >= 0 && this.attachRemoteVideo(s, need[k], f.path, f.name)) { linked++; where = 'next to the .vbo'; } } }
      const missing = need.filter(i => !(s.videos && s.videos[i]));
      if (missing.length) { const found = await this.api('/api/find?name=' + encodeURIComponent(missing.map(i => this.expectedVideoName(s, i)).join(','))); if (found) for (const i of missing) { const hits = found[this.expectedVideoName(s, i)] || []; if (hits.length && this.attachRemoteVideo(s, i, hits[0], hits[0].split('/').pop())) { linked++; where = where || 'found on this Mac'; } } }
      if (linked) { this.renderVideo(); this.toast('Video linked automatically', `${linked} of ${need.length} camera file(s) ${where}: ${names.slice(0, 2).join(', ')}${names.length > 2 ? ' …' : ''}`); }
      else if (this.serverOk === false) this.toast('Video', 'Automatic video lookup needs the app served by serve.py (it searches your Mac for the camera files).');
      else this.toast('Video not found', `Looking for ${names[0]}${names.length > 1 ? ' …' : ''}. Drop the file(s) or the session folder here, or open the .vbo through File → Open so its folder is known.`);
    },
    async loadServerFile(filePath) {
      const name = filePath.split('/').pop(); const dir = filePath.slice(0, filePath.lastIndexOf('/'));
      this.progress(`Loading VBO … ${name}`); const r = await fetch('/api/file?path=' + encodeURIComponent(filePath)); if (!r.ok) { this.progress(''); return this.alert('File not found', `Could not read "${filePath}".`); }
      const text = await r.text(); this._pendingSourceDir = dir; try { await this.loadVboText(text, name); } finally { this._pendingSourceDir = null; this.progress(''); }
      localStorage.setItem('ct3.lastDir', dir);
    },
    linkPendingVideos() { const pend = this.pendingVideos.slice(); let n = 0; for (const f of pend) if (this.attachVideo(f, { quiet: true })) n++; if (n) this.toast('Video linked', `${n} video file(s) linked to ${this.session.name}.`); },
    async openFolder() {
      if (window.showDirectoryPicker) {
        try {
          const dir = await window.showDirectoryPicker({ mode: 'read' }); const files = [];
          const walk = async (d, depth) => { for await (const [name, h] of d.entries()) { if (h.kind === 'file' && /\.(vbo|mp4|mov|m4v|webm)$/i.test(name)) files.push(await h.getFile()); else if (h.kind === 'directory' && depth < 2) await walk(h, depth + 1); } };
          await walk(dir, 0); if (!files.length) return this.alert('Open folder', 'No .vbo or video files found in that folder.');
          return this.loadFiles(files);
        } catch (e) { if (e.name === 'AbortError') return; console.warn(e); }
      }
      const inp = $('#folder-input'); inp.value = ''; inp.click();
    },
    async filesFromDrop(dt) {
      const items = dt.items ? Array.from(dt.items) : []; const entries = items.map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
      if (!entries.some(e => e.isDirectory)) return Array.from(dt.files);
      const out = []; const readDir = (dirEntry) => new Promise(res => { const r = dirEntry.createReader(); const all = []; const next = () => r.readEntries(es => { if (!es.length) return res(all); all.push(...es); next(); }); next(); });
      const walk = async (e, depth) => { if (e.isFile) { await new Promise(res => e.file(f => { if (/\.(vbo|mp4|mov|m4v|webm)$/i.test(f.name)) out.push(f); res(); })); } else if (e.isDirectory && depth < 3) { for (const c of await readDir(e)) await walk(c, depth + 1); } };
      for (const e of entries) await walk(e, 0);
      return out;
    },

    // ---------- selection helpers ----------
    allLaps() { return this.sessions.flatMap(s => s.laps); },
    assignColours() {
      let i = 0; const ref = this.allLaps().find(l => l.isRef);
      if (ref && ref.selected) { ref.colour = LAP_PALETTE[0]; i = 1; }
      for (const l of this.allLaps()) { if (l.selected && l !== ref) l.colour = LAP_PALETTE[i++ % LAP_PALETTE.length]; if (!l.selected) l.colour = null; }
    },
    selectedLaps() {
      const ref = this.allLaps().find(l => l.isRef && l.selected);
      const rest = this.allLaps().filter(l => l.selected && !l.isRef);
      return (ref ? [ref] : []).concat(rest);
    },
    refLap() { return this.allLaps().find(l => l.isRef) || this.selectedLaps()[0] || this.session.laps[0]; },
    visibleLaps(s) { return s.laps.filter(l => l.kind === 'lap' || (l.kind === 'short' && this.settings.showShortLaps) || ((l.kind === 'out' || l.kind === 'in') && this.settings.showUnfinishedLaps)); },
    lapName(l) { return l.label || (l.kind === 'short' ? `${l.number} (short)` : String(l.number)); },
    unitSpeed(ms) { return this.settings.speedUnit === 'mph' ? ms * 2.23694 : ms * 3.6; },
    speedLabel() { return this.settings.speedUnit === 'mph' ? 'mph' : 'km/h'; },
    xyToLatLon(xy) { return this.pathLL(this.session, xy); },

    // ---------- cursor ----------
    cursorDist() {
      const ref = this.selectedLaps()[0] || this.refLap(); if (!ref) return 0; const m = this.settings.graphMode;
      if (m === 'Distance') return this.cursorX;
      if (m === 'Time') return (ref.samples.find(s => s.t >= this.cursorX) || ref.samples[ref.samples.length - 1]).dist;
      const i = Math.min(ref.samples.length - 1, Math.max(0, Math.round(this.cursorX))); return ref.samples[i].dist;
    },
    sampleAtCursor(lap) { return sampleAt(lap, this.cursorDist()); },
    setCursorX(x) { const [a, b] = this.chart.xRange(); this.cursorX = Math.min(b, Math.max(a, x)); this.renderCursor(); },
    setCursorFromLatLng(lat, lon) {
      if (this.sfMode === 'sector') return this.addSplit(lat, lon);
      if (this.sfMode) return this.placeStartFinish(lat, lon);
      const ref = this.selectedLaps()[0] || this.refLap(); if (!ref) return; let best = 0, bd = Infinity; const k = Math.cos(lat * Math.PI / 180);
      ref.samples.forEach((s, i) => { const d = (s.lat - lat) ** 2 + ((s.lon - lon) * k) ** 2; if (d < bd) { bd = d; best = i; } });
      const s = ref.samples[best]; const m = this.settings.graphMode; this.setCursorX(m === 'Time' ? s.t : m === 'Distance' ? s.dist : best);
    },
    currentSector() { const ref = this.refLap(); if (!ref) return 1; const f = this.cursorDist() / ref.lengthM; const sm = this.sectorModel(); let k = 0; while (k < sm.fr.length && f >= sm.fr[k]) k++; return k + 1; },
    // Sector layout for the current reference lap: { n, fr: [n-1 boundary fractions of lap distance] }
    sectorModel() {
      const ref = this.refLap(); const st = this.settings; const n0 = Math.max(1, st.sectors | 0);
      if (!ref) return { n: n0, fr: Array.from({ length: n0 - 1 }, (_, i) => (i + 1) / n0) };
      const splits = st.sectorMode === 'UserDefined' ? this.trackSplits(ref.session) : [];
      const key = `${st.sectorMode}|${n0}|${ref.id}|${ref.lengthM.toFixed(1)}|${(ref.session.corners || []).length}|${JSON.stringify(splits)}`;
      if (this._sm && this._sm.key === key) return this._sm;
      let fr = null; const L = ref.lengthM; const S = ref.samples;
      if (st.sectorMode === 'UserDefined' && splits.length) {
        // user-placed splits (saved per track): boundary at the nearest point of the reference lap to each saved coordinate
        const k = Math.cos(S[0].lat * Math.PI / 180); const distOf = (p) => { let bi = 0, bd = Infinity; for (let i = 0; i < S.length; i++) { const dd = (S[i].lat - p[0]) ** 2 + ((S[i].lon - p[1]) * k) ** 2; if (dd < bd) { bd = dd; bi = i; } } return S[bi].dist / L; };
        fr = splits.map(distOf).filter(f => f > 0.01 && f < 0.99).sort((a, b) => a - b); fr = fr.filter((f, i) => !i || f - fr[i - 1] > 0.005);
      } else if (st.sectorMode === 'UserDefined' && ref.session.corners && ref.session.corners.length) {
        // custom sectors = one per corner, boundary at each corner exit
        const k = Math.cos(S[0].lat * Math.PI / 180); const distOf = (p) => { let bi = 0, bd = Infinity; for (let i = 0; i < S.length; i += 2) { const dd = (S[i].lat - p[0]) ** 2 + ((S[i].lon - p[1]) * k) ** 2; if (dd < bd) { bd = dd; bi = i; } } return S[bi].dist / L; };
        fr = ref.session.corners.map(c => distOf(c.end)).filter(f => f > 0.02 && f < 0.98).sort((a, b) => a - b);
        fr = fr.filter((f, i) => !i || f - fr[i - 1] > 0.01);
      } else if (st.sectorMode === 'MaxSpeed' || st.sectorMode === 'AccelDecel') {
        // boundaries at the strongest speed peaks (end of straights) — and, for Accel/Decel, also at the strongest minima (apexes)
        const win = Math.max(2, Math.round(S.length / 400)); const v = S.map((s, i) => { let a = 0, c = 0; for (let j = Math.max(0, i - win); j <= Math.min(S.length - 1, i + win); j++) { a += S[j].speed; c++; } return a / c; });
        const cands = [];
        for (let i = 2; i < S.length - 2; i++) {
          const isMax = v[i] >= v[i - 1] && v[i] >= v[i + 1] && v[i] > v[i - 2] && v[i] > v[i + 2];
          const isMin = v[i] <= v[i - 1] && v[i] <= v[i + 1] && v[i] < v[i - 2] && v[i] < v[i + 2];
          if (!isMax && !(isMin && st.sectorMode === 'AccelDecel')) continue;
          // prominence: how far the speed drops (or rises) on both sides before the trend reverses by more than it
          // (scanned cyclically: a lap that starts mid-straight must not truncate the main-straight peak)
          const N = S.length; let lo = v[i], hi = v[i]; for (let k = 0; k < N; k++) { const j = (i - k + N) % N; if (isMax) { lo = Math.min(lo, v[j]); if (v[j] > v[i]) break; } else { hi = Math.max(hi, v[j]); if (v[j] < v[i]) break; } }
          let lo2 = v[i], hi2 = v[i]; for (let k = 0; k < N; k++) { const j = (i + k) % N; if (isMax) { lo2 = Math.min(lo2, v[j]); if (v[j] > v[i]) break; } else { hi2 = Math.max(hi2, v[j]); if (v[j] < v[i]) break; } }
          const prom = isMax ? Math.min(v[i] - lo, v[i] - lo2) : Math.min(hi - v[i], hi2 - v[i]);
          const f = S[i].dist / L; if (f > 0.03 && f < 0.97) cands.push({ f, prom, isMax });
        }
        cands.sort((a, b) => b.prom - a.prom);
        const picked = []; for (const c of cands) { if (picked.length >= n0 - 1) break; if (picked.every(p => Math.abs(p.f - c.f) > 120 / L)) picked.push(c); }
        fr = picked.map(p => p.f).sort((a, b) => a - b);
      }
      if (!fr || !fr.length) fr = Array.from({ length: n0 - 1 }, (_, i) => (i + 1) / n0);
      return this._sm = { key, n: fr.length + 1, fr, mode: st.sectorMode };
    },

    // ---------- start/finish editing ----------
    placeStartFinish(lat, lon) {
      const s = this.session; if (!s || s.isDemo) { this.sfMode = false; return this.alert('Set Start/Finish line', 'Load a .vbo file first.'); }
      const g = CTVbo.gateFromPoint(s.dec, [lat, lon], this.settings.gateWidth, s.P);
      if (g.distToTrace > 60) return this.toast('Set Start/Finish line', `Click closer to the driven line (nearest point is ${g.distToTrace.toFixed(0)} m away).`);
      const finish = this.sfMode === 'finish'; this.sfMode = false; document.body.style.cursor = '';
      if (finish) s.customFinish = g; else s.customGate = g;
      this.resplit(s);
      this.toast(finish ? 'Separate finish line set' : 'Start/Finish line set', `${s.laps.filter(l => l.kind === 'lap').length} ${finish ? 'point-to-point runs' : 'laps'} detected with the custom ${finish ? 'finish' : 'gate'}.`);
    },
    resplit(s, opts = {}) {
      const wasRef = this.allLaps().find(l => l.isRef); const refSession = wasRef && wasRef.session;
      this.rebuildSession(s, opts);
      if (!refSession || refSession === s) { const complete = s.laps.filter(l => l.kind === 'lap').sort((a, b) => a.time - b.time); if (complete[0]) { complete[0].selected = true; complete[0].isRef = true; } if (complete[1]) complete[1].selected = true; }
      this.assignColours(); this.allLaps().forEach(l => l._cache = null); this.cursorX = 0; this.renderAll(); this.map.fit();
    },

    // ---------- channels ----------
    channelDefs() {
      const dp = this.settings.decimalPlaces; const su = this.speedLabel();
      const named = (k, fallback) => { const src = this.sessions.map(s => s.channelMap && s.channelMap[k]).filter(Boolean); return src.length ? `${fallback} (${[...new Set(src)].join(', ')})` : fallback; };
      const defs = {
        speed: { label: 'Speed', group: 'Standard Channels', get: s => this.unitSpeed(s.speed), format: v => `${v.toFixed(dp)} ${su}`, minZero: true },
        delta: { label: 'Delta-T', group: 'Calculated Channels', get: null, format: v => `${v.toFixed(dp)} s` },
        throttle: { label: named('throttle', 'Throttle Position'), group: 'Named Channels', get: s => s.throttle, format: v => `${v.toFixed(dp)} %`, fixed: [0, 100] },
        brake: { label: named('brake', 'Brake Pressure'), group: 'Named Channels', get: s => s.brake, format: v => `${v.toFixed(dp)} bar`, minZero: true },
        rpm: { label: named('rpm', 'RPM'), group: 'Named Channels', get: s => s.rpm, format: v => `${v.toFixed(0)} rpm`, minZero: true },
        steer: { label: named('steer', 'Steering Angle'), group: 'Named Channels', get: s => s.steer, format: v => `${v.toFixed(dp)} °` },
        gear: { label: named('gear', 'Gear'), group: 'Named Channels', get: s => s.gear, format: v => `${v.toFixed(0)}`, fixed: [0, 8] },
        latacc: { label: 'Lateral acceleration', group: 'Standard Channels', get: s => s.latG, format: v => `${v.toFixed(dp)} g` },
        longacc: { label: 'Longitudinal acceleration', group: 'Standard Channels', get: s => s.longG, format: v => `${v.toFixed(dp)} g` },
        combo: { label: 'Combined acceleration', group: 'Calculated Channels', get: s => Math.hypot(s.latG, s.longG), format: v => `${v.toFixed(dp)} g`, minZero: true },
        heading: { label: 'Heading', group: 'Standard Channels', get: s => ((90 - s.heading * 180 / Math.PI) % 360 + 360) % 360, format: v => `${v.toFixed(dp)} °` },
        height: { label: 'Height', group: 'Standard Channels', get: s => s.session && s.session.vbo && s.session.vbo.data.height ? s.session.vbo.data.height[s.i] : 118 + Math.sin(s.dist / 300) * 12, format: v => `${v.toFixed(dp)} m` },
        distance: { label: 'Distance', group: 'Calculated Channels', get: s => s.dist, format: v => `${v.toFixed(0)} m`, minZero: true },
        elapsed: { label: 'Elapsed time', group: 'Calculated Channels', get: s => s.t, format: v => `${v.toFixed(dp)} s`, minZero: true },
        sats: { label: 'Satellites', group: 'Standard Channels', get: s => s.session && s.session.vbo && s.session.vbo.data.sats ? s.session.vbo.data.sats[s.i] : 12, format: v => `${v.toFixed(0)}`, fixed: [0, 24] },
        sector: { label: 'Sector number', group: 'Calculated Channels', get: s => { const sm = this.sectorModel(); const f = s.dist / this.refLap().lengthM; let k = 0; while (k < sm.fr.length && f >= sm.fr[k]) k++; return k + 1; }, format: v => `${v.toFixed(0)}` },
      };
      // Maths channels: Standard Maths Library (expression templates with parameters) + the user's own expressions
      const mathsDef = (m, key, user) => {
        const units = m.units || ''; const bool = !!m.bool || /^if\(.*,\s*1\s*,\s*0\s*\)$/.test(m.expr.trim());
        return { label: `Maths: ${m.name}`, group: 'Maths Channels', get: null, expr: m.expr, unit: units, mathsId: m.id, user,
          params: Object.assign({}, m.params || {}, (this.maths.params[m.id] || {})),
          format: bool ? (v => v ? 'Yes' : 'No') : (v => isNaN(v) ? '—' : `${Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(dp)} ${units}`.trim()),
          fixed: bool ? [0, 1.2] : undefined, minZero: !!m.minZero };
      };
      for (const m of CTMaths.LIBRARY) defs[m.id] = mathsDef(m, m.id, false);
      for (const m of this.maths.mine) if (m.expr) defs['u:' + m.id] = mathsDef(m, 'u:' + m.id, true);
      // raw file channels (union across sessions)
      const seen = new Set();
      for (const s of this.sessions) for (const c of (s.fileCols || [])) {
        if (seen.has(c)) continue; seen.add(c); const unit = (s.units && s.units[c] && s.units[c] !== '(null)') ? s.units[c].replace(/Â/g, '') : '';
        defs['f:' + c] = { label: c, group: 'CAN Channels', unit, get: smp => (smp.session && smp.session.vbo && smp.session.vbo.data[c]) ? smp.session.vbo.data[c][smp.i] : NaN, format: v => isNaN(v) ? '—' : `${Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(dp)} ${unit}`.trim() };
      }
      return defs;
    },
    toggleChannel(key, on) { if (on) { if (!this.selectedChannels.includes(key)) this.selectedChannels.push(key); } else this.selectedChannels = this.selectedChannels.filter(k => k !== key); },
    graphChannels() { const d = this.channelDefs(); return this.selectedChannels.map(k => Object.assign({ key: k }, d[k])).filter(c => c.label); },
    channelSeries(lap, ch) {
      lap._cache = lap._cache || {}; const ref = this.refLap(); const key = ch.key + '|' + this.settings.graphMode + '|' + this.settings.speedUnit + '|' + this.settings.sectors + '|' + this.settings.sectorMode + '|' + (ref && ref.id) + '|' + this.mathsRev;
      if (lap._cache[key]) return lap._cache[key];
      const x = [], y = [];
      if (ch.key === 'delta') {
        lap.samples.forEach((s, i) => { x.push(this.chart.xOf(lap, s, i)); const rs = sampleAt(ref, s.dist); y.push(lap === ref ? 0 : s.t - rs.t); });
      } else if (ch.expr) {
        const vals = this.evalMaths(lap, ch);
        lap.samples.forEach((s, i) => { x.push(this.chart.xOf(lap, s, i)); y.push(vals[i]); });
      } else if (ch.derived) {
        lap.samples.forEach((s, i) => { const p = lap.samples[Math.max(0, i - 2)]; const dt = Math.max(0.02, s.t - p.t); x.push(this.chart.xOf(lap, s, i)); y.push((s[ch.derived] - p[ch.derived]) / dt); });
      } else { for (let i = 0; i < lap.samples.length; i++) { const s = lap.samples[i]; const v = ch.get(s); if (isNaN(v)) continue; x.push(this.chart.xOf(lap, s, i)); y.push(v); } }
      return lap._cache[key] = { x, y };
    },
    // ---------- maths channel evaluation ----------
    compileMaths(expr) { this._compiled = this._compiled || {}; if (!this._compiled[expr]) this._compiled[expr] = CTMaths.compile(expr); return this._compiled[expr]; },
    // names an expression may reference: sample fields, raw file columns, other maths channels (by name)
    mathsNames() {
      const out = new Map(); Object.keys(CTMaths.SAMPLE_VARS).forEach(k => out.set(k, { kind: 'sample' }));
      ['height', 'sats'].forEach(k => out.set(k, { kind: 'std' }));
      for (const s of this.sessions) for (const c of (s.fileCols || [])) if (!out.has(c.toLowerCase())) out.set(c.toLowerCase(), { kind: 'file', col: c });
      for (const m of CTMaths.LIBRARY) out.set(m.name.toLowerCase(), { kind: 'maths', id: m.id });
      for (const m of this.maths.mine) if (m.expr) out.set(m.name.toLowerCase(), { kind: 'maths', id: 'u:' + m.id });
      return out;
    },
    evalMaths(lap, ch, depth = 0) {
      const S = lap.samples; const n = S.length; let comp;
      try { comp = this.compileMaths(ch.expr); } catch (e) { return new Float64Array(n).fill(NaN); }
      const names = this.mathsNames(); const defs = depth < 4 ? this.channelDefs() : {}; const sub = {};
      const vbo = lap.session.vbo; const fileCol = (c, i) => (vbo && vbo.data[c]) ? vbo.data[c][S[i].i] : NaN;
      const resolve = {};
      for (const v of comp.vars) {
        const lv = v.toLowerCase(); const nm = names.get(lv);
        if (!nm) resolve[v] = () => NaN;
        else if (nm.kind === 'sample') { const f = CTMaths.SAMPLE_VARS[lv]; resolve[v] = i => f(S[i]); }
        else if (nm.kind === 'std') resolve[v] = lv === 'height' ? (i => vbo && vbo.data.height ? vbo.data.height[S[i].i] : 118 + Math.sin(S[i].dist / 300) * 12) : (i => vbo && vbo.data.sats ? vbo.data.sats[S[i].i] : 12);
        else if (nm.kind === 'file') resolve[v] = i => fileCol(nm.col, i);
        else if (nm.kind === 'maths') { const d = defs[nm.id]; if (!d || d.expr === ch.expr) resolve[v] = () => NaN; else { const arr = this.evalMaths(lap, Object.assign({ key: nm.id }, d), depth + 1); resolve[v] = i => arr[i]; } }
      }
      const params = ch.params || {};
      const ctx = { get: (v, i) => resolve[v](i), param: p => { const val = params[p]; return val === undefined || val === '' ? NaN : +val; }, t: i => S[i].t };
      return comp.series(ctx, n);
    },
    // validate an expression: returns { ok, error, unknown:[names] }
    checkMaths(expr) {
      try { const c = this.compileMaths(expr); const names = this.mathsNames(); const unknown = c.vars.filter(v => !names.has(v.toLowerCase())); return { ok: !unknown.length, error: unknown.length ? `Unknown channel: ${unknown.join(', ')}` : '', comp: c }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    channelValueAtCursor(lap, ch) {
      const d = this.cursorDist(); const s = sampleAt(lap, d);
      if (ch.key === 'delta') { const r = sampleAt(this.refLap(), d); return lap === this.refLap() ? 0 : s.t - r.t; }
      if (ch.get && !ch.derived) { // raw channels need the nearest real sample index
        if (ch.key.startsWith('f:')) { const i = Math.round(s.i); return ch.get(Object.assign({}, s, { i })); } return ch.get(s);
      }
      const ser = this.channelSeries(lap, ch); let idx = lap.samples.findIndex(q => q.dist >= d); if (idx < 0) idx = ser.y.length - 1; return ser.y[Math.min(idx, ser.y.length - 1)];
    },

    // ---------- rendering ----------
    renderAll() { this.renderRibbonState(); this.renderLaps(); this.renderVideo(); this.renderSectorBar(); this.chart.invalidate(); this.chart.draw(); this.map.drawTraces(); this.map.updateCursor(); this.renderMapCtx(); this._lastSector = this.currentSector(); },
    // Per-frame work is kept minimal: chart overlay + map marker + video HUD every frame; the DOM-heavy bits are throttled.
    renderCursor() {
      const now = performance.now();
      this.chart.draw(); this.map.updateCursor(); this.renderHud();
      const sec = this.currentSector();
      if (sec !== this._lastSector) { this._lastSector = sec; this.renderSectorBar(); this.highlightSectorColumn(); }
      if (now - (this._lastCtx || 0) > 100) { this._lastCtx = now; this.renderMapCtx(); }
    },
    renderRibbonState() {
      $('#btn-laps').classList.toggle('checked', this.settings.sessionMode === 'Laps');
      $('#btn-sessions').classList.toggle('checked', this.settings.sessionMode === 'Sessions');
      $('#speed-combo span').textContent = 'x ' + this.playbackSpeed;
      $('#track-combo span').textContent = this.session ? this.session.trackName : '';
      $('#btn-play img').src = ICON(this.settings.theme === 'Dark' ? (this.playing ? 'playback-pause-light' : 'playback-play-light') : (this.playing ? 'playback-pause' : 'playback-play'));
      $('#btn-play span').textContent = this.playing ? 'Pause' : 'Play';
      const d = $('#dock'); for (const k of ['sessions', 'graph', 'video', 'map']) d.dataset['hide' + k[0].toUpperCase() + k.slice(1)] = this.settings.panes[k] ? '' : '1';
      const s = this.session; $('#status').textContent = s ? `${s.trackName}${s.country ? ', ' + s.country : ''} · ${s.laps.filter(l => l.kind === 'lap').length} laps · ${s.rateHz} Hz · S/F: ${s.isDemo ? 'database' : s.gateSource || 'none'}` : '';
    },
    renderLaps() {
      const host = $('#laps-host'); const ref = this.refLap(); if (!ref) { host.innerHTML = ''; return; } const sm = this.sectorModel(); const ns = sm.n; const sectorTimes = (l) => CTData.sectorTimes(l, sm.fr); const refS = sectorTimes(ref); const dp = this.settings.decimalPlaces;
      const secFmt = (arr, i) => this.settings.sectorTimeFormat === 'StartToSector' ? arr.slice(0, i + 1).reduce((a, b) => a + b, 0) : arr[i];
      const cur = this.currentSector();
      let laps;
      if (this.settings.sessionMode === 'Sessions') laps = this.sessions.map(s => s.laps.filter(l => l.kind === 'lap').sort((a, b) => a.time - b.time)[0]).filter(Boolean);
      else laps = this.visibleLaps(this.session);
      if (this.sortBy === 'time') laps.sort((a, b) => a.time - b.time); else if (this.sortBy === 'lap') laps.sort((a, b) => a.number - b.number); else if (this.sortBy === 'vmax') laps.sort((a, b) => b.vmax - a.vmax);
      const complete = this.session.laps.filter(l => l.kind === 'lap'); const fastest = complete.length ? complete.reduce((a, b) => a.time < b.time ? a : b) : null;
      let h = `<table class="laps"><thead><tr><th>Show</th><th data-sort="lap" class="${this.sortBy === 'lap' ? 'sorted' : ''}">${this.settings.sessionMode === 'Sessions' ? 'Session' : 'Lap'}</th><th data-sort="time" class="${this.sortBy === 'time' ? 'sorted' : ''}">Time</th><th>Delta</th>${this.settings.showVmax ? `<th data-sort="vmax" class="${this.sortBy === 'vmax' ? 'sorted' : ''}">VMax</th>` : ''}<th>Ref</th>`;
      for (let s = 1; s <= ns; s++) h += `<th class="${s === cur ? 'sector-cur' : ''}">S${s}</th>`;
      h += '</tr></thead><tbody>';
      const row = (l) => {
        const st = sectorTimes(l); const isRef = l === ref;
        let r = `<tr class="${isRef ? 'ref' : ''} ${l === fastest ? 'fastest' : ''} ${l.kind !== 'lap' ? 'ideal' : ''}" data-id="${l.id}">`;
        r += `<td class="c"><input type="checkbox" class="chk show" ${l.selected ? 'checked' : ''} style="accent-color:${l.colour || 'var(--accent)'}"></td>`;
        r += `<td>${this.settings.sessionMode === 'Sessions' ? l.session.name + ' · L' + l.number : this.lapName(l)}</td><td class="time">${fmtTime(l.time)}</td>`;
        const d = l.time - ref.time; r += `<td class="${isRef ? '' : d > 0 ? 'slower' : 'faster'}">${isRef ? '0.00' : fmtDelta(d, dp)}</td>`;
        if (this.settings.showVmax) r += `<td>${this.unitSpeed(l.vmax).toFixed(dp)}</td>`;
        r += `<td class="c"><input type="checkbox" class="chk ref" ${isRef ? 'checked' : ''}></td>`;
        for (let s = 0; s < ns; s++) { const v = secFmt(st, s), rv = secFmt(refS, s); const dd = v - rv; r += `<td class="${s + 1 === cur ? 'sector-cur' : ''} ${isRef ? '' : dd > 0 ? 'slower' : 'faster'}">${isRef ? v.toFixed(dp) : fmtDelta(dd, dp)}</td>`; }
        return r + '</tr>';
      };
      for (const l of laps) h += row(l);
      if (complete.length) {
        const best = Array.from({ length: ns }, (_, i) => Math.min(...complete.map(l => sectorTimes(l)[i])));
        const idealT = best.reduce((a, b) => a + b, 0);
        h += `<tr class="ideal"><td class="c"></td><td>Ideal</td><td>${fmtTime(idealT)}</td><td class="faster">${fmtDelta(idealT - ref.time, dp)}</td>${this.settings.showVmax ? `<td>${this.unitSpeed(Math.max(...complete.map(l => l.vmax))).toFixed(dp)}</td>` : ''}<td></td>`;
        for (let s = 0; s < ns; s++) { const dd = secFmt(best, s) - secFmt(refS, s); h += `<td class="faster ${s + 1 === cur ? 'sector-cur' : ''}">${fmtDelta(dd, dp)}</td>`; }
        h += '</tr>';
      }
      h += '</tbody><tfoot>';
      const sl = this.selectedLaps()[0] || ref; const sst = sectorTimes(sl);
      h += `<tr><td class="c"><input type="checkbox" class="chk" checked disabled style="accent-color:${sl.colour}"></td><td>Lap ${this.lapName(sl)}</td><td>${fmtTime(sl.time)}</td><td>${fmtTime(sl.time).slice(0, 7)}</td>${this.settings.showVmax ? `<td>${this.unitSpeed(sl.vmax).toFixed(dp)}</td>` : ''}<td class="c"><input type="checkbox" class="chk ref" ${sl === ref ? 'checked' : ''} disabled></td>`;
      for (let s = 0; s < ns; s++) h += `<td>${secFmt(sst, s).toFixed(dp)}</td>`;
      h += '</tr></tfoot></table>';
      host.innerHTML = h;
      // tabs
      $('#session-tabs').innerHTML = this.sessions.map((s) => `<div class="session-tab ${s === this.session ? 'selected' : ''}" data-s="${this.sessions.indexOf(s)}" title="${s.fileName}">${s.name}<span class="x" title="Close session">✕</span></div>`).join('') + `<div class="session-tab add" title="Load a file for analysis [Ctrl+O] or [F3]">+</div>`;
      $$('.session-tab[data-s]').forEach(t => { t.onclick = e => { if (e.target.classList.contains('x')) return; this.session = this.sessions[+t.dataset.s]; this.renderAll(); this.map.fit(); }; $('.x', t).onclick = () => this.confirm('Close Session', `Close ${this.sessions[+t.dataset.s].name}?`, () => this.closeSession(this.sessions[+t.dataset.s])); });
      $('.session-tab.add').onclick = () => this.pickFiles();
      // events
      $$('table.laps tbody tr[data-id]').forEach(tr => {
        const lap = this.allLaps().find(l => l.id === +tr.dataset.id);
        $('.chk.show', tr).onchange = e => { if (e.target.checked && this.selectedLaps().length >= 10) { e.target.checked = false; return this.alert('Lap Maximum Reached', 'A maximum of 10 laps can be selected at a time.'); } lap.selected = e.target.checked; if (!this.selectedLaps().length) { lap.selected = true; e.target.checked = true; } this.assignColours(); this.renderAll(); };
        $('.chk.ref', tr).onchange = () => { this.allLaps().forEach(l => l.isRef = false); lap.isRef = true; lap.selected = true; this.allLaps().forEach(l => l._cache = null); this.assignColours(); this.renderAll(); };
        tr.onclick = e => { if (e.target.tagName === 'INPUT') return; $$('table.laps tr.highlight').forEach(r => r.classList.remove('highlight')); tr.classList.add('highlight'); };
        tr.ondblclick = () => { if (!lap.selected) { lap.selected = true; this.assignColours(); this.renderAll(); } };
      });
      $$('table.laps th[data-sort]').forEach(th => th.onclick = () => { this.sortBy = th.dataset.sort; this.renderLaps(); });
    },
    highlightSectorColumn() {
      const cur = this.currentSector(); const base = 5 + (this.settings.showVmax ? 1 : 0);
      $$('table.laps tr').forEach(tr => Array.from(tr.children).forEach((td, i) => { if (i >= base) td.classList.toggle('sector-cur', i - base + 1 === cur && tr.parentElement.tagName !== 'TFOOT'); }));
    },
    renderSectorBar() {
      const sm = this.sectorModel(); const ns = sm.n; const cur = this.currentSector(); const bar = $('#sector-bar');
      const f0 = i => i ? sm.fr[i - 1] : 0, f1 = i => i + 1 < ns ? sm.fr[i] : 1;
      bar.innerHTML = Array.from({ length: ns }, (_, i) => `<div class="${i + 1 === cur ? 'cur' : ''}" title="Sector ${i + 1}${sm.mode === 'UserDefined' && !this.trackSplits().length && this.session.corners[i] ? ' · ' + this.session.corners[i].name : ''}">S${i + 1}</div>`).join('');
      Array.from(bar.children).forEach((d, i) => { d.style.flex = String(Math.max(0.05, f1(i) - f0(i))); d.onclick = () => { const ref = this.selectedLaps()[0] || this.refLap(); const dist = ref.lengthM * (f0(i) + f1(i)) / 2; const s = sampleAt(ref, dist); const idx = ref.samples.findIndex(q => q.dist >= dist); this.setCursorX(this.settings.graphMode === 'Time' ? s.t : this.settings.graphMode === 'Distance' ? dist : idx); }; });
      bar.style.marginLeft = this.chart.left + 'px'; bar.style.marginRight = this.chart.right + 'px';
    },
    renderVideo() {
      const laps = this.selectedLaps(); const g = $('#video-grid');
      const best = (s) => { const c = s.laps.filter(l => l.kind === 'lap'); return c.length ? Math.min(...c.map(x => x.time)) : 0; };
      g.innerHTML = laps.slice(0, 4).map(l => {
        const s = l.session; const want = Math.round(l.samples[Math.min(5, l.samples.length - 1)].avifile) || 1;
        const entry = s.videos && (s.videos[want] || null); const anyVid = s.videos && Object.keys(s.videos).length;
        const vid = !!entry; const src = vid ? entry.url : 'assets/video/no-video.mp4';
        const short = n => n.length > 34 ? '…' + n.slice(-32) : n; const note = s.isDemo ? '' : vid ? ` · ${short(entry.name)}` : anyVid ? ` · missing ${this.expectedVideoName(s, want)}` : ` · expects ${this.expectedVideoName(s, want)} — drop it or the session folder here`;
        const prev = s.laps.find(x => x.number === l.number - 1 && x.kind === 'lap');
        return `<div class="video-pane" style="--lap-colour:${l.colour}" data-id="${l.id}" data-real="${vid ? 1 : 0}" data-file="${want}">
        <video src="${src}" muted ${vid ? '' : 'loop'} playsinline preload="auto"></video>
        <div class="hud"><b>${l.session.isDemo ? 'TEAM RACELOGIC' : l.session.name.slice(0, 22).toUpperCase()}</b><div class="row"><span>CURRENT</span><span class="cur">00:00.00</span></div><div class="row"><span>BEST</span><span>${fmtTime(best(l.session))}</span></div><div class="row"><span>PREVIOUS</span><span>${fmtTime((prev || l).time)}</span></div><div class="row"><span>LAPS</span><span>${String(l.number).padStart(3, '0')}</span></div></div>
        <div class="brand">VBOX<small>MOTORSPORT</small></div>
        <button class="vmute ${this.audioLapId === l.id ? 'on' : ''}" title="${this.audioLapId === l.id ? 'Mute' : 'Sound on (mutes the other videos)'}">${this.audioLapId === l.id ? '🔊' : '🔇'}</button>
        <div class="lapno">Lap ${this.lapName(l)}${note}</div>
        <canvas class="speedo" width="132" height="132"></canvas>
      </div>`; }).join('') || `<div class="video-pane" style="--lap-colour:transparent;color:#aaa;font-size:12px">No video file associated with .vbo file</div>`;
      $$('.video-pane[data-id]', g).forEach(p => { const v = p.querySelector('video'); const id = +p.dataset.id; v.muted = this.audioLapId !== id; v.volume = 1;
        $('.vmute', p).onclick = e => { e.stopPropagation(); this.audioLapId = this.audioLapId === id ? null : id; $$('.video-pane[data-id]', g).forEach(q => { const qv = q.querySelector('video'); const on = +q.dataset.id === this.audioLapId; qv.muted = !on; const b = $('.vmute', q); b.textContent = on ? '🔊' : '🔇'; b.classList.toggle('on', on); b.title = on ? 'Mute' : 'Sound on (mutes the other videos)'; }); if (this.audioLapId === id && v.paused && this.playing) v.play().catch(() => { }); }; });
      $$('.video-pane video', g).forEach(v => { v.onloadedmetadata = () => this.renderHud(); v.onerror = () => { const p = v.closest('.video-pane'); if (p && p.dataset.real === '1') $('.lapno', p).textContent += ' · cannot decode this video in the browser (needs H.264 MP4)'; }; });
      this.renderHud();
    },
    renderHud() {
      $$('.video-pane[data-id]').forEach(p => {
        const lap = this.allLaps().find(l => l.id === +p.dataset.id); if (!lap) return; const s = this.sampleAtCursor(lap);
        $('.hud .cur', p).textContent = fmtTime(s.t);
        const v = p.querySelector('video');
        if (v && v.readyState >= 1 && v.duration) {
          const real = p.dataset.real === '1'; const now = performance.now();
          const want = Math.max(0, Math.min(v.duration - 0.05, real ? (isNaN(s.avitime) ? s.t : s.avitime / 1000 + this.settings.videoOffset) : (s.t / lap.time) * v.duration));
          if (this.playing) {
            const base = Math.min(4, Math.max(0.25, this.playbackSpeed));
            if (v.paused && !v._starting) { v._starting = true; v.play().then(() => v._starting = false).catch(() => v._starting = false); }
            if (this._masterLapId === lap.id) { if (Math.abs(v.playbackRate - base) > 0.01) v.playbackRate = base; }
            else {
              // follower: steer with playback rate (±15 %) so it never stalls; hard seek only when hopelessly off
              const drift = v.currentTime - want;
              if (Math.abs(drift) > 2.5 && now - (v._lastSeek || 0) > 3000) { v._lastSeek = now; v.currentTime = want; }
              else { const rate = base * (1 - Math.max(-0.15, Math.min(0.15, drift * 0.4))); if (Math.abs(v.playbackRate - rate) > 0.005) v.playbackRate = rate; }
            }
          } else {
            if (!v.paused) v.pause();
            // scrubbing: at most ~8 seeks per second, and only if the frame actually changed
            if (Math.abs(v.currentTime - want) > 0.12 && now - (v._lastSeek || 0) > 120 && !v.seeking) { v._lastSeek = now; v.currentTime = want; }
          }
        }
        const c = $('.speedo', p); const ctx = c.getContext('2d'); ctx.clearRect(0, 0, 132, 132);
        ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.arc(66, 66, 62, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#333'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(66, 66, 50, Math.PI * .75, Math.PI * 2.25); ctx.stroke();
        const spd = this.unitSpeed(s.speed), max = this.settings.speedUnit === 'mph' ? 200 : 300; const ang = Math.PI * .75 + Math.min(1, spd / max) * Math.PI * 1.5;
        ctx.strokeStyle = '#d00'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(66, 66); ctx.lineTo(66 + Math.cos(ang) * 46, 66 + Math.sin(ang) * 46); ctx.stroke();
        ctx.fillStyle = '#000'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(spd.toFixed(0), 66, 100); ctx.font = '9px sans-serif'; ctx.fillText(this.speedLabel(), 66, 112);
        if (lap.session.channelMap && lap.session.channelMap.gear) { ctx.font = 'bold 12px sans-serif'; ctx.fillText('G' + Math.round(s.gear || 0), 66, 56); }
        if (this.settings.speedOverlay) { ctx.fillStyle = '#0a0'; ctx.fillRect(10, 10, 112 * Math.min(1, spd / max), 4); }
      });
    },
    renderMapCtx() {
      const laps = this.selectedLaps(); const box = $('#map-ctx'); if (!laps.length) { box.classList.add('hidden'); return; } box.classList.remove('hidden');
      const dp = this.settings.decimalPlaces; const d = this.cursorDist(); const ref = this.refLap();
      box.innerHTML = `<div class="row"><b>Speed</b><span></span></div>` + laps.map(l => { const s = sampleAt(l, d); return `<div class="row"><span style="color:${l.colour}">■ ${l.session.name.slice(0, 10)} L${l.number}</span><span>${this.unitSpeed(s.speed).toFixed(dp)} ${this.speedLabel()}</span></div>`; }).join('') + `<div class="row" style="margin-top:4px"><b>Delta-T</b><span></span></div>` + laps.map(l => { const s = sampleAt(l, d); const r = sampleAt(ref, d); return `<div class="row"><span style="color:${l.colour}">■ L${l.number}</span><span>${(l === ref ? 0 : s.t - r.t).toFixed(dp)} s</span></div>`; }).join('') + (this.sfMode ? `<div class="row" style="margin-top:6px;color:var(--accent)"><b>${this.sfMode === 'sector' ? `Click on the driven line to add sector split ${this.trackSplits().length + 1} (Esc when done)` : `Click on the driven line to set ${this.sfMode === 'finish' ? 'the separate Finish line' : 'Start/Finish'}`}</b></div>` : '');
    },

    // ---------- playback ----------
    // binary search of a lap's samples by avitime (ms) or by t (s)
    indexBy(lap, key, val) {
      const S = lap.samples; let lo = 0, hi = S.length - 1; if (val <= S[0][key]) return 0; if (val >= S[hi][key]) return hi;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m][key] <= val) lo = m; else hi = m; } return hi;
    },
    tick(t) {
      if (this.playing) {
        const ref = this.selectedLaps()[0] || this.refLap();
        if (ref) {
          const m = this.settings.graphMode;
          const v = document.querySelector(`.video-pane[data-id="${ref.id}"][data-real="1"] video`);
          let idx;
          if (v && v.readyState >= 2 && !v.paused && !v.seeking && !isNaN(ref.samples[0].avitime)) {
            // VIDEO IS THE MASTER CLOCK: never seek it while playing; the data follows the frame being shown
            this._masterLapId = ref.id;
            const vt = (v.currentTime - this.settings.videoOffset) * 1000; const last = ref.samples[ref.samples.length - 1];
            if (vt >= last.avitime + 80) idx = -1; else idx = this.indexBy(ref, 'avitime', vt);
          } else {
            this._masterLapId = null;
            const dt = Math.min(0.1, (t - (this._last || t)) / 1000); const s = this.sampleAtCursor(ref);
            const tNew = s.t + dt * this.playbackSpeed; idx = tNew > ref.time ? -1 : this.indexBy(ref, 't', tNew);
          }
          if (idx < 0) { this.playing = false; this._masterLapId = null; this.renderRibbonState(); this.renderHud(); }
          else { const nxt = ref.samples[idx]; this.cursorX = m === 'Time' ? nxt.t : m === 'Distance' ? nxt.dist : idx; this.renderCursor(); }
        }
      }
      this._last = t; requestAnimationFrame(tt => this.tick(tt));
    },
    togglePlay() { this.playing = !this.playing; this.renderRibbonState(); this.renderHud(); },
    stop() { if (this.playing) { this.playing = false; this._stopPos = this.cursorX; } else if (this._stopPos != null) { this.cursorX = this._stopPos; this._stopPos = null; } else this.cursorX = this.chart.xRange()[0]; this.renderRibbonState(); this.renderCursor(); },

    // ---------- file picking / drop ----------
    pickFiles() { const inp = $('#file-input'); inp.value = ''; inp.click(); },

    // ---------- UI binding ----------
    bindUI() {
      const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);
      on('#file-input', 'change', e => this.loadFiles(e.target.files));
      // drag & drop anywhere
      let dragDepth = 0; const dz = $('#dropzone');
      window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; dz.classList.remove('hidden'); });
      window.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; dz.classList.add('hidden'); } });
      window.addEventListener('dragover', e => e.preventDefault());
      window.addEventListener('drop', async e => { e.preventDefault(); dragDepth = 0; dz.classList.add('hidden'); const files = await this.filesFromDrop(e.dataTransfer); if (files.length) this.loadFiles(files); });
      on('#folder-input', 'change', e => this.loadFiles(e.target.files));
      on('#btn-file', 'click', e => this.menuFile(e.currentTarget));
      on('#btn-clear', 'click', () => this.confirm('Close All Sessions', 'Clear all Session Data?', () => this.clearSessions()));
      on('#btn-view', 'click', e => this.menuView(e.currentTarget));
      on('#btn-laps', 'click', () => { this.settings.sessionMode = 'Laps'; this.renderRibbonState(); this.renderLaps(); });
      on('#btn-sessions', 'click', () => { this.settings.sessionMode = 'Sessions'; this.renderRibbonState(); this.renderLaps(); if (this.sessions.length < 2) this.toast('Sessions', 'Compares the best lap of each loaded session. Load more .vbo files to compare sessions.'); });
      on('#btn-channels', 'click', e => this.menuChannels(e.currentTarget));
      on('#btn-maths', 'click', () => this.winMaths());
      on('#btn-reports', 'click', () => this.winReports());
      on('#btn-measure', 'click', () => this.winMeasure());
      on('#btn-play', 'click', () => this.togglePlay());
      on('#btn-stop', 'click', () => this.stop());
      on('#btn-full', 'click', () => this.toggleMaximize('video'));
      on('#speed-combo', 'click', e => this.menu(e.currentTarget, [0.25, 0.5, 1, 2, 4, 8].map(v => ({ label: 'x ' + v, checked: v === this.playbackSpeed, click: () => { this.playbackSpeed = v; this.renderRibbonState(); } }))));
      on('#track-combo', 'click', e => this.menuTrack(e.currentTarget));
      on('#btn-trackmenu', 'click', e => this.menuTrackOptions(e.currentTarget));
      on('#btn-insights', 'click', () => this.winInsights());
      on('#btn-insights-caret', 'click', e => { e.stopPropagation(); this.menu(e.currentTarget, [{ label: 'Insights', icon: ICON('insights', 'medium'), click: () => this.winInsights() }, { label: 'Track Report', icon: ICON('track-report-light', 'medium'), click: () => this.winTrackReport() }, { sep: true }, { head: 'Show Corner Labels' }, ...['All', 'WithNotes', 'None'].map(v => ({ label: { All: 'All', WithNotes: 'With Notes', None: 'None' }[v], checked: this.settings.cornerLabels === v, click: () => { this.settings.cornerLabels = v; this.save(); this.map.drawCorners(); } }))]); });
      on('#btn-settings', 'click', () => this.winSettings());
      on('#btn-help', 'click', e => this.menu(e.currentTarget, [{ label: 'Help', click: () => window.open('https://racelogic.support/01VBOX_Motorsport/Circuit_Tools_3', '_blank') }, { label: 'Release Notes', click: () => window.open('https://racelogic.support/01VBOX_Motorsport/Circuit_Tools_3/CircuitTools_V3_Updates', '_blank') }, { label: 'Check for Updates', click: () => this.toast('Update Check', 'Your installation is up to date.') }, { sep: true }, { label: 'About', click: () => this.winAbout() }]));
      on('#map-reset', 'click', () => this.map.resetZoom());
      on('#map-centre', 'click', e => { this.map.centreOnVehicle = !this.map.centreOnVehicle; e.currentTarget.classList.toggle('on', this.map.centreOnVehicle); this.map.updateCursor(); });
      on('#map-zin', 'click', () => this.map.map.zoomIn());
      on('#map-zout', 'click', () => this.map.map.zoomOut());
      on('#map-settings', 'click', e => this.menuMapSettings(e.currentTarget));
      on('#map-speedo', 'click', e => { this.settings.speedOverlay = !this.settings.speedOverlay; e.currentTarget.classList.toggle('on', this.settings.speedOverlay); this.renderHud(); });
      on('#video-toolbar .loadvid', 'click', () => { const inp = $('#video-input'); inp.value = ''; inp.click(); });
      on('#video-input', 'change', e => Array.from(e.target.files).forEach(f => this.attachVideo(f)));
      on('#video-toolbar .ideal', 'click', () => this.toast('Generate Ideal Lap', 'Generates an ideal-lap video for the current session by stitching the best sector segments (requires source video and ffmpeg; not available in the browser).'));
      on('#video-toolbar .export', 'click', () => this.exportCsv());
      on('#video-toolbar .full', 'click', () => this.toggleMaximize('video'));
      this.splitter($('#split-v'), 'x'); this.splitter($('#split-h'), 'y');
      window.addEventListener('keydown', e => {
        if (e.target.matches('input,textarea,select')) return;
        const k = e.key.toLowerCase();
        if (k === ' ' || k === 'enter') { e.preventDefault(); this.togglePlay(); }
        else if (k === 'backspace' || k === '0') this.stop();
        else if (k === 'l' || k === 'g' || k === 'v' || k === 't') { const m = { l: 'sessions', g: 'graph', v: 'video', t: 'map' }[k]; if (e.altKey) this.toggleMaximize(m); else { this.settings.panes[m] = !this.settings.panes[m]; this.renderRibbonState(); setTimeout(() => { this.chart.draw(); this.map.invalidate(); }, 0); } }
        else if (k === 'r') { this.settings.panes = { sessions: true, graph: true, video: true, map: true }; $$('.toolwin.maximized').forEach(w => w.classList.remove('maximized')); document.documentElement.style.setProperty('--col-split', '36%'); document.documentElement.style.setProperty('--row-split', '48%'); this.renderRibbonState(); setTimeout(() => { this.chart.draw(); this.map.invalidate(); }, 0); }
        else if (k === 'arrowleft') this.setCursorX(this.cursorX - (e.shiftKey ? 10 : 1) * (this.settings.graphMode === 'Distance' ? 5 : 1));
        else if (k === 'arrowright') this.setCursorX(this.cursorX + (e.shiftKey ? 10 : 1) * (this.settings.graphMode === 'Distance' ? 5 : 1));
        else if (k === 'escape') { this.closeMenus(); if (this.sfMode === 'sector') this.toast('Custom Sectors', `${this.trackSplits().length} splits saved for ${this.session.trackName}.`); this.sfMode = false; document.body.style.cursor = ''; this.renderMapCtx(); this.map.drawTraces(); const ov = $$('.overlay').pop(); if (ov) ov.remove(); }
        else if ((k === 'o' && (e.ctrlKey || e.metaKey)) || k === 'f3') { e.preventDefault(); this.pickFiles(); }
        else if (k === 'n' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.confirm('Close All Sessions', 'Clear all Session Data?', () => this.clearSessions()); }
        else if (k === '+' || k === '=') { this.playbackSpeed = Math.min(8, this.playbackSpeed * 2); this.renderRibbonState(); }
        else if (k === '-') { this.playbackSpeed = Math.max(.25, this.playbackSpeed / 2); this.renderRibbonState(); }
      });
      document.addEventListener('mousedown', e => { if (!e.target.closest('.menu') && !e.target.closest('[data-menu-anchor]')) this.closeMenus(); });
    },
    splitter(el, axis) {
      el.addEventListener('mousedown', e => {
        const dock = $('#dock').getBoundingClientRect(); const mv = ev => { if (axis === 'x') document.documentElement.style.setProperty('--col-split', Math.min(80, Math.max(15, (ev.clientX - dock.left) / dock.width * 100)) + '%'); else document.documentElement.style.setProperty('--row-split', Math.min(85, Math.max(15, (ev.clientY - dock.top) / dock.height * 100)) + '%'); this.chart.draw(); this.map.invalidate(); };
        const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); }; window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up); e.preventDefault();
      });
    },
    toggleMaximize(pane) { const el = $('#tw-' + pane); const was = el.classList.contains('maximized'); $$('.toolwin.maximized').forEach(w => w.classList.remove('maximized')); if (!was) el.classList.add('maximized'); setTimeout(() => { this.chart.draw(); this.map.invalidate(); }, 0); },
    clearSessions() { this.sessions = []; this.session = null; this.loadDemo(); },
    exportCsv() {
      const laps = this.selectedLaps(); if (!laps.length) return; const defs = this.channelDefs(); const keys = ['distance', 'elapsed', 'speed', 'latacc', 'longacc', 'throttle', 'brake', 'rpm', 'steer'];
      let out = 'session,lap,' + keys.map(k => defs[k].label).join(',') + ',lat,lon\n';
      for (const l of laps) for (const s of l.samples) out += `${l.session.name},${l.number},` + keys.map(k => defs[k].get(s)).map(v => (+v).toFixed(3)).join(',') + `,${s.lat.toFixed(7)},${s.lon.toFixed(7)}\n`;
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out], { type: 'text/csv' })); a.download = `${this.session.name}_laps.csv`; a.click(); this.toast('Export CSV', 'Selected laps exported as CSV.');
    },

    // ---------- menus ----------
    closeMenus() { $$('.menu').forEach(m => m.remove()); },
    menu(anchor, items, cls = '') {
      this.closeMenus(); const m = document.createElement('div'); m.className = 'menu ' + cls;
      m.innerHTML = items.map(it => it.sep ? '<div class="msep"></div>' : it.head ? `<div class="mhead">${it.head}</div>` : `<div class="mi ${it.checked ? 'checked' : ''}">${it.icon ? `<img src="${it.icon}">` : ''}<span>${it.label}</span>${it.hint ? `<span class="hint">${it.hint}</span>` : ''}</div>`).join('');
      const mis = $$('.mi', m); let i = 0; items.forEach(it => { if (it.sep || it.head) return; const el = mis[i++]; el.onclick = () => { this.closeMenus(); it.click && it.click(); }; });
      document.body.appendChild(m); const r = anchor.getBoundingClientRect(); m.style.left = Math.min(r.left, window.innerWidth - m.offsetWidth - 8) + 'px'; m.style.top = (r.bottom + 2) + 'px'; return m;
    },
    menuFile(anchor) {
      this.closeMenus(); const m = document.createElement('div'); m.className = 'menu appmenu';
      const li = (icon, label, hint, fn) => `<div class="mi" data-fn="${fn}"><img src="${ICON(icon)}"><span>${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
      const recent = JSON.parse(localStorage.getItem('ct3.recent') || '[]');
      m.innerHTML = `<div style="display:grid;grid-template-columns:260px 1fr;width:600px"><div class="left">
        ${li('folder_open', 'Load VBO File', 'Ctrl+O', 'open')}${li('file_transfer', 'Load Session Folder (VBO + MP4)', '', 'folder')}${li('splits', 'Load Sectors', '', 'splits')}${li('circuit-overlay', 'Load Circuit Overlay', '', 'overlay')}${li('clear', 'Clear', 'Ctrl+N', 'clear')}${li('file_transfer', 'Transfer Files', '', 'transfer')}
        <div class="msep"></div>${li('export-video', 'Export Video and VBO', '', 'exportvideo')}${li('export-reference', 'Export Reference Lap', '', 'exportref')}${li('rename-session', 'Rename Current Session', '', 'rename')}
        <div class="msep"></div>${li('update', 'Check for Updates', '', 'update')}${li('release-notes', 'Release Notes', '', 'notes')}</div>
        <div class="right"><div class="mhead">Recent Files</div>${recent.length ? recent.map(f => `<div class="mi" data-recent="${f}"><span>${f}</span></div>`).join('') : '<div class="mi" style="color:var(--fg-2)">No files loaded yet</div>'}<div class="mhead">Sample files on this Mac</div>${['samples/zandvoort_porsche_513.vbo', 'samples/hungaroring_991_2.vbo', 'samples/cota_fp1.vbo'].map(f => `<div class="mi" data-url="${f}"><img src="${ICON('folder_open', 'small')}"><span>${f.split('/').pop()}</span></div>`).join('')}</div>
        <div class="footer"><button class="btn" data-fn="about"><img src="${ICON('info')}">About</button><button class="btn" data-fn="exit"><img src="${ICON('close')}">Exit</button></div></div>`;
      document.body.appendChild(m); const r = anchor.getBoundingClientRect(); m.style.left = r.left + 'px'; m.style.top = (r.bottom + 2) + 'px';
      const act = {
        open: () => this.pickFiles(), folder: () => this.openFolder(), splits: () => this.toast('Load Sectors', 'Load sector splits from an existing SPL file (not implemented in the web version).'), overlay: () => this.toast('Load Circuit Overlay', 'Circuit Overlay Files (*.CIR) draw a second circuit outline on the map (not implemented in the web version).'),
        clear: () => this.confirm('Close All Sessions', 'Clear all Session Data?', () => this.clearSessions()), transfer: () => this.winOpen(), exportvideo: () => this.exportCsv(),
        exportref: () => this.toast('Export Reference Lap', `Lap ${this.refLap().number} would be exported as a .ref file for a VBOX Lap Timer.`), rename: () => this.prompt('Rename Session', 'Enter new name for session', this.session.name, v => { if (v) { this.session.name = v; this.renderAll(); } }),
        update: () => this.toast('Update Check', 'Your installation is up to date.'), notes: () => window.open('https://racelogic.support/01VBOX_Motorsport/Circuit_Tools_3/CircuitTools_V3_Updates', '_blank'), about: () => this.winAbout(), exit: () => this.toast('Exit', 'This would close Circuit Tools 3.')
      };
      $$('[data-fn]', m).forEach(el => el.onclick = () => { this.closeMenus(); act[el.dataset.fn](); });
      $$('[data-url]', m).forEach(el => el.onclick = () => { this.closeMenus(); this.loadUrl(el.dataset.url); });
      $$('[data-recent]', m).forEach(el => el.onclick = () => { this.closeMenus(); const s = this.sessions.find(x => x.fileName === el.dataset.recent); if (s) { this.session = s; this.renderAll(); } else this.alert('File not found', `"${el.dataset.recent}" is not loaded any more. Browsers cannot reopen files without you picking them again — use Load VBO File.`); });
    },
    menuView(anchor) {
      const p = this.settings.panes; const tog = k => () => { p[k] = !p[k]; this.renderRibbonState(); setTimeout(() => { this.chart.draw(); this.map.invalidate(); }, 0); };
      this.menu(anchor, [
        { label: 'Laps', hint: '[L] or [Alt+L]', checked: p.sessions, icon: ICON('sessions'), click: tog('sessions') }, { label: 'Graph', hint: '[G] or [Alt+G]', checked: p.graph, icon: ICON('graph'), click: tog('graph') },
        { label: 'Video', hint: '[V] or [Alt+V]', checked: p.video, icon: ICON('expand'), click: tog('video') }, { label: 'Map', hint: '[T] or [Alt+T]', checked: p.map, icon: ICON('circuit-overlay'), click: tog('map') },
        { sep: true }, { label: 'Reset to Default', hint: '[R]', click: () => { this.settings.panes = { sessions: true, graph: true, video: true, map: true }; $$('.toolwin.maximized').forEach(w => w.classList.remove('maximized')); this.renderRibbonState(); setTimeout(() => { this.chart.draw(); this.map.invalidate(); }, 0); } }]);
    },
    menuChannels(anchor) {
      this.closeMenus(); const m = document.createElement('div'); m.className = 'menu channels'; const defs = this.channelDefs();
      const groups = {}; Object.entries(defs).forEach(([k, d]) => (groups[d.group] = groups[d.group] || []).push([k, d]));
      const order = ['Standard Channels', 'Named Channels', 'CAN Channels', 'Calculated Channels', 'Maths Channels'].filter(g => groups[g]);
      m.innerHTML = `<input class="search" placeholder="Type to search"><div class="tree">${order.map(g => `<div class="sec">${g} <span style="color:var(--fg-2);font-weight:400">(${groups[g].length})</span></div>` + groups[g].map(([k, d]) => `<div class="mi"><label><input type="checkbox" data-k="${k}" ${this.selectedChannels.includes(k) ? 'checked' : ''}>${d.label}${d.unit ? ` <span style="color:var(--fg-2)">${d.unit}</span>` : ''}</label></div>`).join('')).join('')}</div>`;
      document.body.appendChild(m); const r = anchor.getBoundingClientRect(); m.style.left = r.left + 'px'; m.style.top = (r.bottom + 2) + 'px';
      $$('input[type=checkbox]', m).forEach(cb => cb.onchange = () => { const k = cb.dataset.k; if (cb.checked) { if (!this.selectedChannels.includes(k)) this.selectedChannels.push(k); } else this.selectedChannels = this.selectedChannels.filter(x => x !== k); this.chart.draw(); });
      $('.search', m).oninput = e => { const q = e.target.value.toLowerCase(); $$('.mi', m).forEach(el => el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none'); };
      setTimeout(() => $('.search', m).focus(), 0);
    },
    menuTrack(anchor) {
      const s = this.session;
      if (s.isDemo) return this.menu(anchor, [{ label: 'Brands Hatch Indy', checked: true }, { label: 'Brands Hatch GP', click: () => this.toast('Track', 'Only Brands Hatch Indy is simulated; load a real .vbo to get the layouts near its GPS position.') }]);
      const items = s.candidates.slice(0, 12).map(c => ({ label: `${c.ci.name}  <span class="hint">${c.dTrace < 1000 ? c.dTrace.toFixed(0) + ' m' : (c.dTrace / 1000).toFixed(1) + ' km'} from line</span>`, checked: s.circuit === c.ci && !s.customGate, click: () => { s.customGate = null; this.resplit(s, { layout: c.ci.name }); } }));
      if (!items.length) items.push({ label: 'No circuit within 8 km in the Circuit Database' });
      this.menu(anchor, items);
    },
    menuTrackOptions(anchor) {
      const sm = this.settings.sectorMode; const s = this.session;
      this.menu(anchor, [
        { label: 'Set Start/Finish line', icon: ICON('finish', 'small'), click: () => { this.sfMode = true; document.body.style.cursor = 'crosshair'; this.renderMapCtx(); this.toast('Set Start/Finish line', 'Click on the driven line in the map where the lap should start. Esc cancels.'); } },
        { label: 'Set Separate Finish', icon: ICON('finish', 'small'), checked: !!s.finish, click: () => { if (s.isDemo) return this.alert('Set Separate Finish', 'Load a .vbo file first.'); this.sfMode = 'finish'; document.body.style.cursor = 'crosshair'; this.renderMapCtx(); this.toast('Set Separate Finish', 'Click on the driven line in the map where the run should end (point-to-point / hill climb). Esc cancels.'); } },
        { label: 'Clear Separate Finish', hint: s.finish ? '' : '(none set)', click: () => { if (s.isDemo || !s.finish) return; s.customFinish = null; s.ignoreFileFinish = true; this.resplit(s); } },
        { label: 'Reset Start/Finish', click: () => { if (s.isDemo) return; s.customGate = null; s.customFinish = null; this.resplit(s); } },
        { label: 'Flip longitude sign (GPS looks mirrored)', checked: s.lonSign === 1, click: () => { if (s.isDemo) return; s.lonSign = -s.lonSign; s.customGate = null; s.customFinish = null; this.resplit(s); } },
        { sep: true }, { head: 'Sectors' },
        ...[['Equal', 'Equal Distance', 'equal-length sectors'], ['MaxSpeed', 'Max Speed', 'split at the biggest speed peaks'], ['AccelDecel', 'Max Accel/Decel', 'split at speed peaks and apexes'], ['UserDefined', 'Custom Sectors', this.trackSplits().length ? this.trackSplits().length + ' saved splits' : s.corners.length ? 'one sector per corner (' + s.corners.length + ')' : 'place splits on the map']].map(([v, l, hint]) => ({ label: l, hint, checked: sm === v, click: () => { this.settings.sectorMode = v; this._sm = null; this.save(); this.allLaps().forEach(x => x._cache = null); this.renderAll(); } })),
        { label: 'Add Sector Split (click on map)', icon: ICON('add-blue', 'small'), hint: this.trackSplits().length ? `${this.trackSplits().length} saved for this track` : '', click: () => { if (!this.refLap()) return; this.sfMode = 'sector'; document.body.style.cursor = 'crosshair'; this.settings.sectorMode = 'UserDefined'; this.save(); this._sm = null; this.renderAll(); this.toast('Custom Sectors', 'Click on the driven line where each sector should end. Splits are saved for this track automatically. Esc when done.'); } },
        { label: 'Undo Last Split', hint: this.trackSplits().length ? '' : '(none)', click: () => { const p = this.trackSplits().slice(); if (!p.length) return; p.pop(); this.saveSplits(p); } },
        { label: 'Clear Saved Splits', hint: this.trackSplits().length ? '' : '(none)', click: () => { if (!this.trackSplits().length) return; if (confirm(`Remove the ${this.trackSplits().length} saved sector splits for ${this.session.trackName}?`)) this.saveSplits([]); } },
        { label: 'Number of Sectors…', hint: String(this.settings.sectors), click: () => { const v = prompt('Number of sectors (2–20):', this.settings.sectors); const n = parseInt(v, 10); if (n >= 2 && n <= 20) { this.settings.sectors = n; this._sm = null; this.save(); this.allLaps().forEach(x => x._cache = null); this.renderAll(); } } },
        { label: 'Sector Highlighting', checked: this.settings.showSectorsOnGraph, click: () => { this.settings.showSectorsOnGraph = !this.settings.showSectorsOnGraph; this.settings.showSectorsOnMap = this.settings.showSectorsOnGraph; this.renderAll(); } },
        { label: 'Clear Sectors', click: () => { this.settings.sectorMode = 'Equal'; this.settings.sectors = 4; this._sm = null; this.save(); this.allLaps().forEach(x => x._cache = null); this.renderAll(); } },
        { sep: true }, { head: 'Pitlane' },
        { label: "Mark 'Entrance'", icon: ICON('pitlane-entrance', 'small'), click: () => this.toast('Pitlane', 'Pit lane entrance marked at cursor (visual only).') }, { label: "Mark 'Exit'", icon: ICON('pitlane-exit', 'small'), click: () => this.toast('Pitlane', 'Pit lane exit marked at cursor (visual only).') }, { label: 'Clear Pit Lane', click: () => { } },
        { sep: true }, { head: 'Track map' },
        { label: 'Centre on Vehicle', icon: ICON('center_on_vehicle', 'medium'), checked: this.map.centreOnVehicle, click: () => { this.map.centreOnVehicle = !this.map.centreOnVehicle; $('#map-centre').classList.toggle('on', this.map.centreOnVehicle); } }, { label: 'Reset Zoom', icon: ICON('reset_zoom', 'medium'), click: () => this.map.resetZoom() }, { label: 'Speed Overlay', icon: ICON('speedo-light', 'medium'), checked: this.settings.speedOverlay, click: () => { this.settings.speedOverlay = !this.settings.speedOverlay; this.renderHud(); } }
      ]);
    },
    menuMapSettings(anchor) {
      this.menu(anchor, [{ head: 'Map Provider' }, ...['Bing', 'Google', 'None'].map(v => ({ label: v === 'None' ? 'None' : v + ' (satellite via Esri)', checked: this.settings.mapProvider === v, click: () => { this.settings.mapProvider = v; this.save(); this.map.setProvider(v); this.map.drawTraces(); } })),
      { sep: true }, { label: 'Sector Highlighting', checked: this.settings.showSectorsOnMap, click: () => { this.settings.showSectorsOnMap = !this.settings.showSectorsOnMap; this.map.drawTraces(); } },
      { sep: true }, { head: 'Show Corner Labels' }, ...['All', 'WithNotes', 'None'].map(v => ({ label: { All: 'All', WithNotes: 'With Notes', None: 'None' }[v], checked: this.settings.cornerLabels === v, click: () => { this.settings.cornerLabels = v; this.save(); this.map.drawCorners(); } }))]);
    },

    // ---------- windows ----------
    win(title, bodyHtml, { cls = '', footer = '', onOpen } = {}) {
      const ov = document.createElement('div'); ov.className = 'overlay';
      ov.innerHTML = `<div class="win ${cls}"><div class="wtitle"><span>${title}</span><span class="wclose">✕</span></div><div class="wbody">${bodyHtml}</div>${footer ? `<div class="wfooter">${footer}</div>` : ''}</div>`;
      document.body.appendChild(ov); const close = () => ov.remove();
      $('.wclose', ov).onclick = close; ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
      $$('[data-close]', ov).forEach(b => b.onclick = close);
      onOpen && onOpen(ov, close); return ov;
    },
    confirm(title, text, ok) { this.win(title, `<div style="padding:18px 22px;min-width:340px">${text}</div>`, { footer: `<button class="btn primary" data-ok>Yes</button><button class="btn" data-close>No</button>`, onOpen: (ov, close) => $('[data-ok]', ov).onclick = () => { close(); ok(); } }); },
    alert(title, text) { this.win(title, `<div style="padding:18px 22px;min-width:340px;max-width:520px">${text}</div>`, { footer: `<button class="btn primary" data-close>OK</button>` }); },
    prompt(title, text, val, ok) { this.win(title, `<div style="padding:18px 22px;min-width:360px">${text}<br><input type="text" value="${val}" style="width:100%;margin-top:8px;border:1px solid var(--app-border);background:var(--app-bg);color:var(--fg);padding:4px 6px"></div>`, { footer: `<button class="btn primary" data-ok>OK</button><button class="btn" data-close>Cancel</button>`, onOpen: (ov, close) => { const i = $('input', ov); i.focus(); $('[data-ok]', ov).onclick = () => { close(); ok(i.value); }; } }); },
    toast(title, text) { $$('.toast').forEach(t => t.remove()); const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = `<b>${title}</b>${text}`; document.body.appendChild(t); setTimeout(() => t.remove(), 9000); },

    winSettings() {
      const s = this.settings; const sections = ['General', 'Laps and Sectors', 'Video', 'Graph', 'Track Map', 'Insights', 'Coach AI', 'Channel Mapping'];
      const radios = (name, opts, cur) => `<div class="radio-row">${opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}" ${cur === v ? 'checked' : ''}>${l}</label>`).join('')}</div>`;
      const chk = (key, label) => `<div class="field"><label><input type="checkbox" data-key="${key}" ${s[key] ? 'checked' : ''}> ${label}</label></div>`;
      const ses = this.session;
      const pages = {
        'General': `<div class="field"><label class="h">Language</label><select data-key="language">${['English', 'Deutsch', 'Español', 'Français', 'Italiano', 'Português', '日本語', '中文'].map(l => `<option ${s.language === l ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label class="h">Font Size</label><span>Small</span><input type="range" min="10" max="18" step="2" data-key="fontSize" value="${s.fontSize}"><span>XXL</span></div>
          <div class="field"><label class="h">Theme</label>${radios('theme', [['Light', 'Light'], ['Dark', 'Dark']], s.theme)}</div><div class="hr"></div>
          <div class="field"><label class="h">Speed</label>${radios('speedUnit', [['kmh', 'km/h'], ['mph', 'mph']], s.speedUnit)}</div>
          <div class="field"><label class="h">Distance</label>${radios('distanceUnit', [['metres', 'metres'], ['feet', 'feet']], s.distanceUnit)}</div>
          <div class="field"><label class="h">Acceleration</label>${radios('accelUnit', [['g', 'g'], ['ms2', 'm/s²'], ['fts2', 'ft/s²']], s.accelUnit)}</div>
          <div class="field"><label class="h">Decimal Places</label><input type="number" min="0" max="4" data-key="decimalPlaces" value="${s.decimalPlaces}" style="min-width:60px;width:60px"></div>`,
        'Laps and Sectors': `<div class="field"><label class="h">Sector Time Format</label>${radios('sectorTimeFormat', [['SectorToSector', 'Sector to Sector'], ['StartToSector', 'Start to Sector']], s.sectorTimeFormat)}</div>
          ${chk('showVmax', 'Display VMax Column')}${chk('showShortLaps', 'Show Short Laps')}${chk('showUnfinishedLaps', 'Show Unfinished Laps (out / in lap)')}
          <div class="field"><label class="h">Equal Sectors per Lap</label><input type="number" min="1" max="20" data-key="sectors" value="${s.sectors}" style="min-width:60px;width:60px"></div>
          <div class="field"><label class="h">Gate Width</label><input type="number" min="1" max="100" data-key="gateWidth" value="${s.gateWidth}" style="min-width:60px;width:60px"> m</div>
          <div class="field"><label class="h">Sector Colour Palette</label><select data-key="sectorPalette">${[['AlternatingDark', 'Two Colour (Dark)'], ['AlternatingLight', 'Two Colour (Light)'], ['HighContrast', 'High Contrast'], ['Vibrant', 'Multi-Coloured']].map(([v, l]) => `<option value="${v}" ${s.sectorPalette === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          ${chk('autoColourLaps', 'Assign lap colours automatically')}`,
        'Video': `${chk('autoIdealLap', 'Auto-generate Ideal Laps')}<div class="field"><label class="h">Media Player</label>${radios('mediaPlayer', [['VLC', 'VLC'], ['FFME', 'FFME']], s.mediaPlayer)}</div>
          <div class="field"><label class="h">Video sync offset</label><input type="number" step="0.1" data-key="videoOffset" value="${s.videoOffset}" style="min-width:70px;width:70px"> s <span class="watermark">(added to avitime; use if video runs ahead/behind)</span></div><div class="hr"></div><h3 class="sec">Advanced Settings:</h3>${chk('videoRecovery', 'Automatic Media Player Recovery')}`,
        'Graph': `<div class="field"><label class="h">X-Axis</label>${radios('graphMode', [['Position', 'Position'], ['Distance', 'Distance'], ['Time', 'Time']], s.graphMode)}</div>
          <div class="field"><label class="h">Graph Line Style</label>${radios('graphLineStyle', [['Smooth', 'Smooth'], ['Sharp', 'Sharp']], s.graphLineStyle)}</div>
          <div class="field"><label class="h">Acceleration Smoothing</label><input type="range" min="0" max="100" data-key="accelSmoothing" value="${s.accelSmoothing}"><span>${s.accelSmoothing}</span></div>`,
        'Track Map': `<div class="field"><label class="h">Map Provider</label><select data-key="mapProvider">${['Bing', 'Google', 'None'].map(v => `<option ${s.mapProvider === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="field"><label class="h">Cursor Type</label><select data-key="cursorType">${[['Dot', 'Dot'], ['Cross', 'Cross'], ['Rectangle', 'Rectangle'], ['Car', 'Car'], ['Formula1', 'Formula'], ['None', 'None']].map(([v, l]) => `<option value="${v}" ${s.cursorType === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          ${chk('showSectorsOnMap', 'Show Sectors on Map')}${chk('alwaysShowTrackOutline', 'Always Show Track Outline')}${chk('showCorners', 'Show Corners')}`,
        'Insights': `${chk('useGraphSmoothing', 'Use Graph Smoothing')}<div class="watermark" style="margin:-4px 0 10px 22px;max-width:480px">When on, Insights uses the graph's Acceleration Smoothing setting for both the displayed acceleration values and corner / brake-event detection, so Insights matches the graph.</div>${chk('showCornerMarkers', 'Show Corner Markers')}`,
        'Coach AI': `<div class="field"><label class="h">Anthropic API Key</label><input type="password" data-key="anthropicKey" value="${s.anthropicKey}" style="width:280px"></div><div class="watermark" style="max-width:480px">API key used by the Insights view's 'Suggest note' button. Get one from https://console.anthropic.com. Leave blank to disable the feature.</div>`,
        'Channel Mapping': ses && !ses.isDemo ? `<div class="watermark" style="margin-bottom:8px">Which CAN channel of <b>${ses.name}</b> feeds each named channel. Changing a mapping re-splits nothing; it only changes the graph/insights source.</div>` + ['throttle', 'brake', 'rpm', 'steer', 'latacc', 'longacc', 'yaw', 'gear'].map(k => `<div class="field"><label class="h">${{ throttle: 'Throttle Position', brake: 'Brake Pressure', rpm: 'RPM', steer: 'Steering Angle', latacc: 'Lateral acceleration', longacc: 'Longitudinal acceleration', yaw: 'Yaw rate', gear: 'Gear' }[k]}</label><select data-map="${k}"><option value="">(none)</option>${ses.fileCols.map(c => `<option ${ses.channelMap[k] === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>`).join('') : '<div class="watermark">Load a .vbo file to map its channels.</div>'
      };
      let cur = 'General';
      const render = (ov) => {
        $('.page', ov).innerHTML = pages[cur]; $$('.nav div', ov).forEach(d => d.classList.toggle('sel', d.textContent === cur));
        $$('[data-key]', ov).forEach(el => el.onchange = () => { const k = el.dataset.key; s[k] = el.type === 'checkbox' ? el.checked : (el.type === 'number' || el.type === 'range') ? +el.value : el.value; if (k === 'accelSmoothing') el.nextElementSibling.textContent = el.value; this.afterSetting(k); });
        $$('input[type=radio]', ov).forEach(el => el.onchange = () => { s[el.name] = el.value; this.afterSetting(el.name); });
        $$('[data-map]', ov).forEach(el => el.onchange = () => { ses.channelMap[el.dataset.map] = el.value || undefined; this.buildLaps(ses, ses.gateObj ? CTVbo.crossings(ses.dec, ses.gateObj, ses.P) : []); const c = ses.laps.filter(l => l.kind === 'lap').sort((a, b) => a.time - b.time); if (!this.allLaps().some(l => l.isRef)) { if (c[0]) { c[0].isRef = true; c[0].selected = true; } } if (!this.selectedLaps().length && c[0]) c[0].selected = true; this.assignColours(); this.allLaps().forEach(l => l._cache = null); this.renderAll(); });
      };
      this.win('Settings', `<div class="settings"><div class="nav">${sections.map(n => `<div>${n}</div>`).join('')}</div><div class="page"></div></div>`, { footer: `<button class="btn" data-close>Close</button>`, onOpen: ov => { $$('.nav div', ov).forEach(d => d.onclick = () => { cur = d.textContent; render(ov); }); render(ov); } });
    },
    afterSetting(k) {
      this.save();
      if (k === 'theme' || k === 'fontSize') { this.applyTheme(); setTimeout(() => this.renderAll(), 0); }
      if (['speedUnit', 'decimalPlaces', 'sectors', 'sectorTimeFormat', 'showVmax', 'graphMode', 'showShortLaps', 'showUnfinishedLaps', 'videoOffset'].includes(k)) { this._sm = null; this.allLaps().forEach(l => l._cache = null); if (k === 'graphMode') this.cursorX = 0; this.renderAll(); }
      if (k === 'gateWidth') { this.sessions.filter(s => !s.isDemo).forEach(s => this.resplit(s)); }
      if (k === 'mapProvider') { this.map.setProvider(this.settings.mapProvider); this.map.drawTraces(); }
      if (['cursorType', 'showSectorsOnMap', 'alwaysShowTrackOutline', 'showCorners'].includes(k)) { this.map.drawTraces(); this.map.updateCursor(); }
    },

    winMaths() {
      const lib = CTMaths.LIBRARY; const mine = this.maths.mine;
      const sampleNames = Object.keys(CTMaths.SAMPLE_VARS).filter(k => !['velocity', 'steering', 'lat_g', 'lateral', 'long_g', 'longitudinal', 'dist', 'elapsed', 'combined'].includes(k));
      const fileCols = [...new Set(this.sessions.flatMap(s => s.fileCols || []))];
      const chanList = (q) => [...sampleNames, 'height', 'sats', ...fileCols, ...lib.map(l => l.name), ...mine.map(m => m.name)].filter(n => !q || n.toLowerCase().includes(q));
      this.win('Channels Setup - Maths Channels', `<div class="maths"><div class="lib"><input class="search" placeholder="Type to search" style="margin:6px 8px"><div class="tree"><div class="sec">Standard Maths Library</div>${lib.map((l, i) => `<div class="item" data-i="${i}">${l.name}</div>`).join('')}<div class="sec">My Maths Channels</div><div id="m-mine">${mine.map((l, i) => `<div class="item" data-m="${i}">${l.name}</div>`).join('') || '<div class="watermark" style="padding:2px 22px">None yet</div>'}</div></div><div style="padding:6px"><button class="btn" id="m-add"><img src="${ICON('add-blue', 'small')}">Add New</button></div></div>
        <div class="ed"><div class="watermark" id="m-info">Select an existing Maths Channel or click Add New to create one</div><input type="text" id="m-name" placeholder="Enter name for this Maths Channel (Required)"><input type="text" id="m-desc" placeholder="Enter description here (optional)"><textarea id="m-expr" rows="3" placeholder="Expression, e.g.  if(brake > 5 and throttle > 10, 1, 0)   or   smooth(d/dt(speed), 10)" spellcheck="false"></textarea>
        <div class="mstatus" id="m-status"></div>
        <div class="keys">${['+', '-', '*', '/', '(', ')', '^', 'sqrt', 'abs', 'sin', 'cos', 'tan', 'min', 'max', 'avg', 'd/dt', '∫', 'if', '<', '>', '=', 'and', 'or', 'not', 'smooth', 'prev'].map(k => `<span data-k="${k}">${k}</span>`).join('')}</div>
        <div class="field" style="align-items:flex-start"><label class="h" style="padding-top:4px">Channels</label><div class="mchans" id="m-chans"></div></div>
        <div class="field"><label class="h">Units</label><input type="text" id="m-units" placeholder="Enter units here (optional)" style="width:120px"></div><div class="field" id="m-params"></div><div class="field"><label><input type="checkbox" id="m-show" checked> Show on Graph</label><button class="btn" style="margin-left:auto" id="m-del">Delete this Maths Channel</button></div></div></div>`,
        { footer: `<button class="btn primary" id="m-ok">OK</button><button class="btn" data-close>Cancel</button><button class="btn" id="m-apply">Apply</button>`, onOpen: ov => {
          let cur = null; // { kind:'lib'|'mine'|'new', idx }
          const F = id => $('#' + id, ov);
          const renderChans = (q = '') => { F('m-chans').innerHTML = chanList(q).slice(0, 60).map(n => `<span title="insert">${n}</span>`).join('') + (chanList(q).length > 60 ? '<span class="watermark">…</span>' : ''); $$('span[title]', F('m-chans')).forEach(el => el.onclick = () => insert(/[^A-Za-z0-9_]/.test(el.textContent) ? `[${el.textContent}]` : el.textContent)); };
          const insert = (txt) => { const ta = F('m-expr'); if (ta.disabled) return; const a = ta.selectionStart, b = ta.selectionEnd; const t = txt === 'd/dt' || txt === '∫' || /^[a-z]+$/.test(txt) && !['and', 'or', 'not'].includes(txt) ? txt + '(' : (['and', 'or', 'not'].includes(txt) ? ` ${txt} ` : ` ${txt} `); ta.value = ta.value.slice(0, a) + t + ta.value.slice(b); ta.selectionStart = ta.selectionEnd = a + t.length; ta.focus(); validate(); };
          const paramsHtml = (m) => { const keys = Object.keys(m.params || {}); if (!keys.length) return ''; const saved = this.maths.params[m.id] || {}; return `<label class="h">Parameters</label><div class="mparams">${keys.map(k => `<label>${k.replace(/([a-z])([A-Z])/g, '$1 $2')} <input type="number" step="any" data-p="${k}" value="${saved[k] !== undefined ? saved[k] : m.params[k]}"></label>`).join('')}</div>`; };
          const preview = (expr, params) => { // evaluate on the reference lap to show the value range
            const ref = this.refLap(); if (!ref) return ''; try { const vals = this.evalMaths(ref, { expr, params }); let lo = Infinity, hi = -Infinity, nan = 0; for (const v of vals) { if (isNaN(v)) { nan++; continue; } if (v < lo) lo = v; if (v > hi) hi = v; } if (!isFinite(lo)) return 'No numeric values on the reference lap (check channel names / parameters).'; return `Reference lap ${this.lapName(ref)}: min ${lo.toFixed(2)}, max ${hi.toFixed(2)}${nan ? `, ${nan} undefined samples` : ''}`; } catch (e) { return e.message; } };
          const curParams = () => { const p = {}; $$('[data-p]', F('m-params')).forEach(i => p[i.dataset.p] = parseFloat(i.value)); return p; };
          const validate = () => {
            const st = F('m-status'); const expr = F('m-expr').value.trim();
            if (cur && cur.kind === 'lib') { const m = lib[cur.idx]; st.className = 'mstatus ok'; st.textContent = preview(m.expr, Object.assign({}, m.params || {}, curParams())); return true; }
            if (!expr) { st.className = 'mstatus'; st.textContent = ''; return false; }
            const r = this.checkMaths(expr); st.className = 'mstatus ' + (r.ok ? 'ok' : 'err'); st.textContent = r.ok ? '✓ ' + preview(expr, {}) : '✗ ' + r.error; return r.ok;
          };
          const select = (kind, idx) => {
            cur = { kind, idx }; $$('.item', ov).forEach(x => x.classList.remove('sel'));
            const el = kind === 'lib' ? $(`.item[data-i="${idx}"]`, ov) : kind === 'mine' ? $(`.item[data-m="${idx}"]`, ov) : null; if (el) el.classList.add('sel');
            const m = kind === 'lib' ? lib[idx] : kind === 'mine' ? mine[idx] : { name: '', desc: '', expr: '', units: '' };
            F('m-name').value = m.name; F('m-desc').value = m.desc || ''; F('m-expr').value = m.expr; F('m-units').value = m.units || '';
            F('m-name').disabled = F('m-desc').disabled = F('m-expr').disabled = F('m-units').disabled = kind === 'lib';
            F('m-info').textContent = kind === 'lib' ? m.desc : kind === 'mine' ? 'User-defined maths channel — edit the expression and click Apply.' : 'New maths channel — build an expression from channels and operators, then click Apply.';
            F('m-params').innerHTML = kind === 'lib' ? paramsHtml(m) : ''; $$('[data-p]', F('m-params')).forEach(i => i.oninput = validate);
            const key = kind === 'lib' ? m.id : kind === 'mine' ? 'u:' + m.id : null; F('m-show').checked = key ? this.selectedChannels.includes(key) : true;
            F('m-del').style.visibility = kind === 'mine' ? 'visible' : 'hidden';
            validate();
          };
          const apply = () => {
            if (!cur) return this.toast('Maths Channels', 'Select a channel or click Add New first.');
            if (cur.kind === 'lib') {
              const m = lib[cur.idx]; if (Object.keys(m.params || {}).length) this.maths.params[m.id] = curParams();
              this.saveMaths(); this.toggleChannel(m.id, F('m-show').checked); this.renderAll(); this.toast('Maths Channels', `${m.name} applied.`); return true;
            }
            const name = F('m-name').value.trim(), expr = F('m-expr').value.trim();
            if (!name) { this.toast('Maths Channels', 'A name is required.'); return false; }
            if (!validate()) { this.toast('Maths Channels', 'Fix the expression first: ' + F('m-status').textContent.replace(/^✗ /, '')); return false; }
            if ([...lib.map(l => l.name), ...mine.filter((x, i) => !(cur.kind === 'mine' && i === cur.idx)).map(x => x.name)].some(n => n.toLowerCase() === name.toLowerCase())) { this.toast('Maths Channels', `A channel called "${name}" already exists.`); return false; }
            let m; if (cur.kind === 'mine') { m = mine[cur.idx]; } else { m = { id: 'c' + Date.now().toString(36) }; mine.push(m); cur = { kind: 'mine', idx: mine.length - 1 }; }
            Object.assign(m, { name, desc: F('m-desc').value.trim(), expr, units: F('m-units').value.trim() });
            this.saveMaths(); this.toggleChannel('u:' + m.id, F('m-show').checked);
            F('m-mine').innerHTML = mine.map((l, i) => `<div class="item" data-m="${i}">${l.name}</div>`).join(''); bindMine(); select('mine', cur.idx);
            this.renderAll(); this.toast('Maths Channels', `"${name}" saved${F('m-show').checked ? ' and shown on the graph' : ''}.`); return true;
          };
          const bindMine = () => $$('.item[data-m]', ov).forEach(el => el.onclick = () => select('mine', +el.dataset.m));
          $$('.item[data-i]', ov).forEach(el => el.onclick = () => select('lib', +el.dataset.i)); bindMine();
          F('m-add').onclick = () => select('new', -1);
          F('m-apply').onclick = apply;
          F('m-ok').onclick = () => { if (!cur || cur.kind === 'lib' || apply()) ov.remove(); };
          F('m-del').onclick = () => { if (!cur || cur.kind !== 'mine') return; const m = mine[cur.idx]; if (!confirm(`Delete maths channel "${m.name}"?`)) return; mine.splice(cur.idx, 1); this.selectedChannels = this.selectedChannels.filter(k => k !== 'u:' + m.id); this.saveMaths(); F('m-mine').innerHTML = mine.map((l, i) => `<div class="item" data-m="${i}">${l.name}</div>`).join('') || '<div class="watermark" style="padding:2px 22px">None yet</div>'; bindMine(); cur = null; select('new', -1); this.renderAll(); };
          F('m-expr').oninput = validate; F('m-show').onchange = () => { if (cur && cur.kind === 'lib') { this.toggleChannel(lib[cur.idx].id, F('m-show').checked); this.chart.draw(); } else if (cur && cur.kind === 'mine') { this.toggleChannel('u:' + mine[cur.idx].id, F('m-show').checked); this.chart.draw(); } };
          $$('.keys span', ov).forEach(k => k.onclick = () => insert(k.dataset.k));
          $('.search', ov).oninput = e => { const q = e.target.value.toLowerCase(); $$('.item', ov).forEach(el => el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none'); renderChans(q); };
          renderChans();
          const pre = this.selectedChannels.find(k => k.startsWith('u:')) || this.selectedChannels.find(k => k.startsWith('m_'));
          if (pre && pre.startsWith('u:')) { const i = mine.findIndex(m => 'u:' + m.id === pre); if (i >= 0) select('mine', i); } else if (pre) { const i = lib.findIndex(m => m.id === pre); if (i >= 0) select('lib', i); }
        } });
    },

    winReports() {
      const st = { source: 'Laps', channel: 'time', horizontal: false, sort: 'Ascending' };
      const chans = [['time', 'Lap time (s)'], ['vmax', 'VMax'], ['speed', 'Avg speed'], ['brake', 'Max braking g'], ['lat', 'Max lateral g'], ['thr', 'Full-throttle %']];
      this.win('Reports', `<div class="reports"><div class="side"><input class="search" placeholder="Type to search"><div class="grp"><h4>Select Source(s)</h4><label><input type="radio" name="src" value="Laps" checked>Lap(s)</label><label><input type="radio" name="src" value="Sectors">Sector(s)</label></div>
        <div class="grp"><h4>Channel</h4>${chans.map(([v, l]) => `<label><input type="radio" name="ch" value="${v}" ${v === st.channel ? 'checked' : ''}>${l}</label>`).join('')}</div>
        <div class="grp"><h4>Chart Orientation</h4><div class="seg"><span class="on" data-o="v"><img src="${ICON('charts-vertical')}" style="width:16px;vertical-align:-3px"> Vertical</span><span data-o="h"><img src="${ICON('charts-horizontal')}" style="width:16px;vertical-align:-3px"> Horizontal</span></div></div>
        <div class="grp"><h4>Sort Order</h4><div class="seg"><span class="on" data-s="Ascending">Sort ascending</span><span data-s="Descending">Sort descending</span></div></div>
        <div class="grp"><h4>Number of Ranges</h4><input type="number" min="1" max="10" value="4" style="width:60px;border:1px solid var(--app-border);background:var(--app-bg);color:var(--fg)"> <span class="watermark">(Auto)</span></div></div>
        <div class="chart"><canvas id="r-canvas"></canvas></div></div>`, { footer: `<button class="btn"><img src="${ICON('reports-move-legend', 'medium')}">Move Legend</button><button class="btn"><img src="${ICON('save_settings')}">Save PDF</button><button class="btn" data-close>Close</button>`, onOpen: ov => {
          const draw = () => {
            const laps = this.session.laps.filter(l => l.kind === 'lap'); const smod = this.sectorModel(); const ns = smod.n; const sectorTimes = (l) => CTData.sectorTimes(l, smod.fr);
            let cats, series;
            if (st.source === 'Sectors') { cats = Array.from({ length: ns }, (_, i) => 'S' + (i + 1)); const sel = this.selectedLaps().length ? this.selectedLaps() : [this.refLap()]; series = sel.map(l => ({ name: `${l.session.name} L${l.number}`, colour: l.colour || '#888', v: sectorTimes(l) })); }
            else {
              const val = l => st.channel === 'time' ? l.time : st.channel === 'vmax' ? this.unitSpeed(l.vmax) : st.channel === 'speed' ? this.unitSpeed(l.samples.reduce((a, s) => a + s.speed, 0) / l.samples.length) : st.channel === 'brake' ? -Math.min(...l.samples.map(s => s.longG)) : st.channel === 'lat' ? Math.max(...l.samples.map(s => Math.abs(s.latG))) : l.samples.filter(s => s.throttle > 95).length / l.samples.length * 100;
              const sorted = laps.slice().sort((a, b) => st.sort === 'Ascending' ? val(a) - val(b) : val(b) - val(a));
              cats = sorted.map(l => 'Lap ' + l.number); series = [{ name: chans.find(c => c[0] === st.channel)[1], colour: '#1F4FD8', v: sorted.map(val) }];
            }
            CTCharts.barChart($('#r-canvas', ov), cats, series, { horizontal: st.horizontal, legend: true });
          };
          $$('input[name=src]', ov).forEach(r => r.onchange = () => { st.source = r.value; draw(); });
          $$('input[name=ch]', ov).forEach(r => r.onchange = () => { st.channel = r.value; draw(); });
          $$('[data-o]', ov).forEach(s => s.onclick = () => { $$('[data-o]', ov).forEach(x => x.classList.remove('on')); s.classList.add('on'); st.horizontal = s.dataset.o === 'h'; draw(); });
          $$('[data-s]', ov).forEach(s => s.onclick = () => { $$('[data-s]', ov).forEach(x => x.classList.remove('on')); s.classList.add('on'); st.sort = s.dataset.s; draw(); });
          setTimeout(draw, 0);
        } });
    },

    winMeasure() {
      const laps = this.selectedLaps(); const defs = this.channelDefs(); const dp = this.settings.decimalPlaces;
      const d0 = Math.max(0, this.cursorDist() - 120), d1 = Math.min(this.refLap().lengthM, this.cursorDist() + 120);
      const keys = Object.keys(defs).filter(k => !k.startsWith('m_') && k !== 'delta' && k !== 'sector' && defs[k].get);
      const rows = keys.map(k => { const ch = defs[k];
        const cells = laps.map(l => { const vals = l.samples.filter(s => s.dist >= d0 && s.dist <= d1).map(s => ch.get(s)).filter(v => !isNaN(v)); if (!vals.length) return ['—', '—', '—', '—']; const mn = Math.min(...vals), mx = Math.max(...vals), av = vals.reduce((a, b) => a + b, 0) / vals.length; return [(vals[vals.length - 1] - vals[0]).toFixed(dp), mn.toFixed(dp), mx.toFixed(dp), av.toFixed(dp)]; });
        if (cells.every(c => c[0] === '—')) return ''; return `<tr><td>${ch.label}</td>${cells.map((c, i) => c.map(v => `<td style="color:${laps[i].colour}">${v}</td>`).join('')).join('')}</tr>`; }).join('');
      this.win('Measure', `<div class="measure"><div class="tb"><button class="btn" id="ms-copy"><img src="${ICON('copy')}">Copy</button><button class="btn" id="ms-csv"><img src="${ICON('save_settings')}">Export CSV</button><button class="btn"><img src="${ICON('divider')}">Expand Selection</button><span class="watermark" style="margin-left:auto;align-self:center">Region: ${Math.round(d0)} – ${Math.round(d1)} m around cursor</span></div>
        <div style="max-height:460px;overflow:auto"><table class="grid"><thead><tr><th rowspan="2">Channel</th>${laps.map(l => `<th colspan="4" style="color:${l.colour};text-align:center">${l.session.name.slice(0, 14)} L${l.number}</th>`).join('')}</tr><tr>${laps.map(() => '<th>Delta</th><th>Min</th><th>Max</th><th>Avg</th>').join('')}</tr></thead><tbody>${rows}</tbody></table></div></div>`, { footer: `<button class="btn" data-close>Close</button>`, onOpen: ov => { const tsv = () => $$('tr', ov).map(tr => Array.from(tr.children).map(td => td.textContent).join('\t')).join('\n'); $('#ms-copy', ov).onclick = () => navigator.clipboard.writeText(tsv()).then(() => this.toast('Copy', 'Table copied to clipboard.')); $('#ms-csv', ov).onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([tsv().replace(/\t/g, ',')], { type: 'text/csv' })); a.download = 'measure.csv'; a.click(); }; } });
    },

    cornerMetrics(lap, c) {
      const k = Math.cos(c.start[0] * Math.PI / 180);
      const near = (ll) => { let best = 0, bd = Infinity; lap.samples.forEach((s, i) => { const d = (s.lat - ll[0]) ** 2 + ((s.lon - ll[1]) * k) ** 2; if (d < bd) { bd = d; best = i; } }); return best; };
      let i0 = near(c.start), i1 = near(c.end); if (i1 < i0) [i0, i1] = [i1, i0];
      if (i1 - i0 < 3) i1 = Math.min(lap.samples.length - 1, i0 + 10);
      const mid = lap.samples.slice(i0, i1 + 1);
      let apex = i0; for (let i = i0; i <= i1; i++) if (lap.samples[i].speed < lap.samples[apex].speed) apex = i;
      const rate = lap.session.rateHz || 10;
      const pre = lap.samples.slice(Math.max(0, i0 - 6 * rate), apex + 1);
      const brakeG = pre.map(s => -s.longG).filter(g => g > 0.1); const peakB = brakeG.length ? Math.max(...brakeG) : 0, avgB = brakeG.length ? brakeG.reduce((a, b) => a + b, 0) / brakeG.length : 0;
      const combo = mid.map(s => Math.hypot(s.latG, s.longG)); const peakC = Math.max(...combo, 0);
      const turnIn = mid.slice(0, Math.max(3, Math.floor(mid.length * .3))).map(s => Math.hypot(s.latG, s.longG)); const avgTI = turnIn.reduce((a, b) => a + b, 0) / Math.max(1, turnIn.length);
      const minSpeed = Math.min(...mid.map(s => s.speed));
      return { i0, i1, pre, mid, peakB, avgB, brakePct: peakB ? Math.round(avgB / peakB * 100) : 0, peakC, tiPct: peakC ? Math.round(avgTI / peakC * 100) : 0, minSpeed, noBraking: brakeG.length < 3 };
    },
    winInsights() {
      const laps = this.selectedLaps(); if (!laps.length) return this.alert('No laps selected', 'Please select one or more laps to generate insights.');
      const lap = laps[0]; const ref = laps[1] || null; const corners = lap.session.corners; const dp = this.settings.decimalPlaces;
      if (!corners.length) return this.alert('Insights', `No named corners in the Circuit Database for "${lap.session.trackName}". Insights needs corner definitions.`);
      const render = (ov) => {
        const c = corners[this.insightsCorner]; const m = this.cornerMetrics(lap, c); const rm = ref ? this.cornerMetrics(ref, c) : null;
        const target = 0.9; const bGood = m.brakePct >= 85, tGood = m.tiPct >= 80;
        $('.wbody', ov).innerHTML = `<div class="insights"><div class="top"><img src="${ICON('insights', 'medium')}" style="width:20px"><span class="corner">${c.name.trim()}</span><span class="pill">Turn ${this.insightsCorner + 1}</span><span style="color:var(--fg-2)">Grip Target: <b>${(target * m.peakC || 1.1).toFixed(2)} g</b></span><button class="btn" id="i-cfg">Configure</button><span style="color:${lap.colour}">■ ${lap.session.name.slice(0, 16)} L${lap.number}</span>${ref ? `<span style="color:${ref.colour}">■ ${ref.session.name.slice(0, 16)} L${ref.number} (ref)</span>` : ''}<div class="nav"><button class="btn" id="i-prev">Previous</button><button class="btn" id="i-next">Next</button></div></div>
          <div class="cols">
            <div class="card"><h4>Braking grip used</h4>${m.noBraking ? `<div class="pct">—</div><div><b>No braking zone</b><br>No significant braking was detected before this corner. This is normal for corners that can be taken at speed without braking.</div>` : `<div class="pct ${bGood ? 'good' : 'bad'}">${m.brakePct}%</div><div>Your average brake force for this corner was ${m.avgB.toFixed(dp)}g. This compares with a peak of ${m.peakB.toFixed(dp)}g in this lap.${bGood ? '' : ` If the car is capable of braking at ${m.peakB.toFixed(dp)}g for this corner then you are only using ${m.brakePct}% of the available grip.`}</div>`}<canvas id="i-brake"></canvas><div class="tips">${m.noBraking ? '' : (bGood ? '<span>Brake consistently</span>' : '<span>Brake later and harder</span><span>Check trail braking</span>')}</div><div class="watermark">Peak braking was ${m.peakB.toFixed(dp)}g. Average braking was ${m.brakePct}% of peak.</div><div class="watermark">Note: maximum values are computed over a minimum of 0.3s</div></div>
            <div class="card"><h4>Turn-in grip used</h4><div class="pct ${tGood ? 'good' : 'bad'}">${m.tiPct}%</div><div>The cornering force for this corner was ${m.peakC.toFixed(dp)}g. During the transition from braking to cornering, you maintained ${m.tiPct}% of the available grip.</div><canvas id="i-combo"></canvas><div class="tips">${tGood ? '<span>On target</span>' : '<span>Check trail braking</span><span>Check Speed</span>'}</div><div class="watermark">Min speed ${this.unitSpeed(m.minSpeed).toFixed(dp)} ${this.speedLabel()}${rm ? ` · ref ${this.unitSpeed(rm.minSpeed).toFixed(dp)}` : ''}</div></div>
            <div class="card"><div style="display:flex;gap:8px;align-items:center"><h4 style="flex:1">Combo G map</h4><label><input type="radio" name="imap" checked> Combo G map</label><label><input type="radio" name="imap"> G Ball trace</label></div><canvas id="i-map" style="height:220px"></canvas><div style="display:flex;justify-content:space-between"><span style="color:#D90000;font-weight:600">Min</span><span style="color:#00D900;font-weight:600">Max</span></div><label><input type="checkbox"> Invert colours</label><h4>Corner Notes</h4><textarea id="i-note" placeholder="Add notes about this corner here">${this.cornerNotes[c.name] || ''}</textarea><div style="display:flex;gap:6px"><button class="btn" id="i-ai" title="Ask Claude to suggest a note for this corner. Requires an Anthropic API key in Settings → Coach AI."><img src="${ICON('coachicon-light', 'medium')}">AI</button><button class="btn" id="i-save">Save note</button><button class="btn" id="i-report" style="margin-left:auto">Track Report</button></div></div>
          </div></div>`;
        const brakeY = m.pre.map(s => -s.longG), refBrakeY = rm ? rm.pre.map(s => -s.longG) : null;
        CTCharts.lineChart($('#i-brake', ov), [...(refBrakeY ? [{ y: refBrakeY, colour: ref.colour, alpha: .4 }] : []), { y: brakeY, colour: lap.colour }], { xlabel: 'Long Acc (g) — approach', target: m.peakB * .9, dp: 2 });
        CTCharts.lineChart($('#i-combo', ov), [...(rm ? [{ y: rm.mid.map(s => Math.hypot(s.latG, s.longG)), colour: ref.colour, alpha: .4 }] : []), { y: m.mid.map(s => Math.hypot(s.latG, s.longG)), colour: lap.colour }], { xlabel: 'Combined G (g) — through corner', target: m.peakC * .9, dp: 2 });
        const drawMap = (ball) => { const cv = $('#i-map', ov); if (ball) CTCharts.frictionCircle(cv, Object.assign(m.mid.map(s => [s.latG, s.longG]), { colour: lap.colour }), rm ? Object.assign(rm.mid.map(s => [s.latG, s.longG]), { colour: ref.colour }) : null, m.peakC * .9); else this.drawTrackSection(cv, lap, m, ref, rm); };
        drawMap(false); $$('input[name=imap]', ov).forEach((r, i) => r.onchange = () => drawMap(i === 1));
        $('#i-prev', ov).onclick = () => { this.insightsCorner = (this.insightsCorner - 1 + corners.length) % corners.length; render(ov); };
        $('#i-next', ov).onclick = () => { this.insightsCorner = (this.insightsCorner + 1) % corners.length; render(ov); };
        $('#i-save', ov).onclick = () => { this.cornerNotes[c.name] = $('#i-note', ov).value; this.map.drawCorners(); this.toast('Corner Notes', `Note saved for ${c.name.trim()}.`); };
        $('#i-ai', ov).onclick = () => this.suggestNote(c, m, $('#i-note', ov), lap);
        $('#i-cfg', ov).onclick = () => this.prompt('Braking Force Target', 'Set target braking g value for all corners', (m.peakB * .9).toFixed(2), () => render(ov));
        $('#i-report', ov).onclick = () => this.winTrackReport();
      };
      this.win('Insights', '', { onOpen: ov => render(ov), footer: `<button class="btn" data-close>Close</button>` });
    },
    drawTrackSection(cv, lap, m, ref, rm) {
      const ctx = cv.getContext('2d'); const dpr = window.devicePixelRatio || 1; const W = cv.clientWidth, H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-bg'); ctx.fillRect(0, 0, W, H);
      const pad = Math.round(4 * (lap.session.rateHz || 10));
      const seg = lap.samples.slice(Math.max(0, m.i0 - pad), Math.min(lap.samples.length, m.i1 + pad)); const lats = seg.map(s => s.lat), lons = seg.map(s => s.lon);
      const la0 = Math.min(...lats), la1 = Math.max(...lats), lo0 = Math.min(...lons), lo1 = Math.max(...lons); const k = Math.cos(la0 * Math.PI / 180);
      const sx = (W - 30) / Math.max((lo1 - lo0) * k, 1e-6), sy = (H - 30) / Math.max(la1 - la0, 1e-6), sc = Math.min(sx, sy);
      const X = s => 15 + (s.lon - lo0) * k * sc + ((W - 30) - (lo1 - lo0) * k * sc) / 2, Y = s => H - 15 - (s.lat - la0) * sc - ((H - 30) - (la1 - la0) * sc) / 2;
      const gmax = Math.max(...seg.map(s => Math.hypot(s.latG, s.longG)), 0.1);
      if (rm) { const rpad = Math.round(4 * (ref.session.rateHz || 10)); ctx.strokeStyle = ref.colour; ctx.globalAlpha = .4; ctx.lineWidth = 3; ctx.beginPath(); ref.samples.slice(Math.max(0, rm.i0 - rpad), rm.i1 + rpad).forEach((s, i) => i ? ctx.lineTo(X(s), Y(s)) : ctx.moveTo(X(s), Y(s))); ctx.stroke(); ctx.globalAlpha = 1; }
      for (let i = 1; i < seg.length; i++) { const g = Math.hypot(seg[i].latG, seg[i].longG) / gmax; ctx.strokeStyle = `hsl(${g * 120},90%,45%)`; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(X(seg[i - 1]), Y(seg[i - 1])); ctx.lineTo(X(seg[i]), Y(seg[i])); ctx.stroke(); }
      const e = lap.samples[m.i0], x = lap.samples[m.i1]; ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; for (const p of [e, x]) { ctx.beginPath(); ctx.arc(X(p), Y(p), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--fg'); ctx.font = '10px sans-serif'; ctx.fillText('Entry', X(e) + 6, Y(e) - 6); ctx.fillText('Exit', X(x) + 6, Y(x) - 6);
    },
    async suggestNote(c, m, ta, lap) {
      const key = this.settings.anthropicKey;
      if (!key) return this.alert('API Key Required', 'An Anthropic API key is required for the Suggest feature. Set it in Settings → Coach AI.');
      ta.value = 'Asking Claude…';
      try {
        const body = { model: 'claude-sonnet-5-5', max_tokens: 200, messages: [{ role: 'user', content: `You are a driver coach. In two sentences, suggest a note for corner "${c.name.trim()}" at ${lap.session.trackName}. Data: braking grip used ${m.brakePct}% (avg ${m.avgB.toFixed(2)}g of peak ${m.peakB.toFixed(2)}g), turn-in grip used ${m.tiPct}%, peak combined ${m.peakC.toFixed(2)}g, min speed ${this.unitSpeed(m.minSpeed).toFixed(1)} ${this.speedLabel()}.` }] };
        const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify(body) });
        const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.statusText);
        ta.value = j.content.map(x => x.text || '').join('');
      } catch (e) { ta.value = ''; this.alert('Coach', 'Coach note suggestion failed: ' + e.message); }
    },

    winTrackReport() {
      const ses = this.session; const laps = ses.laps.filter(l => l.kind === 'lap'); if (!laps.length) return this.alert('Track Report', 'No complete laps in this session.');
      const best = laps.reduce((a, b) => a.time < b.time ? a : b); const smod = this.sectorModel(); const ns = smod.n; const sectorTimes = (l) => CTData.sectorTimes(l, smod.fr); const dp = this.settings.decimalPlaces;
      const bestS = Array.from({ length: ns }, (_, i) => Math.min(...laps.map(l => sectorTimes(l)[i]))); const ideal = bestS.reduce((a, b) => a + b, 0);
      const top = Math.max(...laps.map(l => l.vmax)); const maxB = Math.max(...laps.flatMap(l => l.samples.map(s => -s.longG))); const maxL = Math.max(...laps.flatMap(l => l.samples.map(s => Math.abs(s.latG))));
      this.win('Track Report', `<div class="treport"><div class="head"><div><div class="t">Track Report</div><div style="opacity:.8">${ses.name} · ${ses.trackName}</div></div><img src="${ICON('vbms-white')}" style="height:28px"></div>
        <div class="meta"><div><span>Session</span>${ses.name}</div><div><span>Track</span>${ses.trackName}${ses.country ? ', ' + ses.country : ''}</div><div><span>Driver</span>—</div><div><span>Vehicle</span>—</div><div><span>Date</span>${ses.created || '—'}</div><div><span>Weather</span>—</div><div style="grid-column:span 2"><span>Notes</span>${ses.isDemo ? 'Synthetic demo session on the real Circuit Database centreline.' : (ses.vbo.comments.split('\n').find(l => /Type/.test(l)) || '').trim()}</div></div>
        <div class="tiles"><div class="tile"><div class="l">Best lap</div><div class="v">${fmtTime(best.time)}</div><div class="d">lap ${best.number} of ${laps.length}</div></div><div class="tile"><div class="l">Ideal lap</div><div class="v">${fmtTime(ideal)}</div><div class="d">${fmtDelta(ideal - best.time, dp)} s vs best</div></div><div class="tile"><div class="l">Top speed</div><div class="v">${this.unitSpeed(top).toFixed(1)}</div><div class="d">${this.speedLabel()}</div></div><div class="tile"><div class="l">Max Braking</div><div class="v">${maxB.toFixed(2)} g</div><div class="d">peak longitudinal</div></div><div class="tile"><div class="l">Max Lateral</div><div class="v">${maxL.toFixed(2)} g</div><div class="d">peak lateral</div></div></div>
        <div class="main"><div class="panel"><h4>Heat Map — <select id="tr-ch" style="font:inherit"><option value="speed">Speed</option><option value="combo">Combined acceleration</option><option value="throttle">Throttle</option><option value="brake">Brake</option></select> <label><input type="checkbox" id="tr-lbl" checked> Show Corner Labels</label></h4><canvas id="tr-map" style="width:100%;height:300px"></canvas><div style="display:flex;justify-content:space-between;font-size:11px"><span style="color:#D90000;font-weight:600">Min</span><span style="color:#00D900;font-weight:600">Max</span></div></div>
        <div class="panel"><h4>Laps</h4><table><thead><tr><th>Lap</th><th>Time</th><th>Delta</th><th>VMax</th>${Array.from({ length: ns }, (_, i) => `<th>S${i + 1}</th>`).join('')}</tr></thead><tbody>${laps.map(l => `<tr><td>${l.number}</td><td>${fmtTime(l.time)}</td><td>${fmtDelta(l.time - best.time, dp)}</td><td>${this.unitSpeed(l.vmax).toFixed(1)}</td>${sectorTimes(l).map(v => `<td>${v.toFixed(dp)}</td>`).join('')}</tr>`).join('')}</tbody></table><h4 style="margin-top:10px">Corner Notes</h4>${Object.keys(this.cornerNotes).length ? Object.entries(this.cornerNotes).map(([k, v]) => `<div><b>${k}</b>: ${v}</div>`).join('') : '<div style="color:#8089A0">No corner notes yet — add them in Insights.</div>'}</div></div></div>`,
        { footer: `<button class="btn" id="tr-share">Share</button><button class="btn" onclick="window.print()">Print</button><button class="btn" onclick="window.print()">Save PDF</button><button class="btn" data-close>Close</button>`, onOpen: ov => {
          ov.querySelector('.win').style.background = '#F4F6FA';
          $('#tr-share', ov).onclick = () => { const txt = `${ses.name} · ${ses.trackName}\nBest lap ${fmtTime(best.time)} (lap ${best.number}), ideal ${fmtTime(ideal)}, top speed ${this.unitSpeed(top).toFixed(1)} ${this.speedLabel()}\n` + laps.map(l => `L${l.number} ${fmtTime(l.time)}`).join('\n'); window.open('https://wa.me/?text=' + encodeURIComponent(txt), '_blank'); };
          const draw = () => {
            const cv = $('#tr-map', ov); const ctx = cv.getContext('2d'); const dpr = devicePixelRatio || 1; const W = cv.clientWidth, H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
            const S = best.samples; const lats = S.map(s => s.lat), lons = S.map(s => s.lon); const la0 = Math.min(...lats), la1 = Math.max(...lats), lo0 = Math.min(...lons), lo1 = Math.max(...lons); const k = Math.cos(la0 * Math.PI / 180);
            const sc = Math.min((W - 40) / ((lo1 - lo0) * k), (H - 40) / (la1 - la0)); const X = s => 20 + (s.lon - lo0) * k * sc + ((W - 40) - (lo1 - lo0) * k * sc) / 2, Y = s => H - 20 - (s.lat - la0) * sc - ((H - 40) - (la1 - la0) * sc) / 2;
            const ch = $('#tr-ch', ov).value; const val = s => ch === 'speed' ? s.speed : ch === 'combo' ? Math.hypot(s.latG, s.longG) : ch === 'brake' ? s.brake : s.throttle; const vs = S.map(val); const mn = Math.min(...vs), mx = Math.max(...vs);
            for (let i = 1; i < S.length; i++) { const g = (vs[i] - mn) / (mx - mn || 1); ctx.strokeStyle = `hsl(${g * 120},90%,42%)`; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(X(S[i - 1]), Y(S[i - 1])); ctx.lineTo(X(S[i]), Y(S[i])); ctx.stroke(); }
            if ($('#tr-lbl', ov).checked) { ctx.fillStyle = '#1F2A44'; ctx.font = 'bold 10px sans-serif'; ses.corners.forEach(c => { const p = { lat: (c.start[0] + c.end[0]) / 2, lon: (c.start[1] + c.end[1]) / 2 }; ctx.fillText(c.name.trim(), X(p) + 6, Y(p) - 4); }); }
          };
          draw(); $('#tr-ch', ov).onchange = draw; $('#tr-lbl', ov).onchange = draw;
        } });
    },

    winAbout() {
      this.win('About', `<div class="about"><div class="txt"><b>Circuit Tools</b>Version 3.2.120.1762<br>Circuit Database 2.115.291<br>Lib VLC 3.0.23.1<br><span style="color:#606060">© Racelogic Ltd.</span><br><br><span style="color:#606060;font-size:11px">Web replica built from the installer's own resources.</span></div><div class="wfooter"><button class="btn" data-close>Close</button></div></div>`);
    },

    winOpen() {
      let cur = localStorage.getItem('ct3.lastDir') || null; let roots = [];
      const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
      this.win('Open VBOX file', `<div class="opendlg"><div class="nav"><button class="btn" id="od-back" title="Navigate back">◀</button><button class="btn" id="od-up" title="Navigate up one directory"><img src="assets/icons/large/folder_open.png" style="margin:0"></button><div class="path" id="od-path">…</div><button class="btn primary" id="od-browse" title="Pick files with the system dialog (works without the local server)">Browse …</button><button class="btn" id="od-folder" title="Pick a whole folder (VBO + MP4)">Open Folder …</button></div>
        <div class="cols"><div class="tree" id="od-tree"><div class="root">This Mac</div><div class="watermark" style="padding-left:22px">connecting to serve.py …</div><div class="root" style="margin-top:8px">Loaded sessions</div>${this.sessions.map(x => `<div data-sess="${x.fileName}">${x.name}</div>`).join('') || '<div class="watermark" style="padding-left:22px">none</div>'}</div>
        <div class="files" id="od-files"><table class="grid"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th><th>Status</th></tr></thead><tbody id="od-rows"><tr><td colspan="5" class="watermark">…</td></tr></tbody></table></div>
        <div class="info"><h4>Video Preview</h4><div class="preview"><video src="${(this.session && this.session.videos && Object.values(this.session.videos)[0] && Object.values(this.session.videos)[0].url) || 'assets/video/no-video.mp4'}" muted autoplay loop style="width:100%;height:100%;object-fit:cover"></video></div><h4>Session Information</h4><div class="kv"><b>Circuit</b><span>${this.session ? this.session.trackName : ''}</span><b>Rate</b><span>${this.session ? this.session.rateHz + ' Hz' : ''}</span><b>Channels</b><span>${this.session ? (this.session.fileCols || []).length : 0} CAN</span><b>S/F</b><span>${this.session ? (this.session.gateSource || 'database') : ''}</span><b>Videos</b><span>${this.session && this.session.videos ? Object.keys(this.session.videos).length : 0} linked</span><b>Unit</b><span>${this.session && this.session.vbo ? (this.session.vbo.comments.match(/Type\s*:\s*(.+)/)?.[1] || '—') : 'demo'}</span></div>
        <h4>How loading works</h4><div class="watermark">Double-click a .vbo to open it. Its camera files (<i>prefix</i>0001.mp4 …) are picked up from the same folder automatically; otherwise the whole Mac is searched by name. Double-click an .mp4 to attach it to the current session by hand.</div></div></div>
        <div class="bottom"><label><input type="checkbox" checked> Only full laps</label><span>File name:</span><div class="fn" id="od-fn"></div><select style="border:1px solid var(--app-border);background:var(--app-bg);color:var(--fg)"><option>Racelogic VBO Files (*.VBO)</option><option>Video files (*.mp4)</option></select><button class="btn primary" id="od-open">Open</button><button class="btn" data-close>Cancel</button></div></div>`, { onOpen: (ov, close) => {
          const hist = []; let sel = null;
          const show = async (path, push = true) => {
            const ls = await this.api('/api/ls?path=' + encodeURIComponent(path));
            if (!ls || ls.error) { $('#od-rows', ov).innerHTML = `<tr><td colspan="5" class="watermark">${ls ? ls.error : 'The local server is not running (start it with: python3 serve.py). Use Browse … instead.'}</td></tr>`; return; }
            if (push && cur && cur !== path) hist.push(cur); cur = ls.path; localStorage.setItem('ct3.lastDir', cur); $('#od-path', ov).textContent = cur.replace(/^\/Users\/[^/]+/, '~');
            const loadedNames = new Set(this.sessions.map(x => x.fileName)); const vidNames = new Set(this.sessions.flatMap(x => Object.values(x.videos || {}).map(v => v.name)));
            $('#od-rows', ov).innerHTML = ls.dirs.map(d => `<tr data-dir="${d.path}"><td>📁 ${d.name}</td><td>Folder</td><td></td><td></td><td></td></tr>`).join('') + ls.files.map(f => `<tr data-file="${f.path}" data-kind="${/\.vbo$/i.test(f.name) ? 'vbo' : 'video'}"><td>${/\.vbo$/i.test(f.name) ? '📈' : '🎥'} ${f.name}</td><td>${f.name.split('.').pop().toUpperCase()}</td><td>${fmtSize(f.size)}</td><td>${f.mtime}</td><td style="color:var(--delta-faster)">${loadedNames.has(f.name) || vidNames.has(f.name) ? '✓ loaded' : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="watermark">No VBOX or video files here</td></tr>';
            $$('tr[data-dir]', ov).forEach(tr => { tr.ondblclick = () => show(tr.dataset.dir); tr.onclick = () => { $$('#od-rows tr', ov).forEach(r => r.classList.remove('sel')); tr.classList.add('sel'); sel = { dir: tr.dataset.dir }; $('#od-fn', ov).textContent = ''; }; });
            $$('tr[data-file]', ov).forEach(tr => { tr.onclick = () => { $$('#od-rows tr', ov).forEach(r => r.classList.remove('sel')); tr.classList.add('sel'); sel = { file: tr.dataset.file, kind: tr.dataset.kind }; $('#od-fn', ov).textContent = tr.dataset.file.split('/').pop(); }; tr.ondblclick = () => openSel(sel = { file: tr.dataset.file, kind: tr.dataset.kind }); });
            $('#od-up', ov).onclick = () => ls.parent && show(ls.parent);
          };
          const openSel = (x) => { if (!x) return; if (x.dir) return show(x.dir); close(); if (x.kind === 'vbo') this.loadServerFile(x.file); else { const t = this.session; if (!t || t.isDemo) return this.alert('Video', 'Load a .vbo first.'); const k = this.videoKey(x.file.split('/').pop()); this.attachRemoteVideo(t, k.idx, x.file, k.base + x.file.slice(x.file.lastIndexOf('.'))); this.renderVideo(); } };
          $('#od-open', ov).onclick = () => openSel(sel);
          $('#od-back', ov).onclick = () => { const p = hist.pop(); if (p) show(p, false); };
          $('#od-browse', ov).onclick = () => { close(); this.pickFiles(); };
          $('#od-folder', ov).onclick = () => { close(); this.openFolder(); };
          $$('[data-sess]', ov).forEach(el => el.onclick = () => { const x = this.sessions.find(y => y.fileName === el.dataset.sess); if (x) { this.session = x; this.renderAll(); this.map.fit(); close(); } });
          this.api('/api/roots').then(r => {
            const tree = $('#od-tree', ov); if (!r) { tree.querySelector('.watermark').textContent = 'serve.py not reachable — use Browse …'; return; }
            roots = r; const html = r.map(x => `<div data-root="${x.path}">${x.name}</div>`).join(''); tree.querySelector('.watermark').outerHTML = html;
            $$('[data-root]', ov).forEach(el => el.onclick = () => { $$('[data-root]', ov).forEach(e => e.classList.remove('sel')); el.classList.add('sel'); show(el.dataset.root); });
            show(cur || r[0].path, false);
          });
        } });
    }
  };

  // remember loaded file names
  const origLoad = app.loadVboText.bind(app);
  app.loadVboText = async function (text, name) { await origLoad(text, name); const r = JSON.parse(localStorage.getItem('ct3.recent') || '[]').filter(x => x !== name); r.unshift(name); localStorage.setItem('ct3.recent', JSON.stringify(r.slice(0, 8))); };

  window.app = app;
  window.addEventListener('DOMContentLoaded', () => app.init());
})();
