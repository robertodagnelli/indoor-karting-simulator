/** SPDX-License-Identifier: AGPL-3.0-or-later */
/**
 * Track catalog.
 * Live (public host): shipped files in tracks/ only — visitors cannot author circuits.
 * Local/dev: localStorage is the working copy so the editor can iterate before you
 * export JSON into tracks/ and deploy.
 */
(function (global) {
  "use strict";

  const KEY = "gokart.tracks.v1";
  const SELECTED_KEY = "gokart.selectedTrack";
  const FALLBACK = {
    id: "indoor",
    name: "Indoor Circuit",
    wayPoints: [
      [0, 0], [0, 20], [20, 20], [20, 50], [0, 50], [0, 100],
      [50, 100], [50, 20], [60, 20], [70, 100], [80, 100], [70, 0]
    ]
  };

  let cache = null;
  let readyPromise = null;

  function packWp(x, z, level) {
    const lv = +level >= 1 ? 1 : 0;
    return lv ? [+x, +z, 1] : [+x, +z];
  }

  function wpLevel(p) {
    if (!p) return 0;
    if (Array.isArray(p)) return +p[2] >= 1 ? 1 : 0;
    if (p.level != null) return +p.level >= 1 ? 1 : 0;
    if (p.y != null && +p.y > 1) return 1;
    return 0;
  }

  function normalizeWayPoints(input) {
    if (global.TrackLib && typeof global.TrackLib.normalizeWayPoints === "function") {
      return global.TrackLib.normalizeWayPoints(input);
    }
    if (!input) return [];
    if (Array.isArray(input)) {
      if (!input.length) return [];
      if (typeof input[0] === "number" || (Array.isArray(input[0]) && input[0].length >= 2)) {
        return input.map(p => packWp(p[0], p[1], wpLevel(p)));
      }
      return input.map(n => packWp(
        n.x != null ? n.x : n[0],
        n.z != null ? n.z : n[1],
        wpLevel(n)
      ));
    }
    if (Array.isArray(input.wayPoints)) return input.wayPoints.map(p => packWp(p[0], p[1], wpLevel(p)));
    if (Array.isArray(input.nodes)) return input.nodes.map(n => packWp(n.x, n.z, wpLevel(n)));
    return [];
  }

  function sanitizeId(id) {
    return String(id || "track").trim().replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "track";
  }

  /** True on a deployed host. Localhost / file:// stay in authoring mode. */
  function isPublicPlay() {
    const h = String((typeof location !== "undefined" && location.hostname) || "");
    return h !== "" && h !== "localhost" && h !== "127.0.0.1" && h !== "[::1]";
  }

  function readLocal() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.tracks)) return null;
      return data;
    } catch (_) {
      return null;
    }
  }

  function writeLocal(data) {
    cache = data;
    if (isPublicPlay()) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      console.warn("TracksStore: localStorage write failed", e);
    }
  }

  function cloneTrack(t) {
    return {
      id: t.id,
      name: t.name || t.id,
      wayPoints: normalizeWayPoints(t.wayPoints || []),
      updatedAt: t.updatedAt || Date.now()
    };
  }

  async function fetchBuiltinTracks() {
    const out = [];
    try {
      const r = await fetch("tracks/manifest.json", { cache: "no-store" });
      if (!r.ok) throw new Error("no manifest");
      const list = await r.json();
      if (!Array.isArray(list)) throw new Error("bad manifesto");
      for (const entry of list) {
        try {
          const file = entry.file || (entry.id + ".json");
          const tr = await fetch("tracks/" + file, { cache: "no-store" });
          if (!tr.ok) continue;
          const data = await tr.json();
          const wps = normalizeWayPoints(data);
          if (wps.length < 3) continue;
          out.push({
            id: sanitizeId(data.id || entry.id),
            name: data.name || entry.name || entry.id,
            wayPoints: wps,
            updatedAt: 0
          });
        } catch (_) { /* skip bad file */ }
      }
    } catch (_) { /* offline / file:// */ }
    if (!out.length) out.push(cloneTrack(FALLBACK));
    return out;
  }

  /** Live: files only. Local: merge file tracks into localStorage (local edits win). */
  async function sync() {
    const builtins = await fetchBuiltinTracks();
    if (isPublicPlay()) {
      cache = { tracks: builtins.map(cloneTrack) };
      return cache;
    }
    let local = readLocal();
    if (!local || !local.tracks.length) {
      local = { tracks: builtins.map(cloneTrack) };
    } else {
      const byId = new Map(local.tracks.map(t => [t.id, cloneTrack(t)]));
      for (const b of builtins) {
        if (!byId.has(b.id)) byId.set(b.id, cloneTrack(b));
      }
      local = { tracks: Array.from(byId.values()) };
    }
    writeLocal(local);
    return local;
  }

  function ready() {
    if (!readyPromise) {
      readyPromise = sync().then(data => {
        cache = data;
        return data;
      });
    }
    return readyPromise;
  }

  function list() {
    const tracks = (cache && cache.tracks) || (!isPublicPlay() && readLocal() && readLocal().tracks) || [];
    return tracks.map(cloneTrack).sort((a, b) => {
      if (a.id === "indoor") return -1;
      if (b.id === "indoor") return 1;
      return (a.name || a.id).localeCompare(b.name || b.id);
    });
  }

  function get(id) {
    const tracks = list();
    return tracks.find(t => t.id === id) || null;
  }

  function getSelectedId() {
    const url = new URLSearchParams(location.search).get("track");
    if (url) return sanitizeId(url);
    try {
      const s = localStorage.getItem(SELECTED_KEY);
      if (s) return sanitizeId(s);
    } catch (_) {}
    const tracks = list();
    return tracks.length ? tracks[0].id : FALLBACK.id;
  }

  function setSelectedId(id) {
    id = sanitizeId(id);
    try { localStorage.setItem(SELECTED_KEY, id); } catch (_) {}
    return id;
  }

  function getActive() {
    const id = getSelectedId();
    return get(id) || get("indoor") || cloneTrack(FALLBACK);
  }

  function upsert(track) {
    if (isPublicPlay()) throw new Error("Track authoring is local only");
    const id = sanitizeId(track.id);
    const wps = normalizeWayPoints(track.wayPoints || track);
    if (wps.length < 3) throw new Error("Need at least 3 wayPoints");
    const entry = {
      id,
      name: (track.name || id).trim() || id,
      wayPoints: wps,
      updatedAt: Date.now()
    };
    const data = cache || readLocal() || { tracks: [] };
    const idx = data.tracks.findIndex(t => t.id === id);
    if (idx >= 0) data.tracks[idx] = entry;
    else data.tracks.push(entry);
    writeLocal(data);
    return cloneTrack(entry);
  }

  function remove(id) {
    if (isPublicPlay()) throw new Error("Track authoring is local only");
    id = sanitizeId(id);
    const data = cache || readLocal() || { tracks: [] };
    data.tracks = data.tracks.filter(t => t.id !== id);
    if (!data.tracks.length) data.tracks.push(cloneTrack(FALLBACK));
    writeLocal(data);
    if (getSelectedId() === id) setSelectedId(data.tracks[0].id);
    return list();
  }

  function uniqueId(base) {
    base = sanitizeId(base || "custom-circuit");
    const ids = new Set(list().map(t => t.id));
    if (!ids.has(base)) return base;
    let n = 2;
    while (ids.has(base + "-" + n)) n++;
    return base + "-" + n;
  }

  global.TracksStore = {
    FALLBACK,
    isPublicPlay,
    ready,
    sync,
    list,
    get,
    getActive,
    getSelectedId,
    setSelectedId,
    upsert,
    remove,
    uniqueId,
    sanitizeId,
    normalizeWayPoints
  };
})(typeof window !== "undefined" ? window : globalThis);
