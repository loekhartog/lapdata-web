/* Stacked channel graph (canvas) + small chart helpers */
(function () {
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  class StackedChart {
    constructor(canvas, app) {
      this.c = canvas; this.ctx = canvas.getContext('2d'); this.app = app;
      this.zoom = { from: 0, to: 1 }; // fraction of x range
      canvas.addEventListener('mousedown', e => { this.drag = true; this.setCursorFromEvent(e); });
      window.addEventListener('mousemove', e => { if (this.drag) this.setCursorFromEvent(e); });
      window.addEventListener('mouseup', () => this.drag = false);
      canvas.addEventListener('wheel', e => {
        e.preventDefault();
        const r = this.c.getBoundingClientRect(); const fx = (e.clientX - r.left - this.left) / (r.width - this.left - this.right);
        const span = this.zoom.to - this.zoom.from; const f = e.deltaY > 0 ? 1.25 : 0.8;
        let ns = Math.min(1, Math.max(0.03, span * f));
        const anchor = this.zoom.from + fx * span;
        let from = anchor - fx * ns, to = from + ns;
        if (from < 0) { from = 0; to = ns; } if (to > 1) { to = 1; from = 1 - ns; }
        this.zoom = { from, to }; this.invalidate(); this.draw();
      }, { passive: false });
      canvas.addEventListener('dblclick', () => { this.zoom = { from: 0, to: 1 }; this.invalidate(); this.draw(); });
      this.left = 52; this.right = 10;
    }
    xRange() {
      const app = this.app; const laps = app.selectedLaps();
      if (!laps.length) return [0, 1];
      const mode = app.settings.graphMode;
      let max = 0;
      for (const l of laps) max = Math.max(max, mode === 'Time' ? l.time : mode === 'Distance' ? l.lengthM : l.samples.length);
      return [0, max];
    }
    xOf(lap, sample, idx) {
      const m = this.app.settings.graphMode;
      return m === 'Time' ? sample.t : m === 'Distance' ? sample.dist : idx;
    }
    setCursorFromEvent(e) {
      const r = this.c.getBoundingClientRect();
      const w = r.width - this.left - this.right;
      const fx = Math.min(1, Math.max(0, (e.clientX - r.left - this.left) / w));
      const [x0, x1] = this.xRange(); const span = x1 - x0;
      const xv = x0 + (this.zoom.from + fx * (this.zoom.to - this.zoom.from)) * span;
      this.app.setCursorX(xv);
    }
    invalidate() { this.dirty = true; }
    // Static layer (grid, series, labels) is rendered once into an offscreen canvas and re-used until invalidated;
    // draw() only blits it and paints the cursor + legend values, so playback costs almost nothing.
    renderStatic(W, H, dpr) {
      const app = this.app; const off = this.off || (this.off = document.createElement('canvas'));
      if (off.width !== W * dpr || off.height !== H * dpr) { off.width = W * dpr; off.height = H * dpr; }
      const ctx = off.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = css('--chart-bg'); ctx.fillRect(0, 0, W, H);
      const fg = css('--fg'), fg2 = css('--fg-2'), grid = css('--gridline');
      const chans = app.graphChannels(); const laps = app.selectedLaps();
      const left = this.left, right = this.right, bottom = 24, top = 4;
      const n = chans.length; const ph = (H - top - bottom) / Math.max(1, n);
      const [X0, X1] = this.xRange(); const span = (X1 - X0) || 1;
      const zf = this.zoom.from, zt = this.zoom.to; const pw = W - left - right;
      const xpix = (xv) => left + ((xv - X0) / span - zf) / (zt - zf) * pw;
      const font = `${Math.max(9, parseFloat(getComputedStyle(document.body).fontSize) - 2)}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.font = font;
      if (app.settings.showSectorsOnGraph && laps.length) {
        const sm = app.sectorModel(); const ns = sm.n; const ref = laps[0];
        for (let s = 0; s < ns; s += 2) {
          const d0 = ref.lengthM * (s ? sm.fr[s - 1] : 0), d1 = ref.lengthM * (s + 1 < ns ? sm.fr[s] : 1);
          const xa = xpix(this.xAtDist(ref, d0)), xb = xpix(this.xAtDist(ref, d1));
          ctx.fillStyle = css('--app-bg-2'); ctx.fillRect(Math.max(left, xa), top, Math.min(left + pw, xb) - Math.max(left, xa), H - top - bottom);
        }
      }
      const panels = [];
      chans.forEach((ch, ci) => {
        const y0 = top + ci * ph, y1 = y0 + ph; panels.push({ y0, ph });
        let min = Infinity, max = -Infinity;
        const series = laps.map(l => { const arr = app.channelSeries(l, ch); for (const v of arr.y) { if (v < min) min = v; if (v > max) max = v; } return arr; });
        if (!isFinite(min)) { min = 0; max = 1; }
        if (ch.fixed) { min = ch.fixed[0]; max = ch.fixed[1]; }
        else { const pad = (max - min) * 0.08 || 1; min -= pad; max += pad; if (ch.minZero) min = Math.min(0, min); }
        const ypix = v => y1 - 6 - (v - min) / (max - min) * (ph - 14);
        ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.fillStyle = fg2; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        for (const tv of niceTicks(min, max, ph > 120 ? 5 : 3)) { const y = Math.round(ypix(tv)) + .5; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(W - right, y); ctx.stroke(); ctx.fillText(fmtTick(tv), left - 4, y); }
        for (const tv of niceTicks(X0 + zf * span, X0 + zt * span, 8)) { const x = Math.round(xpix(tv)) + .5; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); }
        ctx.strokeStyle = css('--app-border-light'); ctx.strokeRect(left + .5, y0 + .5, pw - 1, ph - 1);
        ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(ch.label, left + 4, y0 + 3);
        ctx.save(); ctx.beginPath(); ctx.rect(left, y0, pw, ph); ctx.clip();
        const visFrom = X0 + zf * span, visTo = X0 + zt * span;
        series.forEach((s, li) => {
          ctx.strokeStyle = laps[li].colour; ctx.lineWidth = 1.2; ctx.beginPath();
          // only the visible part, decimated to ~2 points per pixel
          let i0 = 0, i1 = s.x.length - 1; while (i0 < i1 && s.x[i0 + 1] < visFrom) i0++; while (i1 > i0 && s.x[i1 - 1] > visTo) i1--;
          const step = Math.max(1, Math.floor((i1 - i0) / (pw * 2)));
          let started = false;
          for (let i = i0; i <= i1; i += step) { const x = xpix(s.x[i]), y = ypix(s.y[i]); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
          ctx.stroke();
        });
        ctx.restore();
      });
      ctx.fillStyle = fg2; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (const tv of niceTicks(X0 + zf * span, X0 + zt * span, 8)) { const x = xpix(tv); if (x >= left && x <= W - right) ctx.fillText(fmtTick(tv), x, H - bottom + 4); }
      this.layout = { chans, laps, panels, left, right, bottom, top, W, H, xpix, font, fg };
      this.dirty = false;
    }
    draw() {
      const c = this.c, ctx = this.ctx, app = this.app;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = c.clientHeight; if (!W || !H) return;
      if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; this.dirty = true; }
      if (this.dirty || !this.layout || this.layout.W !== W || this.layout.H !== H) this.renderStatic(W, H, dpr);
      const L = this.layout;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      ctx.drawImage(this.off, 0, 0, W, H);
      ctx.font = L.font;
      // legends with live values
      L.chans.forEach((ch, ci) => {
        const { y0 } = L.panels[ci];
        const txt = L.laps.map(l => ch.format(app.channelValueAtCursor(l, ch)));
        const lw = Math.max(...txt.map(t => ctx.measureText(t).width)) + 30, lh = L.laps.length * 14 + 6;
        const lx = W - L.right - lw - 6, ly = y0 + 6;
        ctx.fillStyle = css('--app-bg'); ctx.fillRect(lx, ly, lw, lh); ctx.strokeStyle = css('--app-border'); ctx.strokeRect(lx + .5, ly + .5, lw, lh);
        L.laps.forEach((l, i) => { ctx.fillStyle = l.colour; ctx.fillRect(lx + 6, ly + 5 + i * 14, 9, 9); ctx.fillStyle = L.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(txt[i], lx + 20, ly + 3 + i * 14); });
      });
      // cursor
      const cx = L.xpix(app.cursorX);
      if (cx >= L.left && cx <= W - L.right) { ctx.strokeStyle = L.fg; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(cx) + .5, L.top); ctx.lineTo(Math.round(cx) + .5, H - L.bottom); ctx.stroke(); }
      ctx.fillStyle = L.fg; ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.font = `bold ${L.font}`;
      const m = app.settings.graphMode; const label = m === 'Time' ? `[${app.cursorX.toFixed(1)} s] Time` : m === 'Distance' ? `[${Math.round(app.cursorX)} m] Distance` : `[${Math.round(app.cursorX)}] Position`;
      ctx.fillText(label, W - L.right - 2, H - L.bottom + 4);
    }
    xAtDist(lap, d) {
      const m = this.app.settings.graphMode; if (m === 'Distance') return d;
      const S = lap.samples; let idx = S.findIndex(s => s.dist >= d); if (idx < 0) idx = S.length - 1;
      return m === 'Time' ? S[idx].t : idx;
    }
  }

  function niceTicks(min, max, count) {
    const span = max - min; if (!(span > 0)) return [min];
    const raw = span / count; const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag; const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = []; for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function fmtTick(v) { return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? (+v.toFixed(1)).toString() : (+v.toFixed(2)).toString(); }

  // simple XY line chart for insights / reports
  function lineChart(canvas, series, opts = {}) {
    const ctx = canvas.getContext('2d'); const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css('--chart-bg'); ctx.fillRect(0, 0, W, H);
    const L = 36, Rr = 8, T = 8, B = 18;
    let ymin = opts.ymin ?? Infinity, ymax = opts.ymax ?? -Infinity, xmax = 0;
    series.forEach(s => s.y.forEach((v, i) => { if (opts.ymin == null) ymin = Math.min(ymin, v); if (opts.ymax == null) ymax = Math.max(ymax, v); xmax = Math.max(xmax, s.y.length); }));
    if (ymin === ymax) { ymin -= 1; ymax += 1; }
    const xp = i => L + i / Math.max(1, xmax - 1) * (W - L - Rr), yp = v => H - B - (v - ymin) / (ymax - ymin) * (H - T - B);
    ctx.strokeStyle = css('--gridline'); ctx.fillStyle = css('--fg-2'); ctx.font = '9px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const tv of niceTicks(ymin, ymax, 4)) { const y = Math.round(yp(tv)) + .5; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - Rr, y); ctx.stroke(); ctx.fillText(tv.toFixed(opts.dp ?? 1), L - 3, y); }
    if (opts.target != null) { ctx.setLineDash([4, 2]); ctx.strokeStyle = '#E66A2C'; ctx.beginPath(); ctx.moveTo(L, yp(opts.target)); ctx.lineTo(W - Rr, yp(opts.target)); ctx.stroke(); ctx.setLineDash([]); }
    series.forEach(s => { ctx.strokeStyle = s.colour; ctx.lineWidth = s.width || 1.4; ctx.globalAlpha = s.alpha ?? 1; ctx.beginPath(); s.y.forEach((v, i) => i ? ctx.lineTo(xp(i), yp(v)) : ctx.moveTo(xp(i), yp(v))); ctx.stroke(); ctx.globalAlpha = 1; });
    if (opts.cursor != null) { ctx.strokeStyle = css('--fg'); ctx.beginPath(); ctx.moveTo(xp(opts.cursor), T); ctx.lineTo(xp(opts.cursor), H - B); ctx.stroke(); }
    if (opts.xlabel) { ctx.fillStyle = css('--fg-2'); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(opts.xlabel, (L + W - Rr) / 2, H - 2); }
  }

  // bar chart for reports
  function barChart(canvas, cats, series, opts = {}) {
    const ctx = canvas.getContext('2d'); const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css('--chart-bg'); ctx.fillRect(0, 0, W, H);
    const horiz = opts.horizontal; const L = horiz ? 90 : 46, Rr = 10, T = 10, B = horiz ? 22 : 40;
    let vmax = 0, vmin = 0; series.forEach(s => s.v.forEach(v => { vmax = Math.max(vmax, v); vmin = Math.min(vmin, v); }));
    vmax *= 1.08; if (vmax === vmin) vmax = vmin + 1;
    const n = cats.length, m = series.length;
    ctx.font = '10px sans-serif'; ctx.fillStyle = css('--fg-2'); ctx.strokeStyle = css('--gridline');
    if (!horiz) {
      const gw = (W - L - Rr) / n, bw = gw / (m + 1);
      const yp = v => H - B - (v - vmin) / (vmax - vmin) * (H - T - B);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (const tv of niceTicks(vmin, vmax, 5)) { const y = Math.round(yp(tv)) + .5; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - Rr, y); ctx.stroke(); ctx.fillText(fmtTick(tv), L - 4, y); }
      cats.forEach((cat, i) => {
        series.forEach((s, j) => { ctx.fillStyle = s.colour; const x = L + i * gw + bw * (j + .5), y = yp(s.v[i]); ctx.fillRect(x, Math.min(y, yp(0)), bw, Math.abs(yp(0) - y)); });
        ctx.fillStyle = css('--fg'); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.save(); ctx.translate(L + i * gw + gw / 2, H - B + 4); if (n > 10) ctx.rotate(-Math.PI / 4); ctx.fillText(cat, 0, 0); ctx.restore();
      });
    } else {
      const gh = (H - T - B) / n, bh = gh / (m + 1);
      const xp = v => L + (v - vmin) / (vmax - vmin) * (W - L - Rr);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (const tv of niceTicks(vmin, vmax, 6)) { const x = Math.round(xp(tv)) + .5; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, H - B); ctx.stroke(); ctx.fillText(fmtTick(tv), x, H - B + 4); }
      cats.forEach((cat, i) => {
        series.forEach((s, j) => { ctx.fillStyle = s.colour; const y = T + i * gh + bh * (j + .5); ctx.fillRect(xp(0), y, xp(s.v[i]) - xp(0), bh); });
        ctx.fillStyle = css('--fg'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(cat, L - 6, T + i * gh + gh / 2);
      });
    }
    if (opts.legend) { let x = L; series.forEach(s => { ctx.fillStyle = s.colour; ctx.fillRect(x, 2, 10, 10); ctx.fillStyle = css('--fg'); ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(s.name, x + 14, 2); x += 14 + ctx.measureText(s.name).width + 14; }); }
  }

  // friction circle
  function frictionCircle(canvas, pts, refPts, targetG) {
    const ctx = canvas.getContext('2d'); const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css('--fc-plot-fill'); ctx.fillRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 16, gmax = 1.6;
    const px = g => cx + g / gmax * r, py = g => cy - g / gmax * r;
    ctx.strokeStyle = css('--hull-stroke'); ctx.fillStyle = css('--hull-fill');
    // session hull (approx: ellipse of max values)
    ctx.beginPath(); ctx.ellipse(cx, cy, 1.25 / gmax * r, 1.15 / gmax * r, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = css('--fc-axis'); ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
    ctx.setLineDash([3, 3]); for (const g of [0.5, 1.0, 1.5]) { ctx.beginPath(); ctx.arc(cx, cy, g / gmax * r, 0, Math.PI * 2); ctx.stroke(); } ctx.setLineDash([]);
    if (targetG) { ctx.strokeStyle = '#E66A2C'; ctx.setLineDash([4, 2]); ctx.beginPath(); ctx.arc(cx, cy, targetG / gmax * r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
    ctx.fillStyle = css('--fg-2'); ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('+LongAcc', cx, cy - r - 4); ctx.fillText('-LongAcc', cx, cy + r + 12); ctx.textAlign = 'left'; ctx.fillText('+LatAcc', cx + r + 2, cy + 3); ctx.textAlign = 'right'; ctx.fillText('-LatAcc', cx - r - 2, cy + 3);
    const plot = (arr, col, a) => { ctx.fillStyle = col; ctx.globalAlpha = a; arr.forEach(p => { ctx.beginPath(); ctx.arc(px(p[0]), py(p[1]), 2, 0, Math.PI * 2); ctx.fill(); }); ctx.globalAlpha = 1; };
    if (refPts) plot(refPts, refPts.colour || '#999', .35);
    plot(pts, pts.colour || '#c00', .85);
  }

  window.CTCharts = { StackedChart, lineChart, barChart, frictionCircle, niceTicks };
})();
