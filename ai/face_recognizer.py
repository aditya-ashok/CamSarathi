"""
Face Recognition — identify known and unknown persons.

Uses the face_recognition library (dlib-based) to:
- Detect faces in camera frames
- Compare against registered known faces
- Alert on unknown persons or log known face sightings
"""

import time
import json
import logging
from pathlib import Path

import cv2
import numpy as np
import requests

log = logging.getLogger("detector")

try:
    import face_recognition
    FACE_AVAILABLE = True
except ImportError:
    FACE_AVAILABLE = False
    log.warning("face_recognition not installed. Face detection disabled. pip install face_recognition")


FACES_DIR = Path(__file__).resolve().parent.parent / "uploads" / "faces"


class FaceRecognizer:
    """Detect and recognize faces from camera frames."""

    def __init__(self, config):
        self.config = config
        self.known_encodings = []  # list of numpy arrays
        self.known_names = []       # list of name strings
        self.known_ids = []         # list of DB IDs
        self.known_roles = []       # list of role strings
        self.last_fetch = 0
        self.fetch_interval = 60    # Refresh known faces every 60s
        self.tolerance = config.get("face_tolerance", 0.5)
        self.alert_cooldown = {}    # face_id_or_"unknown" → timestamp
        self.cooldown_seconds = config.get("cooldown_seconds", 30)

    def is_available(self):
        return FACE_AVAILABLE

    def fetch_known_faces(self):
        """Load known face encodings from the API."""
        now = time.time()
        if now - self.last_fetch < self.fetch_interval and self.known_encodings:
            return

        url = f'{self.config["server_url"]}/api/faces'
        headers = {"X-API-Key": self.config["api_key"]}
        try:
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.ok:
                faces = resp.json().get("faces", [])
                self.known_encodings = []
                self.known_names = []
                self.known_ids = []
                self.known_roles = []
                for f in faces:
                    if f.get("encoding"):
                        enc = json.loads(f["encoding"]) if isinstance(f["encoding"], str) else f["encoding"]
                        self.known_encodings.append(np.array(enc))
                        self.known_names.append(f["name"])
                        self.known_ids.append(f["id"])
                        self.known_roles.append(f.get("role", "unknown"))
                self.last_fetch = now
                log.debug(f"Loaded {len(self.known_encodings)} known faces")
        except requests.RequestException as e:
            log.debug(f"Failed to fetch known faces: {e}")

    def process_frame(self, frame, camera_id, camera_name):
        """
        Detect faces and compare to known faces.

        Returns list of recognition results:
        [{ "name": str, "role": str, "known_face_id": int|None, "confidence": float,
           "bbox": [top,right,bottom,left], "snapshot": str|None }]
        """
        if not FACE_AVAILABLE:
            return []

        self.fetch_known_faces()

        # Downscale for faster detection
        small = cv2.resize(frame, (0, 0), fx=0.5, fy=0.5)
        rgb_small = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)

        face_locations = face_recognition.face_locations(rgb_small, model="hog")
        if not face_locations:
            return []

        face_encodings = face_recognition.face_encodings(rgb_small, face_locations)
        results = []
        now = time.time()

        for i, encoding in enumerate(face_encodings):
            top, right, bottom, left = face_locations[i]
            # Scale back to original size
            top *= 2
            right *= 2
            bottom *= 2
            left *= 2

            name = "Unknown"
            role = None
            known_id = None
            confidence = 0.0

            if self.known_encodings:
                distances = face_recognition.face_distance(self.known_encodings, encoding)
                best_idx = np.argmin(distances)
                best_distance = distances[best_idx]

                if best_distance < self.tolerance:
                    name = self.known_names[best_idx]
                    role = self.known_roles[best_idx]
                    known_id = self.known_ids[best_idx]
                    confidence = round(1 - best_distance, 2)

            # Cooldown
            cooldown_key = known_id if known_id else f"unknown_{camera_id}"
            last_alert = self.alert_cooldown.get(cooldown_key, 0)
            if now - last_alert < self.cooldown_seconds:
                continue

            self.alert_cooldown[cooldown_key] = now

            # Save face crop
            snapshot_path = self._save_face_crop(frame, top, right, bottom, left, camera_id, name)

            results.append({
                "name": name,
                "role": role,
                "known_face_id": known_id,
                "confidence": confidence,
                "bbox": [top, right, bottom, left],
                "snapshot": snapshot_path,
            })

        return results

    def _save_face_crop(self, frame, top, right, bottom, left, camera_id, name):
        """Save cropped face image."""
        FACES_DIR.mkdir(parents=True, exist_ok=True)
        # Add some padding
        h, w = frame.shape[:2]
        pad = 30
        top = max(0, top - pad)
        left = max(0, left - pad)
        bottom = min(h, bottom + pad)
        right = min(w, right + pad)

        face_crop = frame[top:bottom, left:right]
        ts = int(time.time())
        safe_name = name.replace(" ", "_").lower()
        filename = f"face_cam{camera_id}_{safe_name}_{ts}.jpg"
        filepath = FACES_DIR / filename
        cv2.imwrite(str(filepath), face_crop)
        return f"/uploads/faces/{filename}"
