/* Synthetic session generator. Geometry is the real Racelogic Circuit Database
   centreline for Brands Hatch Indy; speeds/throttle are simulated from curvature. */
(function () {
  const R_EARTH = 6371000;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function toXY(lat, lon, lat0, lon0) {
    const x = (lon - lon0) * Math.PI / 180 * R_EARTH * Math.cos(lat0 * Math.PI / 180);
    const y = (lat - lat0) * Math.PI / 180 * R_EARTH;
    return [x, y];
  }
  function toLatLon(x, y, lat0, lon0) {
    return [lat0 + y / R_EARTH * 180 / Math.PI, lon0 + x / (R_EARTH * Math.cos(lat0 * Math.PI / 180)) * 180 / Math.PI];
  }

  function smooth(arr, w, wrap) {
    const n = arr.length, out = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = -w; k <= w; k++) {
        let j = i + k;
        if (wrap) j = (j + n) % n; else if (j < 0 || j >= n) continue;
        s += arr[j]; c++;
      }
      out[i] = s / c;
    }
    return out;
  }

  // Build a dense (1 m) closed path from the centreline, starting at the S/F line.
  function buildPath(track) {
    let pts = track.centreline;
    const lat0 = track.start_finish.lat, lon0 = track.start_finish.lon;
    let xy = pts.map(p => toXY(p[0], p[1], lat0, lon0));
    // CIR files may contain more than one loop (e.g. both track edges): keep the first closed loop
    for (let i = 150; i < xy.length; i++) {
      if (Math.hypot(xy[i][0] - xy[0][0], xy[i][1] - xy[0][1]) < 12) { xy = xy.slice(0, i); break; }
    }
    // rotate so the path starts at the point nearest start/finish (0,0)
    let best = 0, bd = 1e9;
    xy.forEach((p, i) => { const d = p[0] * p[0] + p[1] * p[1]; if (d < bd) { bd = d; best = i; } });
    xy = xy.slice(best).concat(xy.slice(0, best));
    // ensure clockwise-consistent direction: Brands Hatch runs clockwise; check signed area
    let area = 0;
    for (let i = 0; i < xy.length; i++) { const a = xy[i], b = xy[(i + 1) % xy.length]; area += a[0] * b[1] - b[0] * a[1]; }
    if (area > 0) xy.reverse();
    // resample at 1 m
    const dense = [];
    let carry = 0;
    for (let i = 0; i < xy.length; i++) {
      const a = xy[i], b = xy[(i + 1) % xy.length];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let s = carry;
      while (s < seg) { const t = s / seg; dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); s += 1; }
      carry = s - seg;
    }
    const n = dense.length;
    // curvature by 3-point circle over +-6 m
    const k = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = dense[(i - 6 + n) % n], b = dense[i], c = dense[(i + 6) % n];
      const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const r = (ab * bc * ca) / (2 * Math.abs(cross) + 1e-9);
      k[i] = (cross < 0 ? -1 : 1) / Math.max(r, 8);
    }
    const ks = smooth(k, 8, true);
    // heading for lateral offsets
    const heading = new Array(n);
    for (let i = 0; i < n; i++) { const a = dense[(i - 1 + n) % n], b = dense[(i + 1) % n]; heading[i] = Math.atan2(b[1] - a[1], b[0] - a[0]); }
    return { xy: dense, k: ks, heading, lat0, lon0, length: n };
  }

  // Speed profile (m/s) for a given driver "skill" parameter set
  function speedProfile(path, p, rng) {
    const n = path.length;
    const v = new Array(n);
    // per-lap, per-section grip variation so sector times differ lap to lap
    const knots = []; for (let i = 0; i < 10; i++) knots.push(1 + (rng() - 0.5) * 0.12);
    const grip = i => { const f = i / n * knots.length; const a = knots[Math.floor(f) % knots.length], b = knots[(Math.floor(f) + 1) % knots.length]; return a + (b - a) * (f - Math.floor(f)); };
    for (let i = 0; i < n; i++) v[i] = Math.min(p.vmax, Math.sqrt(p.aLat * grip(i) / Math.abs(path.k[i])));
    // backward pass braking limit, forward pass acceleration limit (iterate twice for closure)
    for (let it = 0; it < 2; it++) {
      for (let i = n - 1; i >= 0; i--) { const nx = v[(i + 1) % n]; v[i] = Math.min(v[i], Math.sqrt(nx * nx + 2 * p.aBrake)); }
      for (let i = 0; i < n; i++) { const pv = v[(i - 1 + n) % n]; const acc = p.aAcc * (1 - pv / (p.vmax * 1.15)); v[i] = Math.min(v[i], Math.sqrt(pv * pv + 2 * Math.max(acc, 0.3))); }
    }
    return v;
  }

  // Integrate along distance to 10 Hz samples
  function sampleLap(path, v, p, rng, lapIndex) {
    const n = path.length, dt = 0.1;
    const samples = [];
    let s = 0, t = 0;
    // lateral line variation per lap (smooth noise)
    const off = []; for (let i = 0; i < 24; i++) off.push((rng() - 0.5) * 2.4);
    while (s < n) {
      const i = Math.floor(s), f = s - i;
      const i1 = (i + 1) % n;
      const vv = v[i] * (1 - f) + v[i1] * f;
      const vn = vv * (1 + (rng() - 0.5) * 0.006);
      const vprev = v[(i - 10 + n) % n], vnext = v[(i + 10) % n];
      const longG = (vnext * vnext - vprev * vprev) / (2 * 20) / 9.81;
      const latG = vv * vv * path.k[i] / 9.81;
      let throttle = longG > 0.02 ? Math.min(100, 60 + longG * 400) : (longG > -0.08 ? Math.max(0, 40 + longG * 500) : 0);
      if (vv > p.vmax * 0.97) throttle = 100;
      throttle = Math.max(0, Math.min(100, throttle + (rng() - 0.5) * 2));
      const brake = longG < -0.1 ? Math.min(100, -longG * 80 + (rng() - 0.5) * 3) : 0;
      // position with lateral offset
      const oi = (s / n) * off.length; const o0 = off[Math.floor(oi) % off.length], o1 = off[(Math.floor(oi) + 1) % off.length];
      const lateral = o0 + (o1 - o0) * (oi - Math.floor(oi)) + (lapIndex % 2 ? 1.2 : -1.2);
      const h = path.heading[i];
      const x = path.xy[i][0] + (path.xy[i1][0] - path.xy[i][0]) * f - Math.sin(h) * lateral;
      const y = path.xy[i][1] + (path.xy[i1][1] - path.xy[i][1]) * f + Math.cos(h) * lateral;
      const ll = toLatLon(x, y, path.lat0, path.lon0);
      samples.push({ t, dist: s, speed: vn, throttle, brake, latG, longG, lat: ll[0], lon: ll[1], rpm: 2500 + vn * 120 + (rng() - .5) * 60, steer: -latG * 55, heading: h });
      s += vn * dt; t += dt;
    }
    return samples;
  }

  function makeSession(track, opts) {
    const rng = mulberry32(opts.seed || 13);
    const path = buildPath(track);
    const laps = [];
    const nLaps = opts.laps || 18;
    for (let L = 1; L <= nLaps; L++) {
      // driver gets a bit quicker over the session, with scatter and two slow laps
      const prog = Math.min(1, L / 14);
      let skill = 0.955 + prog * 0.045 + (rng() - 0.5) * 0.02;
      if (L === 1 || L === 7) skill -= 0.025;
      const p = { vmax: 38.8 * skill, aLat: 12.6 * skill * skill, aBrake: 10.5 * skill, aAcc: 4.9 * skill };
      const v = speedProfile(path, p, rng);
      const samples = sampleLap(path, v, p, rng, L);
      // light smoothing of pedal channels (sensor-like)
      for (const key of ['throttle', 'brake']) { const raw = samples.map(s => s[key]); for (let i = 0; i < raw.length; i++) { let s = 0, c = 0; for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < raw.length) { s += raw[j]; c++; } } samples[i][key] = s / c; } }
      const time = samples[samples.length - 1].t + 0.1 * (samples[samples.length - 1].speed > 0 ? ((path.length - samples[samples.length - 1].dist) / samples[samples.length - 1].speed) : 0);
      const vmax = Math.max(...samples.map(s => s.speed));
      laps.push({ number: L, samples, time, vmax, lengthM: path.length });
    }
    return { path, laps, trackName: track.circuit, country: track.country, corners: track.corners, startFinish: track.start_finish };
  }

  // Sector times for a lap. `bounds` = number of equal sectors, or an array of n-1 boundary fractions of lap distance.
  function sectorTimes(lap, bounds) {
    const fr = Array.isArray(bounds) ? bounds : Array.from({ length: Math.max(1, bounds) - 1 }, (_, i) => (i + 1) / bounds);
    const nSectors = fr.length + 1;
    const out = []; const L = lap.lengthM;
    let prevT = 0;
    for (let s = 1; s <= nSectors; s++) {
      const d = L * (s === nSectors ? 1 : fr[s - 1]);
      let t;
      if (s === nSectors) t = lap.time; else {
        const idx = lap.samples.findIndex(x => x.dist >= d);
        const a = lap.samples[Math.max(0, idx - 1)], b = lap.samples[idx];
        t = a.t + (b.t - a.t) * ((d - a.dist) / Math.max(1e-6, b.dist - a.dist));
      }
      out.push(t - prevT); prevT = t;
    }
    return out;
  }

  // interpolate a sample of lap at a given distance
  function sampleAt(lap, dist) {
    const S = lap.samples;
    if (dist <= 0) return S[0];
    if (dist >= S[S.length - 1].dist) return S[S.length - 1];
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m].dist <= dist) lo = m; else hi = m; }
    const a = S[lo], b = S[hi], f = (dist - a.dist) / Math.max(1e-6, b.dist - a.dist);
    const o = {}; for (const k in a) o[k] = typeof a[k] === 'number' ? a[k] + (b[k] - a[k]) * f : a[k];
    return o;
  }

  function fmtTime(t) {
    if (t == null || isNaN(t)) return '';
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  }
  function fmtDelta(d, dp = 2) { if (d == null || isNaN(d)) return ''; const s = d.toFixed(dp); return (d > 0 ? '+' : (d < 0 ? '' : '')) + s; }

  window.CTData = { makeSession, sectorTimes, sampleAt, fmtTime, fmtDelta, mulberry32 };
})();
