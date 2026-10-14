"""Construction du graphe du réseau routier et calcul de distances réelles (le long des routes)."""
from __future__ import annotations

import networkx as nx
import numpy as np

from common import haversine_m

PRECISION = 6  # arrondi des coordonnées pour fusionner les nœuds partagés entre segments


def _key(lat: float, lon: float) -> tuple[float, float]:
    return (round(lat, PRECISION), round(lon, PRECISION))


def build_road_graph(roads: list[dict]) -> nx.Graph:
    """Construit un graphe non orienté à partir des segments de route OSM.

    Les routes piétonnes/carrossables sont toutes incluses (le filtrage des
    types de voies non praticables est fait côté requête Overpass).
    """
    graph = nx.Graph()
    for way in roads:
        nodes = way["nodes"]
        for (lat1, lon1), (lat2, lon2) in zip(nodes, nodes[1:]):
            k1, k2 = _key(lat1, lon1), _key(lat2, lon2)
            if k1 == k2:
                continue
            dist = haversine_m(lat1, lon1, lat2, lon2)
            if graph.has_edge(k1, k2):
                graph[k1][k2]["weight"] = min(graph[k1][k2]["weight"], dist)
            else:
                graph.add_edge(k1, k2, weight=dist)
    return graph


class RoadNetwork:
    """Index spatial simple sur les nœuds du graphe routier pour l'accrochage des adresses."""

    def __init__(self, roads: list[dict]):
        self.graph = build_road_graph(roads)
        self._nodes = list(self.graph.nodes)
        self._coords = np.array(self._nodes, dtype=float) if self._nodes else np.empty((0, 2))

    # Au-delà de cette distance, le point le plus proche du réseau est jugé
    # trop éloigné pour qu'on lui fasse confiance (trou de couverture OSM) :
    # on retombe alors sur une estimation à vol d'oiseau.
    MAX_SNAP_M = 150.0

    def nearest_node(self, lat: float, lon: float):
        if len(self._nodes) == 0:
            return None
        # approximation plate (dégrés -> mètres) suffisante à l'échelle d'une commune
        dlat = (self._coords[:, 0] - lat) * 111320.0
        dlon = (self._coords[:, 1] - lon) * 111320.0 * np.cos(np.radians(lat))
        d2 = dlat ** 2 + dlon ** 2
        idx = int(np.argmin(d2))
        return self._nodes[idx]

    def _snap_distance(self, lat: float, lon: float, node) -> float:
        return haversine_m(lat, lon, node[0], node[1])

    def distances_from(self, lat: float, lon: float, cutoff: float | None = None) -> dict:
        """Distances (mètres) le long du réseau routier depuis un point d'origine
        vers tous les nœuds du graphe atteignables (inclut le "dernier mètre"
        entre le point d'origine et son nœud d'accroche). `cutoff` limite
        l'exploration aux nœuds à moins de cette distance."""
        origin = self.nearest_node(lat, lon)
        if origin is None:
            return {}
        snap = self._snap_distance(lat, lon, origin)
        lengths = nx.single_source_dijkstra_path_length(self.graph, origin, cutoff=cutoff, weight="weight")
        return {node: dist + snap for node, dist in lengths.items()}

    def network_distance(self, lat1: float, lon1: float, lat2: float, lon2: float,
                          distances_cache: dict | None = None, node2=None) -> tuple[float, bool]:
        """Distance (mètres) entre deux points le long des routes.

        Retourne (distance, via_reseau). via_reseau=False signifie un repli en
        distance directe (points non reliés dans le graphe routier, ou point
        trop éloigné de toute route cartographiée). `node2` évite de rechercher
        à nouveau le nœud d'accroche du point d'arrivée s'il est déjà connu.
        """
        if distances_cache is not None:
            node2 = node2 if node2 is not None else self.nearest_node(lat2, lon2)
            if node2 is not None and node2 in distances_cache:
                snap2 = self._snap_distance(lat2, lon2, node2)
                if snap2 <= self.MAX_SNAP_M:
                    return distances_cache[node2] + snap2, True
        straight = haversine_m(lat1, lon1, lat2, lon2)
        return straight * 1.3, False  # 1.3 = facteur correctif usuel route/vol d'oiseau
