#!/usr/bin/env python3
"""
CamSarathi AI Detector — YOLOv8 real-time object detection from RTSP cameras.

Connects to camera RTSP streams, runs YOLOv8 inference, and sends
detection alerts to the CamSarathi Node.js backend via REST API.
"""

import os
import sys
import json
import time
import signal
import argparse
import logging
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import requests
from ultralytics import YOLO

from tracker import CentroidTracker, FootfallCounter
from zones import ZoneChecker
from fall_detector import FallDetector
from face_recognizer import FaceRecognizer
from tone_detector import ToneDetector

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("detector")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
SNAPSHOTS_DIR = PROJECT_ROOT / "uploads" / "detections"
CONFIG_PATH = SCRIPT_DIR / "config.json"

# YOLO classes that matter for home security
SECURITY_CLASSES = {
    0: "person",
    1: "bicycle",
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
    14: "bird",
    15: "cat",
    16: "dog",
    24: "backpack",
    25: "umbrella",
    26: "handbag",
    28: "suitcase",
    39: "bottle",
    56: "chair",
    62: "tv",
    63: "laptop",
    66: "keyboard",
    67: "cell phone",
}

# Map YOLO detections → CamSarathi incident types
INCIDENT_MAP = {
    "person": {"type": "motion_detected", "severity": "medium", "base_title": "Person Detected"},
    "car": {"type": "visitor", "severity": "low", "base_title": "Vehicle Detected"},
    "truck": {"type": "visitor", "severity": "low", "base_title": "Vehicle Detected"},
    "bus": {"type": "visitor", "severity": "low", "base_title": "Vehicle Detected"},
    "motorcycle": {"type": "visitor", "severity": "low", "base_title": "Vehicle Detected"},
    "bicycle": {"type": "visitor", "severity": "low", "base_title": "Vehicle Detected"},
    "dog": {"type": "unusual_behavior", "severity": "low", "base_title": "Animal Detected"},
    "cat": {"type": "unusual_behavior", "severity": "low", "base_title": "Animal Detected"},
    "bird": {"type": "unusual_behavior", "severity": "low", "base_title": "Animal Detected"},
    "backpack": {"type": "unusual_behavior", "severity": "medium", "base_title": "Bag/Backpack Detected"},
    "suitcase": {"type": "unusual_behavior", "severity": "medium", "base_title": "Suitcase Detected"},
    "handbag": {"type": "unusual_behavior", "severity": "low", "base_title": "Handbag Detected"},
    "cell phone": {"type": "unusual_behavior", "severity": "low", "base_title": "Phone Usage Detected"},
}

DEFAULT_INCIDENT = {"type": "motion_detected", "severity": "low", "base_title": "Object Detected"}

# ---------------------------------------------------------------------------
# Globals for graceful shutdown
# ---------------------------------------------------------------------------
running = True


def signal_handler(sig, frame):
    global running
    log.info("Shutting down…")
    running = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "server_url": "http://localhost:3000",
    "api_key": "camsarathi-ai-key-2024",
    "model": "yolov8n.pt",
    "confidence_threshold": 0.45,
    "frame_interval": 2.0,
    "cooldown_seconds": 30,
    "cameras": [],
}


def load_config():
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
        merged = {**DEFAULT_CONFIG, **cfg}
        return merged
    return DEFAULT_CONFIG.copy()


def save_default_config():
    """Write a starter config.json if none exists."""
    if not CONFIG_PATH.exists():
        with open(CONFIG_PATH, "w") as f:
            json.dump(DEFAULT_CONFIG, f, indent=2)
        log.info(f"Created default config at {CONFIG_PATH}")


# ---------------------------------------------------------------------------
# Detection logic
# ---------------------------------------------------------------------------


class CameraDetector:
    """Runs YOLO detection on a single RTSP camera stream."""

    def __init__(self, camera_id, rtsp_url, camera_name, config, model, pose_model=None):
        self.camera_id = camera_id
        self.rtsp_url = rtsp_url
        self.camera_name = camera_name
        self.config = config
        self.model = model
        self.cap = None
        self.last_alert_time = {}  # class_name → timestamp (cooldown tracking)
        self.consecutive_failures = 0
        self.max_failures = 10
        self.frame_count = 0

        # Feature modules
        features = config.get("features", {})
        self.tracker = CentroidTracker() if features.get("tracking", True) else None
        self.footfall = FootfallCounter() if features.get("footfall", True) else None
        self.zone_checker = ZoneChecker(config) if features.get("zones", True) else None
        self.fall_detector = FallDetector(pose_model, config) if pose_model and features.get("fall_detection", True) else None
        self.face_recognizer = FaceRecognizer(config) if features.get("face_recognition", False) else None
        self.tone_detector = None  # Started separately in main()

        # Heatmap accumulator
        self.heatmap_points = []
        self.last_heatmap_flush = time.time()

    def connect(self):
        """Open RTSP stream with OpenCV."""
        log.info(f"[{self.camera_name}] Connecting to RTSP stream…")
        self.cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if self.cap.isOpened():
            log.info(f"[{self.camera_name}] Connected successfully")
            self.consecutive_failures = 0
            return True
        log.error(f"[{self.camera_name}] Failed to connect")
        return False

    def reconnect(self):
        """Close and reopen the stream."""
        if self.cap:
            self.cap.release()
        time.sleep(2)
        return self.connect()

    def process_frame(self):
        """Grab one frame, run YOLO + tracker + zones + falls + faces + heatmap."""
        if not self.cap or not self.cap.isOpened():
            if not self.reconnect():
                self.consecutive_failures += 1
                return

        ret, frame = self.cap.read()
        if not ret:
            self.consecutive_failures += 1
            if self.consecutive_failures >= self.max_failures:
                log.warning(f"[{self.camera_name}] {self.max_failures} consecutive read failures, reconnecting…")
                self.reconnect()
                self.consecutive_failures = 0
            return

        self.consecutive_failures = 0
        self.frame_count += 1
        h, w = frame.shape[:2]

        # --- 1. Run YOLO object detection ---
        results = self.model(frame, verbose=False, conf=self.config["confidence_threshold"])

        all_detections = []
        if results and len(results[0].boxes) > 0:
            for box in results[0].boxes:
                cls_id = int(box.cls[0])
                if cls_id not in SECURITY_CLASSES:
                    continue
                class_name = SECURITY_CLASSES[cls_id]
                confidence = float(box.conf[0])
                coords = box.xyxy[0].cpu().numpy().astype(int).tolist()
                all_detections.append({
                    "class": class_name,
                    "confidence": round(confidence, 2),
                    "bbox": coords,
                })

        # --- 2. Run tracker → assign persistent IDs ---
        tracked = all_detections
        if self.tracker and all_detections:
            tracked = self.tracker.update(all_detections)

        # --- 3. Update footfall counter ---
        if self.footfall and tracked:
            self.footfall.update(tracked)

        # --- 4. Check zones → generate zone violation alerts ---
        if self.zone_checker and tracked:
            violations = self.zone_checker.check_detections(self.camera_id, tracked, w, h)
            for v in violations:
                zone = v["zone"]
                det = v["detection"]
                snapshot_path = self.save_snapshot(frame, results[0]) if results else None
                self._send_zone_alert(zone, det, v["violation"], snapshot_path)

        # --- 5. Check loitering ---
        if self.tracker:
            loiter_threshold = self.config.get("loiter_threshold_seconds", 120)
            loiterers = self.tracker.get_loiterers(loiter_threshold)
            for track_id, duration, centroid in loiterers:
                cooldown_key = f"loiter_{track_id}"
                now = time.time()
                last = self.last_alert_time.get(cooldown_key, 0)
                # Alert once per loitering event (every 2 minutes after initial)
                if now - last > loiter_threshold:
                    self.last_alert_time[cooldown_key] = now
                    if duration < 300:
                        severity = "low"
                    elif duration < 600:
                        severity = "medium"
                    else:
                        severity = "high"
                    snapshot_path = self.save_snapshot(frame, results[0]) if results else None
                    self._send_loiter_alert(track_id, duration, severity, snapshot_path)

        # --- 6. Accumulate heatmap points ---
        if self.config.get("features", {}).get("heatmap", True) and tracked:
            hour_key = datetime.now().strftime("%Y-%m-%dT%H")
            for det in tracked:
                if det.get("class") == "person":
                    bbox = det["bbox"]
                    cx = ((bbox[0] + bbox[2]) / 2) / w
                    cy = ((bbox[1] + bbox[3]) / 2) / h
                    self.heatmap_points.append({
                        "x": round(cx, 4),
                        "y": round(cy, 4),
                        "class": "person",
                        "hour": hour_key,
                    })

        # --- 7. Fall detection (every 3rd frame) ---
        if self.fall_detector and self.frame_count % 3 == 0:
            falls = self.fall_detector.check_falls(frame)
            for fall in falls:
                snapshot_path = self.save_snapshot(frame, results[0]) if results else None
                self._send_fall_alert(fall, snapshot_path)

        # --- 8. Face recognition (every 5th frame) ---
        if self.face_recognizer and self.face_recognizer.is_available() and self.frame_count % 5 == 0:
            face_results = self.face_recognizer.process_frame(frame, self.camera_id, self.camera_name)
            for fr in face_results:
                self._send_face_alert(fr)

        # --- 9. Regular detection alert (with cooldown per class) ---
        now = time.time()
        cooldown = self.config["cooldown_seconds"]
        alert_detections = []
        for det in all_detections:
            last = self.last_alert_time.get(det["class"], 0)
            if now - last >= cooldown:
                self.last_alert_time[det["class"]] = now
                alert_detections.append(det)

        if alert_detections and results:
            snapshot_path = self.save_snapshot(frame, results[0])
            self.send_alert(alert_detections, snapshot_path, frame_w=w, frame_h=h)

        # --- 10. Flush heatmap data periodically (every 5 minutes) ---
        if self.heatmap_points and time.time() - self.last_heatmap_flush > 300:
            self._flush_heatmap()

    # ----- Alert helpers for new modules -----

    def _send_zone_alert(self, zone, detection, violation, snapshot):
        """Send zone violation alert."""
        severity = "high" if zone.get("zone_type") == "restricted" else "medium"
        payload = {
            "camera_id": self.camera_id,
            "type": "unauthorized_access",
            "severity": severity,
            "title": f"Zone violation: {zone['name']} — {self.camera_name}",
            "description": (
                f"{detection.get('class', 'Person')} {violation} the "
                f"'{zone['name']}' zone ({zone.get('zone_type', 'restricted')}) "
                f"at {self.camera_name}."
            ),
            "ai_confidence": detection.get("confidence", 0.8),
            "snapshot": snapshot,
            "detections": [detection],
        }
        self._post_alert(payload)

    def _send_loiter_alert(self, track_id, duration, severity, snapshot):
        """Send loitering alert."""
        mins = int(duration // 60)
        payload = {
            "camera_id": self.camera_id,
            "type": "unusual_behavior",
            "severity": severity,
            "title": f"Loitering detected ({mins}+ min) — {self.camera_name}",
            "description": (
                f"A person (ID #{track_id}) has been stationary at {self.camera_name} "
                f"for {mins} minutes. This may indicate suspicious behavior."
            ),
            "ai_confidence": 0.85,
            "snapshot": snapshot,
            "detections": [{"class": "person", "track_id": track_id, "loiter_seconds": round(duration)}],
        }
        self._post_alert(payload)

    def _send_fall_alert(self, fall, snapshot):
        """Send critical fall detection alert."""
        payload = {
            "camera_id": self.camera_id,
            "type": "unusual_behavior",
            "severity": "critical",
            "title": f"FALL DETECTED — {self.camera_name}",
            "description": (
                f"A person appears to have fallen at {self.camera_name}. "
                f"Torso angle: {fall['angle']}° from vertical. "
                f"Confidence: {fall['confidence']:.0%}. Immediate attention may be required."
            ),
            "ai_confidence": fall["confidence"],
            "snapshot": snapshot,
            "detections": [{"class": "person", "event": "fall", "angle": fall["angle"]}],
        }
        self._post_alert(payload)

    def _send_face_alert(self, face_result):
        """Send face recognition alert and log sighting."""
        name = face_result["name"]
        known_id = face_result.get("known_face_id")
        confidence = face_result.get("confidence", 0)
        snapshot = face_result.get("snapshot")

        # Log sighting via API
        sighting_url = f'{self.config["server_url"]}/api/faces/sighting'
        headers = {"X-API-Key": self.config["api_key"], "Content-Type": "application/json"}
        try:
            requests.post(sighting_url, json={
                "camera_id": self.camera_id,
                "known_face_id": known_id,
                "snapshot": snapshot,
                "confidence": confidence,
            }, headers=headers, timeout=5)
        except requests.RequestException:
            pass

        # Only alert for unknown persons
        if name == "Unknown":
            payload = {
                "camera_id": self.camera_id,
                "type": "visitor",
                "severity": "medium",
                "title": f"Unknown person detected — {self.camera_name}",
                "description": (
                    f"An unrecognized face was detected at {self.camera_name}. "
                    f"This person does not match any registered faces."
                ),
                "ai_confidence": 0.80,
                "snapshot": snapshot,
                "detections": [{"class": "person", "event": "unknown_face"}],
            }
            self._post_alert(payload)
        else:
            log.info(f"[{self.camera_name}] Face recognized: {name} ({face_result.get('role', 'unknown')})")

    def _flush_heatmap(self):
        """Send accumulated heatmap points to API."""
        if not self.heatmap_points:
            return
        url = f'{self.config["server_url"]}/api/analytics/heatmap'
        headers = {"X-API-Key": self.config["api_key"], "Content-Type": "application/json"}
        try:
            resp = requests.post(url, json={
                "camera_id": self.camera_id,
                "points": self.heatmap_points,
            }, headers=headers, timeout=10)
            if resp.ok:
                log.debug(f"[{self.camera_name}] Flushed {len(self.heatmap_points)} heatmap points")
        except requests.RequestException as e:
            log.debug(f"[{self.camera_name}] Heatmap flush failed: {e}")
        self.heatmap_points = []
        self.last_heatmap_flush = time.time()

    def _post_alert(self, payload):
        """Generic alert POST to CamSarathi API."""
        url = f'{self.config["server_url"]}/api/dashboard/ai-detection'
        headers = {"X-API-Key": self.config["api_key"], "Content-Type": "application/json"}
        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=5)
            if resp.ok:
                log.info(f"[{self.camera_name}] Alert: {payload['title']}")
            else:
                log.error(f"[{self.camera_name}] API error {resp.status_code}: {resp.text[:200]}")
        except requests.RequestException as e:
            log.error(f"[{self.camera_name}] Failed to send alert: {e}")

    def save_snapshot(self, frame, result):
        """Save frame with YOLO bounding boxes drawn."""
        SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
        annotated = result.plot()
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"cam{self.camera_id}_{ts}.jpg"
        filepath = SNAPSHOTS_DIR / filename
        cv2.imwrite(str(filepath), annotated)
        return f"/uploads/detections/{filename}"

    def _describe_position(self, bbox, frame_w, frame_h):
        """Describe where in the frame the object is."""
        cx = (bbox[0] + bbox[2]) / 2
        cy = (bbox[1] + bbox[3]) / 2
        # Horizontal
        if cx < frame_w * 0.33:
            h_pos = "left side"
        elif cx > frame_w * 0.67:
            h_pos = "right side"
        else:
            h_pos = "center"
        # Vertical
        if cy < frame_h * 0.33:
            v_pos = "top"
        elif cy > frame_h * 0.67:
            v_pos = "bottom"
        else:
            v_pos = "middle"
        if v_pos == "middle" and h_pos == "center":
            return "center of frame"
        if v_pos == "middle":
            return h_pos
        return f"{v_pos}-{h_pos}"

    def _describe_scene(self, detections, frame_w, frame_h):
        """Build a human-readable description of what's happening."""
        classes = [d["class"] for d in detections]
        persons = [d for d in detections if d["class"] == "person"]
        objects = [d for d in detections if d["class"] != "person"]
        parts = []

        # --- Describe people ---
        if persons:
            n = len(persons)
            primary = max(persons, key=lambda d: d["confidence"])
            pos = self._describe_position(primary["bbox"], frame_w, frame_h)

            if n == 1:
                parts.append(f"1 person seen at {pos} ({primary['confidence']:.0%} confidence)")
            else:
                parts.append(f"{n} people detected, primary at {pos} ({primary['confidence']:.0%})")

            # What are they carrying / near?
            carried = []
            for obj in objects:
                if obj["class"] in ("backpack", "handbag", "suitcase"):
                    carried.append(f"carrying a {obj['class']}")
                elif obj["class"] == "cell phone":
                    carried.append("using a phone")
                elif obj["class"] == "bottle":
                    carried.append("holding a bottle")
                elif obj["class"] == "laptop":
                    carried.append("near a laptop")
            if carried:
                parts.append(", ".join(carried))

        # --- Vehicles ---
        vehicles = [d for d in detections if d["class"] in ("car", "truck", "bus", "motorcycle", "bicycle")]
        if vehicles:
            v_names = set(d["class"] for d in vehicles)
            for v in v_names:
                count = sum(1 for d in vehicles if d["class"] == v)
                best = max((d for d in vehicles if d["class"] == v), key=lambda d: d["confidence"])
                pos = self._describe_position(best["bbox"], frame_w, frame_h)
                if count == 1:
                    parts.append(f"{v} spotted at {pos}")
                else:
                    parts.append(f"{count} {v}s spotted")

        # --- Animals ---
        animals = [d for d in detections if d["class"] in ("dog", "cat", "bird")]
        if animals:
            for a_cls in set(d["class"] for d in animals):
                count = sum(1 for d in animals if d["class"] == a_cls)
                best = max((d for d in animals if d["class"] == a_cls), key=lambda d: d["confidence"])
                pos = self._describe_position(best["bbox"], frame_w, frame_h)
                parts.append(f"{a_cls} detected at {pos}" if count == 1 else f"{count} {a_cls}s detected")

        # --- Remaining objects not already mentioned ---
        mentioned = {"person", "car", "truck", "bus", "motorcycle", "bicycle", "dog", "cat", "bird",
                     "backpack", "handbag", "suitcase", "cell phone", "bottle", "laptop"}
        other = [d for d in detections if d["class"] not in mentioned]
        for d in other:
            pos = self._describe_position(d["bbox"], frame_w, frame_h)
            parts.append(f"{d['class']} at {pos}")

        return ". ".join(parts) + "." if parts else "Objects detected."

    def _build_title(self, detections):
        """Build a concise, descriptive title."""
        classes = [d["class"] for d in detections]
        persons = [d for d in detections if d["class"] == "person"]
        objects = [d for d in detections if d["class"] != "person"]

        if persons:
            n = len(persons)
            carried = [o["class"] for o in objects if o["class"] in ("backpack", "handbag", "suitcase", "cell phone")]
            if carried:
                item = carried[0].replace("cell phone", "phone")
                return f"Person with {item}" if n == 1 else f"{n} people, one with {item}"
            if any(o["class"] in ("car", "truck", "motorcycle") for o in objects):
                return f"Person near vehicle" if n == 1 else f"{n} people near vehicle"
            return f"Person detected" if n == 1 else f"{n} people detected"

        vehicles = [d for d in detections if d["class"] in ("car", "truck", "bus", "motorcycle", "bicycle")]
        if vehicles:
            return f"{vehicles[0]['class'].title()} detected"

        animals = [d for d in detections if d["class"] in ("dog", "cat", "bird")]
        if animals:
            return f"{animals[0]['class'].title()} spotted"

        return f"{detections[0]['class'].title()} detected"

    def send_alert(self, detections, snapshot_path, frame_w=1920, frame_h=1080):
        """POST detection to CamSarathi backend."""
        primary = max(detections, key=lambda d: d["confidence"])
        incident_info = INCIDENT_MAP.get(primary["class"], DEFAULT_INCIDENT)

        title = self._build_title(detections)
        description = self._describe_scene(detections, frame_w, frame_h)

        payload = {
            "camera_id": self.camera_id,
            "type": incident_info["type"],
            "severity": incident_info["severity"],
            "title": f"{title} — {self.camera_name}",
            "description": description,
            "ai_confidence": primary["confidence"],
            "snapshot": snapshot_path,
            "detections": detections,
        }

        url = f'{self.config["server_url"]}/api/dashboard/ai-detection'
        headers = {"X-API-Key": self.config["api_key"], "Content-Type": "application/json"}

        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=5)
            if resp.ok:
                log.info(
                    f"[{self.camera_name}] Alert sent: {incident_info['base_title']} "
                    f"({primary['class']} {primary['confidence']:.0%})"
                )
            else:
                log.error(f"[{self.camera_name}] API error {resp.status_code}: {resp.text[:200]}")
        except requests.RequestException as e:
            log.error(f"[{self.camera_name}] Failed to send alert: {e}")

    def release(self):
        if self.tone_detector:
            self.tone_detector.stop()
        if self.cap:
            self.cap.release()
        # Flush any remaining heatmap data
        self._flush_heatmap()


# ---------------------------------------------------------------------------
# Camera discovery from CamSarathi API
# ---------------------------------------------------------------------------


def fetch_cameras(config):
    """Get real cameras from the CamSarathi API."""
    url = f'{config["server_url"]}/api/cameras/rtsp-list'
    headers = {"X-API-Key": config["api_key"]}
    try:
        resp = requests.get(url, headers=headers, timeout=5)
        if resp.ok:
            return resp.json().get("cameras", [])
        log.error(f"Failed to fetch cameras: {resp.status_code}")
    except requests.RequestException as e:
        log.error(f"Failed to fetch cameras: {e}")
    return []


def report_footfall(detectors, config):
    """Report completed hourly footfall counts to API."""
    url = f'{config["server_url"]}/api/analytics/footfall'
    headers = {"X-API-Key": config["api_key"], "Content-Type": "application/json"}
    for det in detectors:
        if not det.footfall:
            continue
        completed = det.footfall.get_and_reset_completed_hours()
        for hour, count in completed.items():
            try:
                requests.post(url, json={
                    "camera_id": det.camera_id,
                    "hour": hour,
                    "count": count,
                }, headers=headers, timeout=5)
                log.info(f"[{det.camera_name}] Footfall: {count} unique people in hour {hour}")
            except requests.RequestException:
                pass


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="CamSarathi AI Detector")
    parser.add_argument("--config", type=str, help="Path to config.json")
    parser.add_argument("--model", type=str, help="YOLO model name (e.g. yolov8n.pt)")
    parser.add_argument("--confidence", type=float, help="Min confidence threshold")
    parser.add_argument("--interval", type=float, help="Seconds between frame captures")
    parser.add_argument("--cooldown", type=float, help="Seconds between alerts for same class")
    parser.add_argument("--rtsp", type=str, help="Direct RTSP URL (skip API camera discovery)")
    parser.add_argument("--camera-id", type=int, help="Camera ID for direct RTSP mode")
    args = parser.parse_args()

    # Load config
    if args.config:
        global CONFIG_PATH
        CONFIG_PATH = Path(args.config)
    save_default_config()
    config = load_config()

    # CLI overrides
    if args.model:
        config["model"] = args.model
    if args.confidence:
        config["confidence_threshold"] = args.confidence
    if args.interval:
        config["frame_interval"] = args.interval
    if args.cooldown:
        config["cooldown_seconds"] = args.cooldown

    features = config.get("features", {})
    log.info("=" * 50)
    log.info("CamSarathi AI Detector — YOLOv8")
    log.info("=" * 50)
    log.info(f"Model: {config['model']}")
    log.info(f"Confidence threshold: {config['confidence_threshold']}")
    log.info(f"Frame interval: {config['frame_interval']}s")
    log.info(f"Alert cooldown: {config['cooldown_seconds']}s")
    log.info(f"Server: {config['server_url']}")
    enabled = [k for k, v in features.items() if v]
    log.info(f"Features: {', '.join(enabled) if enabled else 'all defaults'}")

    # Load YOLO object detection model
    log.info(f"Loading YOLO model '{config['model']}'…")
    model = YOLO(config["model"])
    log.info("Model loaded successfully")

    # Load pose model for fall detection (optional)
    pose_model = None
    if features.get("fall_detection", True):
        pose_model_name = config.get("pose_model", "yolov8m-pose.pt")
        try:
            log.info(f"Loading pose model '{pose_model_name}' for fall detection…")
            pose_model = YOLO(pose_model_name)
            log.info("Pose model loaded successfully")
        except Exception as e:
            log.warning(f"Pose model failed to load ({e}). Fall detection disabled.")

    # Build camera list
    detectors = []
    tone_detectors = []

    def create_detector(cam_id, rtsp_url, cam_name):
        det = CameraDetector(cam_id, rtsp_url, cam_name, config, model, pose_model=pose_model)
        detectors.append(det)

        # Start tone detection thread for this camera
        if features.get("tone_detection", False):
            td = ToneDetector(cam_id, rtsp_url, cam_name, config)
            if td.is_available():
                det.tone_detector = td
                tone_detectors.append(td)

    if args.rtsp:
        cam_id = args.camera_id or 0
        create_detector(cam_id, args.rtsp, f"Camera-{cam_id}")
    elif config.get("cameras"):
        for cam in config["cameras"]:
            create_detector(cam["id"], cam["rtsp_url"], cam.get("name", f"Camera-{cam['id']}"))
    else:
        cameras = fetch_cameras(config)
        if not cameras:
            log.error("No cameras found. Add cameras via config.json or --rtsp flag.")
            sys.exit(1)
        for cam in cameras:
            create_detector(cam["id"], cam["rtsp_url"], cam.get("name", f"Camera-{cam['id']}"))

    if not detectors:
        log.error("No cameras configured. Exiting.")
        sys.exit(1)

    # Connect to all cameras
    for det in detectors:
        det.connect()

    # Start tone detection threads
    for td in tone_detectors:
        td.start()

    log.info(f"Monitoring {len(detectors)} camera(s). Press Ctrl+C to stop.")
    if tone_detectors:
        log.info(f"Tone detection active on {len(tone_detectors)} camera(s)")
    log.info("-" * 50)

    # Main detection loop
    last_footfall_report = time.time()
    while running:
        for det in detectors:
            if not running:
                break
            try:
                det.process_frame()
            except Exception as e:
                log.error(f"[{det.camera_name}] Error: {e}")

        # Report footfall every 5 minutes
        if time.time() - last_footfall_report > 300:
            report_footfall(detectors, config)
            last_footfall_report = time.time()

        time.sleep(config["frame_interval"])

    # Cleanup
    log.info("Shutting down…")
    for td in tone_detectors:
        td.stop()
    for det in detectors:
        det.release()
    log.info("Done.")


if __name__ == "__main__":
    main()
