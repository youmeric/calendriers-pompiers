/* Opérations géométriques de l'admin (Turf) sur les secteurs.
   Format (voir Common.toPolys) : polys = [[contour, enclave, ...], ...] en [lat, lon]. */
window.Geometry = (() => {
  "use strict";

  // Rayon autour de chaque maison d'un hameau. Deux hameaux distincts sont à plus
  // de 80 m l'un de l'autre (règle des groupes d'habitations) : avec 40 m, la zone
  // d'un hameau ne peut jamais englober une maison d'un autre hameau.
  const HOUSE_RADIUS_KM = 0.04;
  const MIN_PART_M2 = 150;
  const SIMPLIFY_DEG = 0.00002; // ≈ 2 m

  function closeRing(ring) {
    const coords = ring.map(([lat, lon]) => [lon, lat]);
    const [f, l] = [coords[0], coords[coords.length - 1]];
    if (f[0] !== l[0] || f[1] !== l[1]) coords.push([f[0], f[1]]);
    return coords;
  }

  function toTurf(polys) {
    const clean = polys.filter((p) => p.length && p[0].length >= 3);
    if (!clean.length) return null;
    return turf.multiPolygon(clean.map((poly) => poly.filter((r) => r.length >= 3).map(closeRing)));
  }

  function bigEnough(ring) {
    return ring && ring.length >= 4 && turf.area(turf.polygon([ring])) >= MIN_PART_M2;
  }

  function toLatLon(ring) {
    return ring.slice(0, -1).map(([lon, lat]) => [+lat.toFixed(6), +lon.toFixed(6)]);
  }

  /** Feature Turf -> polys (petits éclats et petites enclaves supprimés). */
  function fromTurf(feature) {
    if (!feature || !feature.geometry) return [];
    let simplified = feature;
    try { simplified = turf.simplify(feature, { tolerance: SIMPLIFY_DEG, highQuality: false }); } catch { /* garde l'original */ }
    const g = simplified.geometry;
    const raw = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    const polys = [];
    for (const poly of raw) {
      if (!bigEnough(poly[0])) continue;
      polys.push([toLatLon(poly[0]), ...poly.slice(1).filter(bigEnough).map(toLatLon)]);
    }
    return polys;
  }

  /** Zone d'un hameau : union de disques autour de chacune de ses maisons. */
  function hamletShape(addresses) {
    const pts = turf.multiPoint(addresses.map((a) => [a.lon, a.lat]));
    return turf.buffer(pts, HOUSE_RADIUS_KM, { units: "kilometers", steps: 6 });
  }

  function union(parts, shape) {
    const base = toTurf(parts);
    return fromTurf(base ? turf.union(base, shape) : shape);
  }

  function difference(parts, shape) {
    const base = toTurf(parts);
    if (!base) return [];
    return fromTurf(turf.difference(base, shape));
  }

  function intersects(parts, shape) {
    const base = toTurf(parts);
    return Boolean(base) && turf.booleanIntersects(base, shape);
  }

  /** Union de deux secteurs (format polys). */
  function unionPolys(a, b) {
    const ta = toTurf(a);
    const tb = toTurf(b);
    if (!ta) return fromTurf(tb);
    if (!tb) return fromTurf(ta);
    return fromTurf(turf.union(ta, tb));
  }

  /** Côté (gauche > 0, droite < 0) d'un point [lon, lat] par rapport à une ligne [[lon, lat], ...]. */
  function sideOfLine(pt, line) {
    let best = Infinity;
    let side = 0;
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy || 1e-18;
      const t = Math.max(0, Math.min(1, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / l2));
      const d = Math.hypot(pt[0] - (ax + t * dx), pt[1] - (ay + t * dy));
      if (d < best) { best = d; side = dx * (pt[1] - ay) - dy * (pt[0] - ax); }
    }
    return side;
  }

  /** Coupe un secteur par une ligne. Renvoie [polys côté gauche, polys côté droit] ou null
      si la ligne ne traverse pas complètement le secteur. */
  function splitByLine(polys, lineLatLon) {
    const line = lineLatLon.map(([lat, lon]) => [lon, lat]);
    const cut = turf.buffer(turf.lineString(line), 0.0005, { units: "kilometers" });
    const pieces = difference(polys, cut);
    if (pieces.length < 2) return null;
    const left = [];
    const right = [];
    for (const poly of pieces) {
      const p = turf.pointOnFeature(turf.polygon(poly.map(closeRing))).geometry.coordinates;
      (sideOfLine(p, line) >= 0 ? left : right).push(poly);
    }
    if (!left.length || !right.length) return null;
    return [left, right];
  }

  // ---- Recalage des limites sur les routes ---------------------------------------

  const NOT_BOUNDARY = new Set(["footway", "path", "steps", "corridor", "cycleway", "bridleway",
    "construction", "proposed", "platform", "elevator", "via_ferrata"]);

  function segIntersection(p1, p2, p3, p4) {
    const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
    if (d === 0) return null;
    const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
    const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
    if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
    return { t, u, pt: [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])] };
  }

  /** Ajoute à toutes les lignes (routes, limite communale) les points où elles se
      croisent : la découpe en îlots exige que chaque croisement soit un point commun. */
  function nodeLines(lines) {
    const CELL = 0.003; // ≈ 250-330 m
    const grid = new Map();
    lines.forEach((line, l) => {
      for (let i = 1; i < line.length; i++) {
        const [a, b] = [line[i - 1], line[i]];
        for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++) {
          for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
            const k = `${x}:${y}`;
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(l * 1e6 + i);
          }
        }
      }
    });
    const inserts = lines.map((line) => line.map(() => []));
    const done = new Set();
    for (const segs of grid.values()) {
      for (let p = 0; p < segs.length; p++) {
        for (let q = p + 1; q < segs.length; q++) {
          const s1 = segs[p], s2 = segs[q];
          const pair = s1 < s2 ? `${s1}|${s2}` : `${s2}|${s1}`;
          if (done.has(pair)) continue;
          done.add(pair);
          const l1 = Math.floor(s1 / 1e6), i1 = s1 % 1e6, l2 = Math.floor(s2 / 1e6), i2 = s2 % 1e6;
          const hit = segIntersection(lines[l1][i1 - 1], lines[l1][i1], lines[l2][i2 - 1], lines[l2][i2]);
          if (!hit) continue;
          inserts[l1][i1].push({ k: hit.t, pt: hit.pt });
          inserts[l2][i2].push({ k: hit.u, pt: hit.pt });
        }
      }
    }
    return lines.map((line, l) => {
      const out = [line[0]];
      for (let i = 1; i < line.length; i++) {
        inserts[l][i].sort((h1, h2) => h1.k - h2.k).forEach((h) => out.push(h.pt));
        out.push(line[i]);
      }
      return out;
    });
  }

  function contourFeature(contour, addresses) {
    if (contour && (contour.type === "Polygon" || contour.type === "MultiPolygon")) return turf.feature(contour);
    // pas de contour communal : enveloppe des adresses élargie de 500 m
    const hull = turf.convex(turf.featureCollection(addresses.map((a) => turf.point([a.lon, a.lat]))));
    return turf.buffer(hull, 0.5, { units: "kilometers" });
  }

  // ---- Découpe exacte du plan en îlots (graphe planaire, demi-arêtes) ----------------
  // Coordonnées [lon, lat]. Toutes les opérations portent sur les mêmes points exacts :
  // pas d'erreur d'arrondi, contrairement aux unions de polygones.

  const kOf = (p) => `${p[0]},${p[1]}`;

  function ringArea(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
    return a / 2;
  }

  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function bboxOf(ring) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  }

  /** Point juste à gauche du plus long côté d'un cycle (= à l'intérieur de la face qu'il borde). */
  function leftPoint(ring) {
    let best = 0;
    let bestL = -1;
    for (let i = 1; i < ring.length; i++) {
      const l = Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
      if (l > bestL) { bestL = l; best = i; }
    }
    const [ax, ay] = ring[best - 1];
    const [bx, by] = ring[best];
    const off = Math.min(bestL * 0.01, 1e-6) / (bestL || 1);
    return [(ax + bx) / 2 - (by - ay) * off, (ay + by) / 2 + (bx - ax) * off];
  }

  /** Graphe planaire à partir de tronçons [[a, b], ...] déjà découpés aux croisements. */
  function planarGraph(segments) {
    const nodes = new Map();
    const node = (p) => {
      const k = kOf(p);
      if (!nodes.has(k)) nodes.set(k, { p, out: [] });
      return nodes.get(k);
    };
    const edges = [];
    for (const [a, b] of segments) {
      const na = node(a);
      const nb = node(b);
      const e1 = { from: na, to: nb, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
      const e2 = { from: nb, to: na, angle: Math.atan2(a[1] - b[1], a[0] - b[0]) };
      e1.twin = e2; e2.twin = e1;
      na.out.push(e1); nb.out.push(e2);
      edges.push(e1, e2);
    }
    for (const n of nodes.values()) {
      n.out.sort((x, y) => x.angle - y.angle);
      n.out.forEach((e, i) => { e.idx = i; });
    }
    // la face est à gauche : à l'arrivée, on prend la sortie juste avant la demi-arête de retour
    for (const e of edges) {
      const out = e.to.out;
      e.next = out[(e.twin.idx - 1 + out.length) % out.length];
    }
    return edges;
  }

  /** Faces bornées du graphe : [{outer, holes, edges}] ; chaque demi-arête reçoit e.face. */
  function extractFaces(edges) {
    const cycles = [];
    for (const e of edges) {
      if (e.cycle !== undefined) continue;
      const cycle = { edges: [], ring: [] };
      let cur = e;
      while (cur.cycle === undefined) {
        cur.cycle = cycles.length;
        cycle.edges.push(cur);
        cycle.ring.push(cur.from.p);
        cur = cur.next;
      }
      cycle.area = ringArea(cycle.ring);
      cycles.push(cycle);
    }
    const faces = [];
    for (const c of cycles) {
      if (c.area > 0) {
        c.face = { outer: c.ring, holes: [], edges: [...c.edges], area: c.area, bbox: bboxOf(c.ring) };
        faces.push(c.face);
      }
    }
    // cycles négatifs : contour extérieur d'un « îlot dans l'îlot » -> trou de la plus petite face qui le contient
    for (const c of cycles) {
      if (c.area > 0) continue;
      const [x, y] = leftPoint(c.ring);
      let owner = null;
      for (const f of faces) {
        const [x0, y0, x1, y1] = f.bbox;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        if (inRing(x, y, f.outer) && (!owner || f.area < owner.area)) owner = f;
      }
      if (owner) { owner.holes.push(c.ring); owner.edges.push(...c.edges); }
    }
    for (const f of faces) for (const e of f.edges) e.face = f;
    return faces;
  }

  function inFace(x, y, f) {
    const [x0, y0, x1, y1] = f.bbox;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    return inRing(x, y, f.outer) && !f.holes.some((h) => inRing(x, y, h));
  }

  /** Contour d'un ensemble de faces : demi-arêtes dont la face (à gauche) est dans l'ensemble
      et la face d'en face non ; chaînées en cycles, trous rattachés à leur contour. */
  function regionPolys(edges, inRegion) {
    const boundary = edges.filter((e) => inRegion(e.face) && !inRegion(e.twin.face));
    const isB = new Set(boundary);
    const used = new Set();
    const cycles = [];
    for (const e of boundary) {
      if (used.has(e)) continue;
      const ring = [];
      let cur = e;
      let guard = 0;
      while (!used.has(cur) && guard++ < 1e6) {
        used.add(cur);
        ring.push(cur.from.p);
        // à l'arrivée, on tourne depuis la demi-arête de retour jusqu'à la prochaine arête de bord
        const out = cur.to.out;
        let i = cur.twin.idx;
        let nxt = null;
        for (let step = 0; step < out.length; step++) {
          i = (i - 1 + out.length) % out.length;
          if (isB.has(out[i])) { nxt = out[i]; break; }
        }
        if (!nxt) break;
        cur = nxt;
      }
      if (ring.length >= 3) cycles.push({ ring, area: ringArea(ring) });
    }
    const outers = cycles.filter((c) => c.area > 0).map((c) => ({ ...c, holes: [], bbox: bboxOf(c.ring) }));
    for (const c of cycles) {
      if (c.area > 0) continue;
      const [x, y] = leftPoint(c.ring.slice().reverse());
      let owner = null;
      for (const o of outers) {
        if (inRing(x, y, o.ring) && (!owner || o.area < owner.area)) owner = o;
      }
      if (owner) owner.holes.push(c.ring);
    }
    const toLL = (ring) => ring.map(([x, y]) => [+y.toFixed(6), +x.toFixed(6)]);
    return outers.map((o) => [toLL(o.ring), ...o.holes.map(toLL)]);
  }

  /** Regroupe les points distants de moins de ~2 cm (sommets calculés deux fois avec
      d'infimes écarts) : sinon les lignes ne se raccordent pas et les îlots ne se ferment pas. */
  function snapper() {
    const EPS = 2e-7;
    const grid = new Map();
    return ([x, y]) => {
      const gx = Math.floor(x / EPS), gy = Math.floor(y / EPS);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const p = grid.get(`${gx + dx}:${gy + dy}`);
          if (p && Math.abs(p[0] - x) <= EPS && Math.abs(p[1] - y) <= EPS) return p;
        }
      }
      const p = [x, y];
      grid.set(`${gx}:${gy}`, p);
      return p;
    };
  }

  function uniqueSegments(lines) {
    const snap = snapper();
    const unique = new Map();
    for (const line of nodeLines(lines)) {
      for (let i = 1; i < line.length; i++) {
        const a = snap(line[i - 1]);
        const b = snap(line[i]);
        if (a[0] === b[0] && a[1] === b[1]) continue;
        const ka = kOf(a), kb = kOf(b);
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        if (!unique.has(key)) unique.set(key, [a, b]);
      }
    }
    return [...unique.values()];
  }

  function facesOf(lines, borderRings) {
    const faces = extractFaces(planarGraph(uniqueSegments(lines)));
    const edges = faces.flatMap((f) => f.edges);
    // on ne garde que les îlots situés dans la commune
    const kept = faces.filter((f) => {
      const [x, y] = leftPoint(f.outer);
      return borderRings.some((r) => inRing(x, y, r));
    });
    return { faces: kept, edges };
  }

  /**
   * Recalcule les contours de tous les secteurs pour qu'ils suivent les routes.
   * addresses : [{lat, lon, sector}] où sector = index du secteur ou null (hors secteur).
   * Renvoie un tableau (par secteur) de polys, ou null pour un secteur sans îlot.
   */
  function roadPartition({ roads, contour, addresses, nSectors }) {
    const border = contourFeature(contour, addresses);
    const g = border.geometry;
    const borderRings = (g.type === "Polygon" ? [g.coordinates] : g.coordinates).map((poly) => poly[0]);
    const lines = [
      ...roads.filter((r) => !NOT_BOUNDARY.has(r.type) && r.points.length >= 2).map((r) => r.points.map(([lat, lon]) => [lon, lat])),
      ...borderRings,
    ];
    const assigned = addresses.filter((a) => a.sector !== null);
    const sectorsIn = (f) => new Set(assigned.filter((a) => inFace(a.lon, a.lat, f)).map((a) => a.sector));

    // 1er passage : îlots routiers ; ceux qui contiennent des maisons de plusieurs secteurs
    // sont redécoupés par les lignes à mi-distance des maisons (Voronoï)
    let { faces, edges } = facesOf(lines, borderRings);
    const extra = [];
    for (const f of faces) {
      const inside = assigned.filter((a) => inFace(a.lon, a.lat, f));
      if (new Set(inside.map((a) => a.sector)).size < 2) continue;
      const pts = [];
      const seen = new Set();
      for (const a of inside) {
        const k = `${a.lon.toFixed(7)},${a.lat.toFixed(7)}`;
        if (!seen.has(k)) { seen.add(k); pts.push(turf.point([a.lon, a.lat], { sector: a.sector })); }
      }
      const [x0, y0, x1, y1] = f.bbox;
      const cells = turf.voronoi(turf.featureCollection(pts), { bbox: [x0, y0, x1, y1] });
      cells.features.forEach((cell, i) => {
        if (!cell) return;
        const ring = cell.geometry.coordinates[0];
        for (let j = 1; j < ring.length; j++) {
          const mid = [(ring[j - 1][0] + ring[j][0]) / 2, (ring[j - 1][1] + ring[j][1]) / 2];
          // ne garder que les séparations entre maisons de secteurs différents
          let nearest = null;
          let nd = Infinity;
          pts.forEach((p, k) => {
            if (k === i) return;
            const d = (p.geometry.coordinates[0] - mid[0]) ** 2 + (p.geometry.coordinates[1] - mid[1]) ** 2;
            if (d < nd) { nd = d; nearest = p; }
          });
          if (nearest && nearest.properties.sector !== pts[i].properties.sector) extra.push([ring[j - 1], ring[j]]);
        }
      });
    }
    if (extra.length) ({ faces, edges } = facesOf([...lines, ...extra], borderRings));

    // attribution des îlots
    const owner = new Map();
    const empty = [];
    for (const f of faces) {
      const inside = assigned.filter((a) => inFace(a.lon, a.lat, f));
      if (!inside.length) { empty.push(f); continue; }
      const counts = new Map();
      inside.forEach((a) => counts.set(a.sector, (counts.get(a.sector) || 0) + 1));
      owner.set(f, [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0]);
    }
    // îlots sans maison : au secteur de la maison la plus proche
    for (const f of empty) {
      if (!assigned.length) break;
      const [x, y] = leftPoint(f.outer);
      const kx = Math.cos((y * Math.PI) / 180);
      let best = assigned[0];
      let bestD = Infinity;
      for (const a of assigned) {
        const d = ((a.lon - x) * kx) ** 2 + (a.lat - y) ** 2;
        if (d < bestD) { bestD = d; best = a; }
      }
      owner.set(f, best.sector);
    }
    return Array.from({ length: nSectors }, (_, s) => {
      const polys = regionPolys(edges, (f) => f !== undefined && owner.get(f) === s);
      return polys.length ? polys : null;
    });
  }

  return { hamletShape, union, difference, intersects, unionPolys, splitByLine, roadPartition };
})();
