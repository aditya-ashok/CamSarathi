"""
Zone Detection — check if objects are inside user-defined polygon zones.

Zones are defined as normalized polygons (0-1 coordinates) stored in the DB.
The detector loads zones from the API and checks detections against them.
"""

import time
import logging
import requests

log = logging.getLogger("detector")


def point_in_polygon(px, py, polygon):
    """Ray casting algorithm to check if point (px,py) is inside polygon."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


class ZoneChecker:
    """Load zones from API and check detections against them."""

    def __init__(self, config):
        self.config = config
        self.zones = {}  # camera_id → [zone_dicts]
        self.last_fetch = 0
        self.fetch_interval = 30  # Refresh zones every 30s
        self.alert_cooldown = {}  # (zone_id, track_id) → timestamp

    def fetch_zones(self, camera_id):
        """Load zones for a camera from the API."""
        now = time.time()
        if now - self.last_fetch < self.fetch_interval and camera_id in self.zones:
            return self.zones.get(camera_id, [])

        url = f'{self.config["server_url"]}/api/zones/{camera_id}'
        headers = {"X-API-Key": self.config["api_key"]}
        try:
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.ok:
                zones = resp.json().get("zones", [])
                self.zones[camera_id] = zones
                self.last_fetch = now
                return zones
        except requests.RequestException as e:
            log.debug(f"Failed to fetch zones: {e}")
        return self.zones.get(camera_id, [])

    def check_detections(self, camera_id, tracked_detections, frame_w, frame_h):
        """
        Check tracked detections against zones.

        Returns list of zone violation dicts:
        [{ "zone": zone_dict, "detection": det, "violation": "entered"/"inside" }]
        """
        zones = self.fetch_zones(camera_id)
        if not zones:
            return []

        violations = []
        now = time.time()

        for det in tracked_detections:
            if "track_id" not in det:
                continue

            bbox = det["bbox"]
            # Use bottom-center of bbox (feet position) for zone checking
            cx = ((bbox[0] + bbox[2]) / 2) / frame_w
            cy = bbox[3] / frame_h  # bottom of bbox

            for zone in zones:
                if not zone.get("active", True):
                    continue

                import json
                polygon = json.loads(zone["polygon"]) if isinstance(zone["polygon"], str) else zone["polygon"]
                inside = point_in_polygon(cx, cy, polygon)

                zone_id = zone["id"]
                track_id = det.get("track_id", -1)
                cooldown_key = (zone_id, track_id)

                if inside and zone.get("alert_on") in ("enter", "loiter"):
                    # Cooldown per zone+track pair
                    last_alert = self.alert_cooldown.get(cooldown_key, 0)
                    if now - last_alert > self.config.get("cooldown_seconds", 30):
                        self.alert_cooldown[cooldown_key] = now
                        violations.append({
                            "zone": zone,
                            "detection": det,
                            "violation": "entered",
                        })

                elif not inside and zone.get("alert_on") == "exit":
                    last_alert = self.alert_cooldown.get(cooldown_key, 0)
                    if now - last_alert > self.config.get("cooldown_seconds", 30):
                        self.alert_cooldown[cooldown_key] = now
                        violations.append({
                            "zone": zone,
                            "detection": det,
                            "violation": "exited",
                        })

        return violations

    def count_in_zone(self, camera_id, zone_id, tracked_detections, frame_w, frame_h):
        """Count how many persons are currently inside a specific zone."""
        zones = self.zones.get(camera_id, [])
        zone = next((z for z in zones if z["id"] == zone_id), None)
        if not zone:
            return 0

        import json
        polygon = json.loads(zone["polygon"]) if isinstance(zone["polygon"], str) else zone["polygon"]
        count = 0
        for det in tracked_detections:
            if det.get("class") != "person":
                continue
            bbox = det["bbox"]
            cx = ((bbox[0] + bbox[2]) / 2) / frame_w
            cy = bbox[3] / frame_h
            if point_in_polygon(cx, cy, polygon):
                count += 1
        return count
