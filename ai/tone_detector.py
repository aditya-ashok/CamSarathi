"""
Tone Detection — analyze employee voice tone from camera audio.

Extracts audio from RTSP stream via FFmpeg, runs SpeechBrain
emotion recognition, and alerts on angry/frustrated tones.
"""

import io
import time
import wave
import struct
import logging
import threading
import subprocess
from pathlib import Path

import numpy as np
import requests

log = logging.getLogger("detector")

AUDIO_DIR = Path(__file__).resolve().parent.parent / "uploads" / "audio"

try:
    import torchaudio
    import torch
    TORCH_AUDIO_AVAILABLE = True
except ImportError:
    TORCH_AUDIO_AVAILABLE = False

try:
    from speechbrain.inference.interfaces import foreign_class
    SPEECHBRAIN_AVAILABLE = True
except ImportError:
    SPEECHBRAIN_AVAILABLE = False
    try:
        from speechbrain.pretrained.interfaces import foreign_class
        SPEECHBRAIN_AVAILABLE = True
    except ImportError:
        pass

EMOTION_LABELS = ["angry", "happy", "neutral", "sad"]


class ToneDetector:
    """
    Extract audio from RTSP and detect voice emotions.
    Runs in a separate thread to not block video processing.
    """

    def __init__(self, camera_id, rtsp_url, camera_name, config):
        self.camera_id = camera_id
        self.rtsp_url = rtsp_url
        self.camera_name = camera_name
        self.config = config
        self.running = False
        self.thread = None
        self.model = None
        self.last_alert_time = 0
        self.cooldown = config.get("tone_cooldown_seconds", 60)
        self.buffer_seconds = config.get("tone_buffer_seconds", 4)
        self.sample_rate = 16000

    def is_available(self):
        return TORCH_AUDIO_AVAILABLE and SPEECHBRAIN_AVAILABLE

    def start(self):
        """Start audio processing in background thread."""
        if not self.is_available():
            log.warning(f"[{self.camera_name}] Tone detection unavailable (install speechbrain + torchaudio)")
            return

        self.running = True
        self.thread = threading.Thread(target=self._audio_loop, daemon=True)
        self.thread.start()
        log.info(f"[{self.camera_name}] Tone detection started")

    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join(timeout=5)

    def _load_model(self):
        """Load SpeechBrain emotion recognition model."""
        if self.model is not None:
            return

        log.info("Loading SpeechBrain emotion recognition model...")
        try:
            self.model = foreign_class(
                source="speechbrain/emotion-recognition-wav2vec2-IEMOCAP",
                pymodule_file="custom_interface.py",
                classname="CustomEncoderWav2vec2Classifier",
                savedir=str(Path(__file__).parent / "models" / "emotion"),
            )
            log.info("Emotion recognition model loaded")
        except Exception as e:
            log.error(f"Failed to load emotion model: {e}")
            self.running = False

    def _audio_loop(self):
        """Main audio processing loop."""
        self._load_model()
        if not self.model:
            return

        while self.running:
            try:
                audio_data = self._extract_audio_chunk()
                if audio_data is not None and len(audio_data) > 0:
                    emotion, confidence = self._classify_emotion(audio_data)
                    if emotion and confidence > 0.5:
                        self._handle_emotion(emotion, confidence, audio_data)
            except Exception as e:
                log.error(f"[{self.camera_name}] Tone detection error: {e}")
                time.sleep(5)

            time.sleep(0.5)  # Small pause between chunks

    def _extract_audio_chunk(self):
        """Extract audio chunk from RTSP stream using FFmpeg."""
        cmd = [
            "ffmpeg",
            "-rtsp_transport", "tcp",
            "-i", self.rtsp_url,
            "-vn",                    # no video
            "-acodec", "pcm_s16le",   # 16-bit PCM
            "-ar", str(self.sample_rate),
            "-ac", "1",               # mono
            "-t", str(self.buffer_seconds),
            "-f", "wav",
            "pipe:1",
            "-loglevel", "error",
        ]

        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=self.buffer_seconds + 10)
            if proc.returncode == 0 and len(proc.stdout) > 44:
                # Parse WAV data
                audio = np.frombuffer(proc.stdout[44:], dtype=np.int16).astype(np.float32)
                audio = audio / 32768.0  # Normalize to [-1, 1]

                # Check if there's actual audio (not silence)
                rms = np.sqrt(np.mean(audio ** 2))
                if rms < 0.01:  # Too quiet — likely silence
                    return None

                return audio
        except subprocess.TimeoutExpired:
            log.debug(f"[{self.camera_name}] Audio extraction timeout")
        except Exception as e:
            log.debug(f"[{self.camera_name}] Audio extraction error: {e}")

        return None

    def _classify_emotion(self, audio_data):
        """Run emotion classification on audio data."""
        if self.model is None:
            return None, 0.0

        try:
            # SpeechBrain expects a file path or tensor
            import torch
            signal = torch.tensor(audio_data).unsqueeze(0)

            # Classify
            out_prob, score, index, text_lab = self.model.classify_batch(signal)
            emotion = text_lab[0].lower() if text_lab else None
            confidence = float(score[0]) if score is not None else 0.0

            if emotion:
                log.debug(f"[{self.camera_name}] Tone: {emotion} ({confidence:.0%})")

            return emotion, confidence

        except Exception as e:
            log.debug(f"[{self.camera_name}] Emotion classification error: {e}")
            return None, 0.0

    def _handle_emotion(self, emotion, confidence, audio_data):
        """Process detected emotion — alert if angry/frustrated."""
        now = time.time()

        # Only alert on negative emotions
        if emotion not in ("angry", "ang"):
            return

        if now - self.last_alert_time < self.cooldown:
            return

        self.last_alert_time = now

        # Save audio clip
        audio_path = self._save_audio(audio_data)

        # Send alert to CamSarathi
        payload = {
            "camera_id": self.camera_id,
            "type": "tone_alert",
            "severity": "medium",
            "title": f"Angry tone detected — {self.camera_name}",
            "description": (
                f"Speech emotion analysis detected angry/frustrated tone "
                f"at {self.camera_name} with {confidence:.0%} confidence. "
                f"This may indicate a conflict or agitated employee."
            ),
            "ai_confidence": confidence,
            "detections": [{"emotion": emotion, "confidence": round(confidence, 2)}],
        }

        url = f'{self.config["server_url"]}/api/dashboard/ai-detection'
        headers = {"X-API-Key": self.config["api_key"], "Content-Type": "application/json"}

        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=5)
            if resp.ok:
                log.warning(f"[{self.camera_name}] TONE ALERT: {emotion} ({confidence:.0%})")
            else:
                log.error(f"[{self.camera_name}] Tone alert API error: {resp.status_code}")
        except requests.RequestException as e:
            log.error(f"[{self.camera_name}] Failed to send tone alert: {e}")

    def _save_audio(self, audio_data):
        """Save audio chunk as WAV file."""
        AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        ts = int(time.time())
        filename = f"tone_cam{self.camera_id}_{ts}.wav"
        filepath = AUDIO_DIR / filename

        try:
            with wave.open(str(filepath), "w") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(self.sample_rate)
                pcm = (audio_data * 32767).astype(np.int16)
                wf.writeframes(pcm.tobytes())
            return f"/uploads/audio/{filename}"
        except Exception:
            return None
