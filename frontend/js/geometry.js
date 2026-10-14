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

  return { hamletShape, union, difference, intersects };
})();
