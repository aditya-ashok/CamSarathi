"""
Centroid Tracker — persistent object IDs across frames.

Matches detected objects between frames using nearest-centroid distance.
Tracks loitering (time in same area) and footfall (unique person count).
"""

import time
import math
import logging
from collections import OrderedDict, defaultdict
from datetime import datetime

log = logging.getLogger("detector")


class CentroidTracker:
    """Assign persistent IDs to detected objects by matching centroids."""

    def __init__(self, max_disappeared=15, max_distance=100):
        self.next_id = 0
        self.objects = OrderedDict()        # id → centroid (cx, cy)
        self.bboxes = OrderedDict()         # id → [x1,y1,x2,y2]
        self.disappeared = OrderedDict()    # id → frames since last seen
        self.max_disappeared = max_disappeared
        self.max_distance = max_distance

        # Tracking metadata
        self.first_seen = {}      # id → timestamp
        self.last_position = {}   # id → (cx, cy)
        self.stationary_since = {}  # id → timestamp when stopped moving

    def _register(self, centroid, bbox):
        self.objects[self.next_id] = centroid
        self.bboxes[self.next_id] = bbox
        self.disappeared[self.next_id] = 0
        self.first_seen[self.next_id] = time.time()
        self.last_position[self.next_id] = centroid
        self.stationary_since[self.next_id] = time.time()
        self.next_id += 1
        return self.next_id - 1

    def _deregister(self, obj_id):
        del self.objects[obj_id]
        del self.bboxes[obj_id]
        del self.disappeared[obj_id]
        self.first_seen.pop(obj_id, None)
        self.last_position.pop(obj_id, None)
        self.stationary_since.pop(obj_id, None)

    def update(self, detections):
        """
        Update tracker with new detections.

        Args:
            detections: list of dicts with 'bbox' [x1,y1,x2,y2] and 'class', 'confidence'

        Returns:
            list of dicts: same detections with 'track_id' added
        """
        if not detections:
            for obj_id in list(self.disappeared.keys()):
                self.disappeared[obj_id] += 1
                if self.disappeared[obj_id] > self.max_disappeared:
                    self._deregister(obj_id)
            return []

        # Compute centroids for new detections
        input_centroids = []
        for det in detections:
            b = det["bbox"]
            cx = (b[0] + b[2]) / 2
            cy = (b[1] + b[3]) / 2
            input_centroids.append((cx, cy))

        # If no existing objects, register all
        if len(self.objects) == 0:
            for i, det in enumerate(detections):
                tid = self._register(input_centroids[i], det["bbox"])
                det["track_id"] = tid
            return detections

        # Match existing objects to new detections
        obj_ids = list(self.objects.keys())
        obj_centroids = list(self.objects.values())

        # Distance matrix
        distances = []
        for oc in obj_centroids:
            row = []
            for ic in input_centroids:
                d = math.sqrt((oc[0] - ic[0]) ** 2 + (oc[1] - ic[1]) ** 2)
                row.append(d)
            distances.append(row)

        # Greedy assignment: closest pairs first
        used_rows = set()
        used_cols = set()
        assignments = {}

        # Flatten and sort by distance
        pairs = []
        for r in range(len(distances)):
            for c in range(len(distances[r])):
                pairs.append((distances[r][c], r, c))
        pairs.sort()

        for dist, r, c in pairs:
            if r in used_rows or c in used_cols:
                continue
            if dist > self.max_distance:
                break
            assignments[r] = c
            used_rows.add(r)
            used_cols.add(c)

        # Update matched objects
        for r, c in assignments.items():
            obj_id = obj_ids[r]
            self.objects[obj_id] = input_centroids[c]
            self.bboxes[obj_id] = detections[c]["bbox"]
            self.disappeared[obj_id] = 0
            detections[c]["track_id"] = obj_id

            # Update stationary tracking
            old_pos = self.last_position.get(obj_id, input_centroids[c])
            dist = math.sqrt((old_pos[0] - input_centroids[c][0]) ** 2 +
                             (old_pos[1] - input_centroids[c][1]) ** 2)
            if dist > 50:  # Moved significantly
                self.stationary_since[obj_id] = time.time()
            self.last_position[obj_id] = input_centroids[c]

        # Increment disappeared for unmatched existing objects
        for r in range(len(obj_ids)):
            if r not in used_rows:
                obj_id = obj_ids[r]
                self.disappeared[obj_id] += 1
                if self.disappeared[obj_id] > self.max_disappeared:
                    self._deregister(obj_id)

        # Register new detections that didn't match
        for c in range(len(input_centroids)):
            if c not in used_cols:
                tid = self._register(input_centroids[c], detections[c]["bbox"])
                detections[c]["track_id"] = tid

        return detections

    def get_loiterers(self, threshold_seconds=120):
        """Return list of (track_id, seconds_stationary) for loitering objects."""
        now = time.time()
        loiterers = []
        for obj_id, since in self.stationary_since.items():
            if obj_id in self.objects:
                duration = now - since
                if duration >= threshold_seconds:
                    loiterers.append((obj_id, duration, self.objects[obj_id]))
        return loiterers

    def get_active_count(self):
        """Return number of currently tracked objects."""
        return len(self.objects)


class FootfallCounter:
    """Count unique persons per hourly window."""

    def __init__(self):
        self.hourly_ids = defaultdict(set)  # "2026-03-06T14" → {track_id, ...}
        self.last_reported_hour = None

    def update(self, tracked_detections):
        """Record tracked person IDs for current hour."""
        hour_key = datetime.now().strftime("%Y-%m-%dT%H")
        for det in tracked_detections:
            if det.get("class") == "person" and "track_id" in det:
                self.hourly_ids[hour_key].add(det["track_id"])

    def get_current_count(self):
        """Get unique person count for current hour."""
        hour_key = datetime.now().strftime("%Y-%m-%dT%H")
        return len(self.hourly_ids[hour_key])

    def get_and_reset_completed_hours(self):
        """Return completed hour counts and clean up."""
        current_hour = datetime.now().strftime("%Y-%m-%dT%H")
        completed = {}
        for hour, ids in list(self.hourly_ids.items()):
            if hour != current_hour:
                completed[hour] = len(ids)
                del self.hourly_ids[hour]
        return completed
