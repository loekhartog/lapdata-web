/* Circuit Tools 3 web replica — Maths Channel expression engine.
   Grammar (case-insensitive keywords):
     or-expr   := and-expr ('or' and-expr)*
     and-expr  := not-expr ('and' not-expr)*
     not-expr  := 'not' not-expr | cmp
     cmp       := sum (('<'|'<='|'>'|'>='|'='|'=='|'!='|'<>') sum)?
     sum       := term (('+'|'-') term)*
     term      := power (('*'|'/'|'%') power)*
     power     := ('-'|'+') power | primary ('^' power)?
     primary   := number | name | name '(' args ')' | '[' any text ']' | '(' or-expr ')'
   Names resolve through a channel accessor supplied by the caller; `$Param` names resolve through a parameter map.
   Stateful functions (ddt, integ, smooth, prev, cum*) keep per-node state that is reset at the start of every lap,
   so a compiled expression must be evaluated sample by sample in order via Series.
*/
(function () {
  const FUNCS = {
    sqrt: a => Math.sqrt(a), abs: a => Math.abs(a), sin: a => Math.sin(a), cos: a => Math.cos(a), tan: a => Math.tan(a),
    asin: a => Math.asin(a), acos: a => Math.acos(a), atan: a => Math.atan(a), atan2: (a, b) => Math.atan2(a, b),
    exp: a => Math.exp(a), ln: a => Math.log(a), log: a => Math.log10(a), round: a => Math.round(a), floor: a => Math.floor(a), ceil: a => Math.ceil(a),
    sign: a => Math.sign(a), deg: a => a * 180 / Math.PI, rad: a => a * Math.PI / 180,
    min: (...a) => Math.min(...a), max: (...a) => Math.max(...a), avg: (...a) => a.reduce((x, y) => x + y, 0) / a.length,
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  };
  const STATEFUL = new Set(['ddt', 'integ', 'smooth', 'prev', 'cummax', 'cummin', 'if']);
  const ALIASES = { 'd/dt': 'ddt', derivative: 'ddt', integral: 'integ', '∫': 'integ' };

  function tokenize(src) {
    const out = []; let i = 0;
    const s = src.replace(/∫/g, ' integ ').replace(/d\/dt/gi, ' ddt ').replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/≠/g, '!=').replace(/×/g, '*').replace(/÷/g, '/');
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) { const m = s.slice(i).match(/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/); out.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
      if (c === '[') { const j = s.indexOf(']', i); if (j < 0) throw new Error('Unclosed [ in expression'); out.push({ t: 'name', v: s.slice(i + 1, j).trim() }); i = j + 1; continue; }
      if (c === '$') { const m = s.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*/); if (!m) throw new Error('Bad parameter name at ' + i); out.push({ t: 'param', v: m[0].slice(1) }); i += m[0].length; continue; }
      if (/[A-Za-z_]/.test(c)) { const m = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_:.\-]*/); const w = m[0]; i += w.length; const lw = w.toLowerCase(); if (lw === 'and' || lw === 'or' || lw === 'not') out.push({ t: 'op', v: lw }); else out.push({ t: 'name', v: w }); continue; }
      const two = s.slice(i, i + 2); if (['<=', '>=', '==', '!=', '<>', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two === '&&' ? 'and' : two === '||' ? 'or' : two }); i += 2; continue; }
      if ('+-*/^%()<>=,!'.includes(c)) { out.push({ t: 'op', v: c === '!' ? 'not' : c }); i++; continue; }
      throw new Error(`Unexpected character "${c}" at position ${i + 1}`);
    }
    return out;
  }

  function parse(src) {
    const tk = tokenize(src); let p = 0;
    const peek = () => tk[p], next = () => tk[p++];
    const isOp = (...v) => peek() && peek().t === 'op' && v.includes(peek().v);
    const expect = (v) => { if (!isOp(v)) throw new Error(`Expected "${v}" ${peek() ? 'before "' + peek().v + '"' : 'at end of expression'}`); next(); };
    const orE = () => { let l = andE(); while (isOp('or')) { next(); const r = andE(); l = { k: 'bin', op: 'or', l, r }; } return l; };
    const andE = () => { let l = notE(); while (isOp('and')) { next(); const r = notE(); l = { k: 'bin', op: 'and', l, r }; } return l; };
    const notE = () => { if (isOp('not')) { next(); return { k: 'not', a: notE() }; } return cmp(); };
    const cmp = () => { const l = sum(); if (isOp('<', '<=', '>', '>=', '=', '==', '!=', '<>')) { const op = next().v; return { k: 'bin', op, l, r: sum() }; } return l; };
    const sum = () => { let l = term(); while (isOp('+', '-')) { const op = next().v; l = { k: 'bin', op, l, r: term() }; } return l; };
    const term = () => { let l = power(); while (isOp('*', '/', '%')) { const op = next().v; l = { k: 'bin', op, l, r: power() }; } return l; };
    // unary minus binds looser than ^ (so -2^2 = -4) but ^ accepts a signed exponent (2^-1)
    const power = () => { if (isOp('-')) { next(); return { k: 'neg', a: power() }; } if (isOp('+')) { next(); return power(); } const b = primary(); if (isOp('^')) { next(); return { k: 'bin', op: '^', l: b, r: power() }; } return b; };
    const primary = () => {
      const t = next(); if (!t) throw new Error('Unexpected end of expression');
      if (t.t === 'num') return { k: 'num', v: t.v };
      if (t.t === 'param') return { k: 'param', name: t.v };
      if (t.t === 'name') {
        const lname = (ALIASES[t.v.toLowerCase()] || t.v).toLowerCase();
        if (isOp('(')) {
          next(); const args = [];
          if (!isOp(')')) { args.push(orE()); while (isOp(',')) { next(); args.push(orE()); } }
          expect(')');
          if (lname === 'pi') return { k: 'num', v: Math.PI };
          if (!FUNCS[lname] && !STATEFUL.has(lname)) throw new Error(`Unknown function "${t.v}"`);
          if (lname === 'if' && args.length !== 3) throw new Error('if() needs 3 arguments: if(condition, then, else)');
          return { k: 'call', fn: lname, args };
        }
        if (lname === 'pi') return { k: 'num', v: Math.PI };
        if (lname === 'e') return { k: 'num', v: Math.E };
        return { k: 'var', name: t.v };
      }
      if (t.t === 'op' && t.v === '(') { const e = orE(); expect(')'); return e; }
      throw new Error(`Unexpected "${t.v}"`);
    };
    const tree = orE();
    if (p < tk.length) throw new Error(`Unexpected "${tk[p].v}" after end of expression`);
    return tree;
  }

  function vars(node, out = new Set()) {
    if (!node) return out;
    if (node.k === 'var') out.add(node.name);
    ['l', 'r', 'a'].forEach(k => node[k] && vars(node[k], out));
    (node.args || []).forEach(a => vars(a, out));
    return out;
  }
  function params(node, out = new Set()) {
    if (!node) return out;
    if (node.k === 'param') out.add(node.name);
    ['l', 'r', 'a'].forEach(k => node[k] && params(node[k], out));
    (node.args || []).forEach(a => params(a, out));
    return out;
  }

  // Build an evaluator. ctx = { get(name, i) -> number, param(name) -> number, t(i) -> seconds }
  function compile(src) {
    const tree = parse(src);
    const nodes = []; // stateful nodes get a slot
    const walk = n => { if (n.k === 'call' && STATEFUL.has(n.fn) && n.fn !== 'if') { n.slot = nodes.length; nodes.push(n); } ['l', 'r', 'a'].forEach(k => n[k] && walk(n[k])); (n.args || []).forEach(walk); };
    walk(tree);
    const state = nodes.map(() => ({}));
    const B = (a) => (a && !isNaN(a)) ? 1 : 0;
    function ev(n, ctx, i) {
      switch (n.k) {
        case 'num': return n.v;
        case 'param': return ctx.param(n.name);
        case 'var': return ctx.get(n.name, i);
        case 'neg': return -ev(n.a, ctx, i);
        case 'not': return B(ev(n.a, ctx, i)) ? 0 : 1;
        case 'bin': {
          const l = ev(n.l, ctx, i);
          if (n.op === 'and') return (B(l) && B(ev(n.r, ctx, i))) ? 1 : 0;
          if (n.op === 'or') return (B(l) || B(ev(n.r, ctx, i))) ? 1 : 0;
          const r = ev(n.r, ctx, i);
          switch (n.op) {
            case '+': return l + r; case '-': return l - r; case '*': return l * r; case '/': return r === 0 ? NaN : l / r; case '%': return l % r; case '^': return Math.pow(l, r);
            case '<': return l < r ? 1 : 0; case '<=': return l <= r ? 1 : 0; case '>': return l > r ? 1 : 0; case '>=': return l >= r ? 1 : 0;
            case '=': case '==': return Math.abs(l - r) < 1e-9 ? 1 : 0; case '!=': case '<>': return Math.abs(l - r) < 1e-9 ? 0 : 1;
          }
          return NaN;
        }
        case 'call': {
          if (n.fn === 'if') return B(ev(n.args[0], ctx, i)) ? ev(n.args[1], ctx, i) : ev(n.args[2], ctx, i);
          if (n.slot === undefined) return FUNCS[n.fn](...n.args.map(a => ev(a, ctx, i)));
          const st = state[n.slot]; const v = ev(n.args[0], ctx, i); const t = ctx.t(i);
          switch (n.fn) {
            case 'ddt': { // derivative over a short window (~3 samples) to keep noise down
              st.h = st.h || []; st.h.push([t, v]); if (st.h.length > 4) st.h.shift();
              const a = st.h[0], b = st.h[st.h.length - 1]; const dt = b[0] - a[0]; return dt > 0 ? (b[1] - a[1]) / dt : 0;
            }
            case 'integ': { if (st.t !== undefined && !isNaN(v)) st.acc = (st.acc || 0) + v * Math.max(0, t - st.t); st.t = t; return st.acc || 0; }
            case 'prev': { const o = st.v === undefined ? v : st.v; st.v = v; return o; }
            case 'cummax': { st.v = st.v === undefined ? v : Math.max(st.v, v); return st.v; }
            case 'cummin': { st.v = st.v === undefined ? v : Math.min(st.v, v); return st.v; }
            case 'smooth': { // moving average over N samples (default 10)
              const N = n.args[1] ? Math.max(1, Math.round(ev(n.args[1], ctx, i))) : 10; st.h = st.h || []; st.h.push(v); if (st.h.length > N) st.h.shift();
              return st.h.reduce((x, y) => x + y, 0) / st.h.length;
            }
          }
          return NaN;
        }
      }
      return NaN;
    }
    return {
      tree, vars: [...vars(tree)], params: [...params(tree)],
      reset() { state.forEach((s, k) => state[k] = {}); },
      eval(ctx, i) { return ev(tree, ctx, i); },
      // evaluate for i = 0..n-1 in order (resets state first)
      series(ctx, n) { this.reset(); const out = new Float64Array(n); for (let i = 0; i < n; i++) out[i] = ev(tree, ctx, i); return out; },
    };
  }

  // Standard Maths Library: expression templates with parameters (defaults mirror Circuit Tools' dialog fields)
  const LIBRARY = [
    { id: 'm_bogging', name: 'Bogging', expr: 'if(rpm < $MinRPM and throttle > $MinThrottle, 1, 0)', units: '', bool: true,
      desc: 'This will highlight the areas where the car is below the optimum shifting RPM.', params: { MinRPM: 3500, MinThrottle: 50 } },
    { id: 'm_brakevel', name: 'Brake Velocity', expr: 'ddt(brake)', units: 'bar/s',
      desc: 'The speed that the driver applies and releases the brake pedal is very important especially when it comes to trail braking.' },
    { id: 'm_coasting', name: 'Coasting', expr: 'if(brake < $BrakeMin and throttle < $ThrottleMin, 1, 0)', units: '', bool: true,
      desc: "Identifies where the driver is Coasting. Avoiding Coasting in areas where it isn't necessary can improve lap times.", params: { BrakeMin: 2, ThrottleMin: 5 } },
    { id: 'm_cumlat', name: 'Cumulative Lateral Acceleration', expr: 'integ(abs(latacc))', units: 'g·s', minZero: true,
      desc: 'If the absolute value of lateral Gs is taken and then all of the Lateral G readings over a given lap are added together, this gives a total lateral G’s that can be compared to other laps/sessions.' },
    { id: 'm_gradient', name: 'Gradient', expr: 'smooth(ddt(height) / max(2, speed / 3.6) * 100, 15)', units: '%',
      desc: 'Road gradient derived from height and distance (rise over run, smoothed).' },
    { id: 'm_pedal', name: 'Pedal Overlap', expr: 'if(brake > $MinBrake and throttle > $MinThrottle, 1, 0)', units: '', bool: true,
      desc: 'Identifies where the driver is applying both the brake and throttle at the same time.', params: { MinBrake: 5, MinThrottle: 10 } },
    { id: 'm_steervel', name: 'Steering Velocity', expr: 'ddt(steer)', units: '°/s',
      desc: 'The speed that the driver turns the steering wheel tells you how hard the driver is working.' },
    { id: 'm_throttlevel', name: 'Throttle Velocity', expr: 'ddt(throttle)', units: '%/s',
      desc: 'The speed at which the driver applies the throttle pedal is important because every time the driver applies and releases the throttle pedal, load is transferred across the car.' },
    { id: 'm_usos', name: 'Understeer/Oversteer', expr: '(steer / $SteeringRatio - $SteeringAngleOffset) - deg($Wheelbase * latacc * 9.81 / max(25, (speed / 3.6)^2))', units: '°',
      desc: 'Compares the steered road-wheel angle with the Ackermann angle the car actually needs for its lateral acceleration. Positive = understeer, below −Oversteer Tolerance = oversteer.',
      params: { Wheelbase: 2.45, SteeringRatio: 15, SteeringAngleOffset: 0, OversteerTolerance: 2 } },
  ];

  // Names an expression can use for the per-sample fields built by the app
  const SAMPLE_VARS = {
    speed: s => s.speed * 3.6, velocity: s => s.speed * 3.6, throttle: s => s.throttle, brake: s => s.brake, rpm: s => s.rpm, steer: s => s.steer, steering: s => s.steer, gear: s => s.gear,
    latacc: s => s.latG, lat_g: s => s.latG, lateral: s => s.latG, longacc: s => s.longG, long_g: s => s.longG, longitudinal: s => s.longG,
    heading: s => ((90 - s.heading * 180 / Math.PI) % 360 + 360) % 360, distance: s => s.dist, dist: s => s.dist, time: s => s.t, elapsed: s => s.t,
    combo: s => Math.hypot(s.latG, s.longG), combined: s => Math.hypot(s.latG, s.longG),
  };

  window.CTMaths = { compile, parse, tokenize, LIBRARY, SAMPLE_VARS, FUNCS: Object.keys(FUNCS).concat([...STATEFUL]) };
})();
