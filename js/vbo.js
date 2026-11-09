/* Racelogic .vbo parser + lap splitter (browser side). */
(function () {
  const R = 6371000;

  function parseVbo(text, fileName) {
    const lines = text.split(/\r?\n/);
    const sec = {}; let cur = 'preamble'; sec[cur] = [];
    let dataStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l[0] === '[') { cur = l.trim().slice(1, -1).toLowerCase(); sec[cur] = []; if (cur === 'data') { dataStart = i + 1; break; } continue; }
      sec[cur].push(l);
    }
    const header = (sec.header || []).map(s => s.trim()).filter(Boolean);
    const units = (sec['channel units'] || []).map(s => s.trim()).filter(Boolean);
    const cols = ((sec['column names'] || []).join(' ').trim().split(/\s+/)).filter(Boolean);
    const comments = (sec.comments || []).join('\n').trim();
    const avi = (sec.avi || []).map(s => s.trim()).filter(Boolean);
    const created = (sec.preamble || []).join(' ').match(/created on\s+(.+?)\s*$/i)?.[1] || '';
    // laptiming: "Start  lon1 lat1 lon2 lat2 ¬ name"  (minutes; VBO longitude is West-positive)
    const gates = [];
    for (const l of (sec.laptiming || [])) {
      const m = l.match(/^\s*(Start|Finish|Split\d*)\s+([+-]?\d+\.?\d*)\s+([+-]?\d+\.?\d*)\s+([+-]?\d+\.?\d*)\s+([+-]?\d+\.?\d*)/i);
      if (m) gates.push({ kind: m[1].toLowerCase(), a: [+m[3] / 60, -m[2] / 60], b: [+m[5] / 60, -m[4] / 60], name: (l.split('¬')[1] || '').trim() });
    }
    // data
    const n = lines.length - dataStart; const ci = {}; cols.forEach((c, i) => ci[c] = i);
    const raw = cols.map(() => new Float64Array(n)); let rows = 0;
    const iTime = ci.time, iLat = ci.lat, iLong = ci.long;
    for (let i = dataStart; i < lines.length; i++) {
      const l = lines[i]; if (!l || l.length < 5) continue;
      const parts = l.trim().split(/\s+/); if (parts.length < 4) continue;
      for (let c = 0; c < cols.length; c++) {
        let v = parts[c]; if (v === undefined) { raw[c][rows] = NaN; continue; }
        if (c === iTime) { // HHMMSS.sss -> seconds of day
          const f = parseFloat(v); const hh = Math.floor(f / 10000), mm = Math.floor((f - hh * 10000) / 100), ss = f - hh * 10000 - mm * 100; raw[c][rows] = hh * 3600 + mm * 60 + ss;
        } else raw[c][rows] = parseFloat(v);
      }
      rows++;
    }
    const data = {}; cols.forEach((c, i) => data[c] = raw[i].subarray(0, rows));
    // units map by header order (header lists all channels incl. the 7 standard ones; units list starts after them)
    const unitMap = {}; const stdCount = header.length - units.length; header.forEach((h, i) => { if (i >= stdCount) unitMap[h] = units[i - stdCount]; });
    return { fileName, created, header, cols, unitMap, comments, avi, gates, data, rows };
  }

  // ---- geometry helpers (local metres around lat0/lon0)
  function proj(lat0, lon0) { const k = Math.cos(lat0 * Math.PI / 180) * Math.PI / 180 * R, ky = Math.PI / 180 * R; return { xy: (lat, lon) => [(lon - lon0) * k, (lat - lat0) * ky], ll: (x, y) => [lat0 + y / ky, lon0 + x / k] }; }
  function segIntersect(p, p2, q, q2) {
    const r = [p2[0] - p[0], p2[1] - p[1]], s = [q2[0] - q[0], q2[1] - q[1]];
    const den = r[0] * s[1] - r[1] * s[0]; if (Math.abs(den) < 1e-12) return null;
    const qp = [q[0] - p[0], q[1] - p[1]]; const t = (qp[0] * s[1] - qp[1] * s[0]) / den, u = (qp[0] * r[1] - qp[1] * r[0]) / den;
    return (t >= 0 && t <= 1 && u >= 0 && u <= 1) ? t : null;
  }

  // Build decoded per-row arrays (lat/lon deg, t seconds, speed m/s) with longitude convention handling
  function decode(vbo, opts = {}) {
    const d = vbo.data, n = vbo.rows;
    const lat = new Float64Array(n), lon = new Float64Array(n), t = new Float64Array(n), v = new Float64Array(n);
    const lonSign = opts.lonSign ?? -1; // VBO: West positive -> negate for East-positive degrees
    let t0 = d.time ? d.time[0] : 0, wrap = 0, prev = t0;
    for (let i = 0; i < n; i++) {
      const la = d.lat ? d.lat[i] : d.latitude[i], lo = d.long ? d.long[i] : d.longitude[i];
      lat[i] = Math.abs(la) > 90 ? la / 60 : la; lon[i] = Math.abs(lo) > 180 ? lonSign * lo / 60 : (lonSign < 0 ? lo : -lo);
      let tt = d.time ? d.time[i] : i * 0.1; if (tt < prev - 1000) wrap += 86400; prev = tt; t[i] = tt + wrap;
      v[i] = (d.velocity ? d.velocity[i] : 0) / 3.6;
    }
    return { lat, lon, t, v };
  }

  // Find gate crossings. gate = {a:[lat,lon], b:[lat,lon]}. Returns array of {idx, frac, time}
  function crossings(dec, gate, P) {
    const A = P.xy(gate.a[0], gate.a[1]), B = P.xy(gate.b[0], gate.b[1]);
    const out = []; let px = null, py = null;
    for (let i = 0; i < dec.lat.length; i++) {
      const [x, y] = P.xy(dec.lat[i], dec.lon[i]);
      if (px !== null && (x !== px || y !== py)) {
        const f = segIntersect([px, py], [x, y], A, B);
        if (f !== null) { const time = dec.t[i - 1] + (dec.t[i] - dec.t[i - 1]) * f; if (!out.length || time - out[out.length - 1].time > 15) out.push({ idx: i - 1, frac: f, time }); }
      }
      px = x; py = y;
    }
    return out;
  }

  // Gate from a start/finish point + trace heading (perpendicular segment of given width)
  function gateFromPoint(dec, pt, width, P) {
    let best = 0, bd = Infinity; const [tx, ty] = P.xy(pt[0], pt[1]);
    for (let i = 0; i < dec.lat.length; i += 1) { const [x, y] = P.xy(dec.lat[i], dec.lon[i]); const dd = (x - tx) ** 2 + (y - ty) ** 2; if (dd < bd) { bd = dd; best = i; } }
    const i0 = Math.max(0, best - 5), i1 = Math.min(dec.lat.length - 1, best + 5);
    const [x0, y0] = P.xy(dec.lat[i0], dec.lon[i0]), [x1, y1] = P.xy(dec.lat[i1], dec.lon[i1]);
    const h = Math.atan2(y1 - y0, x1 - x0); const w = width / 2;
    const a = P.ll(tx - Math.sin(h) * w, ty + Math.cos(h) * w), b = P.ll(tx + Math.sin(h) * w, ty - Math.cos(h) * w);
    return { a, b, distToTrace: Math.sqrt(bd), nearestIdx: best };
  }

  window.CTVbo = { parseVbo, decode, proj, crossings, gateFromPoint };
})();
