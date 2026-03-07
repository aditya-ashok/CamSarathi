"""
Fall Detection — YOLOv8 pose estimation to detect fallen persons.

Uses keypoint positions to calculate torso angle. If torso is near-horizontal
for 2+ consecutive frames, triggers a CRITICAL fall alert.
"""

import math
import time
import logging

log = logging.getLogger("detector")

# COCO keypoint indices
NOSE = 0
LEFT_SHOULDER = 5
RIGHT_SHOULDER = 6
LEFT_HIP = 11
RIGHT_HIP = 12
LEFT_KNEE = 13
RIGHT_KNEE = 14
LEFT_ANKLE = 15
RIGHT_ANKLE = 16


class FallDetector:
    """Detect falls using YOLOv8 pose estimation keypoints."""

    def __init__(self, pose_model, config):
        self.pose_model = pose_model
        self.config = config
        self.fall_state = {}    # person_idx → consecutive fall frames
        self.fall_threshold = 2  # frames before confirming fall
        self.angle_threshold = 45  # degrees from vertical
        self.last_alert_time = 0
        self.alert_cooldown = config.get("cooldown_seconds", 30)

    def check_falls(self, frame):
        """
        Run pose estimation and check for falls.

        Returns list of fall dicts: [{ "confidence": float, "bbox": [x1,y1,x2,y2], "angle": float }]
        """
        results = self.pose_model(frame, verbose=False, conf=0.3)

        if not results or results[0].keypoints is None:
            self.fall_state.clear()
            return []

        keypoints = results[0].keypoints
        if keypoints.xy is None or len(keypoints.xy) == 0:
            self.fall_state.clear()
            return []

        falls = []
        now = time.time()

        for i, kps in enumerate(keypoints.xy):
            kps = kps.cpu().numpy()

            # Need at least shoulders and hips
            ls = kps[LEFT_SHOULDER]
            rs = kps[RIGHT_SHOULDER]
            lh = kps[LEFT_HIP]
            rh = kps[RIGHT_HIP]

            # Skip if keypoints not detected (0,0)
            if (ls[0] == 0 and ls[1] == 0) or (rs[0] == 0 and rs[1] == 0):
                continue
            if (lh[0] == 0 and lh[1] == 0) or (rh[0] == 0 and rh[1] == 0):
                continue

            # Calculate torso midpoints
            shoulder_mid = ((ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2)
            hip_mid = ((lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2)

            # Calculate angle from vertical
            dx = hip_mid[0] - shoulder_mid[0]
            dy = hip_mid[1] - shoulder_mid[1]

            if abs(dy) < 1:  # Avoid division by zero — torso is horizontal
                angle = 90
            else:
                angle = abs(math.degrees(math.atan2(dx, dy)))

            # Also check: is hip higher than shoulders? (person upside-down/fallen)
            hip_above_shoulder = hip_mid[1] < shoulder_mid[1]

            is_fallen = angle > self.angle_threshold or hip_above_shoulder

            # Check aspect ratio of person bbox (width > height = likely fallen)
            boxes = results[0].boxes
            if i < len(boxes):
                box = boxes[i].xyxy[0].cpu().numpy()
                w = box[2] - box[0]
                h = box[3] - box[1]
                if w > 0 and h > 0:
                    aspect = w / h
                    if aspect > 1.5:  # Wider than tall
                        is_fallen = True

            if is_fallen:
                self.fall_state[i] = self.fall_state.get(i, 0) + 1
            else:
                self.fall_state[i] = 0

            # Confirm fall after threshold consecutive frames
            if self.fall_state.get(i, 0) >= self.fall_threshold:
                if now - self.last_alert_time > self.alert_cooldown:
                    self.last_alert_time = now
                    bbox = None
                    if i < len(boxes):
                        bbox = boxes[i].xyxy[0].cpu().numpy().astype(int).tolist()
                    conf = float(boxes[i].conf[0]) if i < len(boxes) else 0.8

                    falls.append({
                        "confidence": conf,
                        "bbox": bbox or [0, 0, 0, 0],
                        "angle": round(angle, 1),
                    })
                    log.warning(f"FALL DETECTED! Angle: {angle:.1f}deg, confidence: {conf:.0%}")
                    # Reset to avoid repeated alerts
                    self.fall_state[i] = 0

        # Cleanup old entries
        active_indices = set(range(len(keypoints.xy)))
        for k in list(self.fall_state.keys()):
            if k not in active_indices:
                del self.fall_state[k]

        return falls
