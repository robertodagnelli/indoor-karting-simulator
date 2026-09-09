/**
 * Shared track centerline builder — closed polyline with circular corner fillets.
 * Used by the simulator and the 2D track editor.
 *
 * Track format: { wayPoints: [[x,z], ...] }  (closed loop, min 3 points)
 */
(function (global) {
  "use strict";

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function vnorm(x, z) { const l = Math.hypot(x, z) || 1; return { x: x / l, z: z / l }; }
  function leftOf(d) { return { x: -d.z, z: d.x }; }

  const DEFAULTS = {
    halfW: 4.2,
    curbW: 0.55,
    wallGap: 0.25,
    sampleSpacing: 0.85,
    filletTarget: 11,
    straightAng: 6 * Math.PI / 180
  };

  function emptyPath(halfW, wallOffset) {
    return {
      center: [], tangents: [], normals: [], cum: [], N: 0, totalLength: 0,
      bboxMinX: 0, bboxMaxX: 0, bboxMinZ: 0, bboxMaxZ: 0,
      halfW: halfW, wallOffset: wallOffset
    };
  }

  /** Accept wayPoints array, track object, or nodes (anchors only). */
  function normalizeWayPoints(input) {
    if (!input) return [];
    if (Array.isArray(input)) {
      if (!input.length) return [];
      if (typeof input[0] === "number" || (Array.isArray(input[0]) && input[0].length >= 2)) {
        return input.map(p => [+p[0], +p[1]]);
      }
      /* array of {x,z} or nodes */
      return input.map(n => [+(n.x != null ? n.x : n[0]), +(n.z != null ? n.z : n[1])]);
    }
    if (Array.isArray(input.wayPoints) && input.wayPoints.length) {
      return input.wayPoints.map(p => [+p[0], +p[1]]);
    }
    if (Array.isArray(input.nodes) && input.nodes.length) {
      return input.nodes.map(n => [+n.x, +n.z]);
    }
    return [];
  }

  /**
   * Build filleted centerline samples from waypoints.
   * @param {Array|Object} wayPointsOrTrack
   * @param {Object} [opts]
   */
  function buildCenterline(wayPointsOrTrack, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    const HALF_W = opts.halfW;
    const CURB_W = opts.curbW;
    const WALL_GAP = opts.wallGap;
    const wallOffset = HALF_W + CURB_W + WALL_GAP;
    const SAMPLE_SPACING = opts.sampleSpacing;
    const FILLET_TARGET = opts.filletTarget;
    const FILLET_MIN = wallOffset + 0.75;
    const STRAIGHT_ANG = opts.straightAng;

    const wayPoints = normalizeWayPoints(wayPointsOrTrack);
    if (wayPoints.length < 3) return emptyPath(HALF_W, wallOffset);

    const verts = wayPoints.map(p => ({ x: p[0], z: p[1] }));
    const MV = verts.length;

    const segLen = [];
    const segDir = [];
    for (let i = 0; i < MV; i++) {
      const a = verts[i], b = verts[(i + 1) % MV];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      segLen.push(len);
      segDir.push({ x: dx / len, z: dz / len });
    }

    const corner = [];
    for (let i = 0; i < MV; i++) {
      const d0 = segDir[(i - 1 + MV) % MV];
      const d1 = segDir[i];
      const cross = d0.x * d1.z - d0.z * d1.x;
      const dot = clamp(d0.x * d1.x + d0.z * d1.z, -1, 1);
      const turn = Math.atan2(cross, dot);
      const absTurn = Math.abs(turn);
      let radius = 0, inset = 0, active = false;
      if (absTurn > STRAIGHT_ANG) {
        active = true;
        const halfTan = Math.tan(absTurn * 0.5);
        radius = FILLET_TARGET;
        inset = radius * halfTan;
      }
      corner.push({ turn, absTurn, radius, inset, active, d0, d1 });
    }

    for (let i = 0; i < MV; i++) {
      const cA = corner[i];
      const cB = corner[(i + 1) % MV];
      const budget = segLen[i] * 0.92;
      let need = (cA.active ? cA.inset : 0) + (cB.active ? cB.inset : 0);
      if (need > budget && need > 1e-6) {
        const s = budget / need;
        if (cA.active) { cA.inset *= s; cA.radius = cA.inset / Math.tan(cA.absTurn * 0.5); }
        if (cB.active) { cB.inset *= s; cB.radius = cB.inset / Math.tan(cB.absTurn * 0.5); }
      }
    }
    for (let i = 0; i < MV; i++) {
      const c = corner[i];
      if (!c.active) continue;
      if (c.radius < FILLET_MIN) {
        c.radius = FILLET_MIN;
        c.inset = c.radius * Math.tan(c.absTurn * 0.5);
      }
    }
    for (let i = 0; i < MV; i++) {
      const cA = corner[i];
      const cB = corner[(i + 1) % MV];
      const budget = segLen[i] * 0.92;
      let need = (cA.active ? cA.inset : 0) + (cB.active ? cB.inset : 0);
      if (need > budget && need > 1e-6) {
        const s = budget / need;
        if (cA.active) { cA.inset *= s; cA.radius = Math.max(0.5, cA.inset / Math.tan(cA.absTurn * 0.5)); }
        if (cB.active) { cB.inset *= s; cB.radius = Math.max(0.5, cB.inset / Math.tan(cB.absTurn * 0.5)); }
      }
    }

    const pieces = [];
    for (let i = 0; i < MV; i++) {
      const v0 = verts[i];
      const v1 = verts[(i + 1) % MV];
      const d = segDir[i];
      const c0 = corner[i];
      const c1 = corner[(i + 1) % MV];
      const startInset = c0.active ? c0.inset : 0;
      const endInset = c1.active ? c1.inset : 0;

      if (c0.active) {
        const dIn = segDir[(i - 1 + MV) % MV];
        const absTurn = c0.absTurn;
        const R = c0.radius;
        const inset = c0.inset;
        const pStart = { x: v0.x - dIn.x * inset, z: v0.z - dIn.z * inset };
        const pEnd = { x: v0.x + d.x * inset, z: v0.z + d.z * inset };
        const nIn = leftOf(dIn);
        const sign = c0.turn >= 0 ? 1 : -1;
        const cen = { x: pStart.x + nIn.x * R * sign, z: pStart.z + nIn.z * R * sign };
        let a0 = Math.atan2(pStart.x - cen.x, pStart.z - cen.z);
        let a1 = Math.atan2(pEnd.x - cen.x, pEnd.z - cen.z);
        let sweep = a1 - a0;
        if (sign > 0) {
          while (sweep < 0) sweep += Math.PI * 2;
          while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
          if (Math.abs(sweep - absTurn) > Math.abs((sweep - Math.PI * 2) - absTurn)) sweep -= Math.PI * 2;
        } else {
          while (sweep > 0) sweep -= Math.PI * 2;
          while (sweep < -Math.PI * 2) sweep += Math.PI * 2;
          if (Math.abs(-sweep - absTurn) > Math.abs((-sweep - Math.PI * 2) - absTurn)) sweep += Math.PI * 2;
        }
        pieces.push({ type: "arc", cen, R, a0, sweep, sign, pStart, pEnd });
      }

      const straightA = { x: v0.x + d.x * startInset, z: v0.z + d.z * startInset };
      const straightB = { x: v1.x - d.x * endInset, z: v1.z - d.z * endInset };
      const sLen = Math.hypot(straightB.x - straightA.x, straightB.z - straightA.z);
      if (sLen > 0.05) {
        pieces.push({ type: "line", a: straightA, b: straightB, d });
      }
    }

    const center = [];
    const tangents = [];
    const normals = [];
    const cum = [];
    let distAcc = 0;

    function pushSample(x, z, tx, tz, stepDist) {
      if (center.length) distAcc += stepDist;
      cum.push(distAcc);
      center.push({ x, z });
      tangents.push({ x: tx, z: tz });
      normals.push({ x: -tz, z: tx });
    }

    for (let pi = 0; pi < pieces.length; pi++) {
      const p = pieces[pi];
      if (p.type === "line") {
        const dx = p.b.x - p.a.x, dz = p.b.z - p.a.z;
        const len = Math.hypot(dx, dz) || 1;
        const steps = Math.max(1, Math.round(len / SAMPLE_SPACING));
        const tx = dx / len, tz = dz / len;
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          pushSample(p.a.x + dx * t, p.a.z + dz * t, tx, tz, s === 0 ? 0 : len / steps);
        }
        pushSample(p.b.x, p.b.z, tx, tz, len / steps);
      } else {
        const steps = Math.max(4, Math.round(Math.abs(p.sweep) * p.R / SAMPLE_SPACING));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          const ang = p.a0 + p.sweep * t;
          const x = p.cen.x + p.R * Math.sin(ang);
          const z = p.cen.z + p.R * Math.cos(ang);
          const tx = Math.cos(ang) * Math.sign(p.sweep || p.sign);
          const tz = -Math.sin(ang) * Math.sign(p.sweep || p.sign);
          const tn = vnorm(tx, tz);
          const arcStep = (s === 0) ? 0 : (Math.abs(p.sweep) * p.R / steps);
          pushSample(x, z, tn.x, tn.z, arcStep);
        }
        const ang = p.a0 + p.sweep;
        const x = p.cen.x + p.R * Math.sin(ang);
        const z = p.cen.z + p.R * Math.cos(ang);
        const tx = Math.cos(ang) * Math.sign(p.sweep || p.sign);
        const tz = -Math.sin(ang) * Math.sign(p.sweep || p.sign);
        const tn = vnorm(tx, tz);
        pushSample(x, z, tn.x, tn.z, Math.abs(p.sweep) * p.R / steps);
      }
    }

    for (let i = center.length - 1; i > 0; i--) {
      const dx = center[i].x - center[i - 1].x, dz = center[i].z - center[i - 1].z;
      if (dx * dx + dz * dz < 1e-6) {
        center.splice(i, 1); tangents.splice(i, 1); normals.splice(i, 1); cum.splice(i, 1);
      }
    }

    const N = center.length;
    const totalLength = cum[N - 1] || distAcc;
    let bboxMinX = Infinity, bboxMaxX = -Infinity, bboxMinZ = Infinity, bboxMaxZ = -Infinity;
    center.forEach(p => {
      bboxMinX = Math.min(bboxMinX, p.x); bboxMaxX = Math.max(bboxMaxX, p.x);
      bboxMinZ = Math.min(bboxMinZ, p.z); bboxMaxZ = Math.max(bboxMaxZ, p.z);
    });

    return {
      center, tangents, normals, cum, N, totalLength,
      bboxMinX, bboxMaxX, bboxMinZ, bboxMaxZ,
      halfW: HALF_W, wallOffset
    };
  }

  /** Alias used by older call sites. */
  function buildTrack(wayPointsOrTrack, opts) {
    return buildCenterline(wayPointsOrTrack, opts);
  }

  function edgePoint(path, i, offset) {
    const { center, normals, N } = path;
    let o = offset;
    const i0 = (i - 1 + N) % N, i1 = (i + 1) % N;
    const ax = center[i].x - center[i0].x, az = center[i].z - center[i0].z;
    const bx = center[i1].x - center[i].x, bz = center[i1].z - center[i].z;
    const al = Math.hypot(ax, az) || 1e-6, bl = Math.hypot(bx, bz) || 1e-6;
    const cross = ax * bz - az * bx;
    const ang = Math.atan2(cross, ax * bx + az * bz);
    const kappa = ang / ((al + bl) * 0.5);
    if (Math.abs(kappa) > 1e-5) {
      const maxIn = Math.max(0.4, Math.abs(1 / kappa) - 0.35);
      if (o < 0 && kappa < 0) o = Math.max(o, -maxIn);
      if (o > 0 && kappa > 0) o = Math.min(o, maxIn);
    }
    return { x: center[i].x + normals[i].x * o, z: center[i].z + normals[i].z * o };
  }

  global.TrackLib = {
    DEFAULTS,
    normalizeWayPoints,
    buildCenterline,
    buildTrack,
    edgePoint
  };
})(typeof window !== "undefined" ? window : globalThis);
