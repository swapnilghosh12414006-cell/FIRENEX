import asyncio
import base64
import hashlib
import ipaddress
from io import BytesIO
import logging
import os
import re
import secrets
import socket
import smtplib
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock
from typing import Annotated, Any

import cv2
import numpy as np
from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, field_validator, model_validator
from starlette.concurrency import run_in_threadpool

import database
from events import hub
from notifications import email_is_configured, send_critical_email, send_sos_email
from notifications import send_test_email
from camera_rooms import rooms
from risk import evaluate_risk


BACKEND_DIR = Path(__file__).resolve().parent
MODEL_PATH = Path(
    os.getenv("FIRE_MODEL_PATH", str(BACKEND_DIR / "models" / "fire-smoke.pt"))
).expanduser().resolve()
MODEL_DEVICE = os.getenv("FIRE_MODEL_DEVICE", "cpu")
MAX_UPLOAD_BYTES = int(os.getenv("FIRE_MAX_UPLOAD_MB", "25")) * 1024 * 1024
MAX_VIDEO_BYTES = int(os.getenv("FIRE_MAX_VIDEO_MB", "200")) * 1024 * 1024
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "FIRE_ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]
ALLOWED_ORIGIN_REGEX = os.getenv(
    "FIRE_ALLOWED_ORIGIN_REGEX",
    r"^https?://(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$",
) or None
LOGGER = logging.getLogger("emberwatch.api")
STARTED_AT = time.monotonic()
INFERENCE_LOCK = Lock()

model: Any | None = None
model_error: str | None = None
model_name: str | None = None
DETECTION_CONFIRMATION_FRAMES = max(2, int(os.getenv("FIRE_CONFIRMATION_FRAMES", "2")))


class DetectionPersistence:
    def __init__(self) -> None:
        self._lock = Lock()
        self._runs: dict[tuple[str, str], tuple[int, float]] = {}

    def confirmed_labels(
        self,
        location: str,
        detections: list[dict[str, Any]],
        persistence_required: bool,
    ) -> set[str]:
        labels = {item["label"] for item in detections}
        if not persistence_required:
            return labels
        confirmed: set[str] = set()
        now = time.monotonic()
        with self._lock:
            for key, (_, updated_at) in list(self._runs.items()):
                if now - updated_at > 600:
                    del self._runs[key]
            for label in ("Fire", "Smoke"):
                key = (location, label)
                previous_count, _ = self._runs.get(key, (0, now))
                count = previous_count + 1 if label in labels else 0
                self._runs[key] = (count, now)
                if count >= DETECTION_CONFIRMATION_FRAMES:
                    confirmed.add(label)
            if len(self._runs) > 2000:
                oldest = sorted(self._runs, key=lambda key: self._runs[key][1])[:500]
                for key in oldest:
                    del self._runs[key]
        return confirmed


detection_persistence = DetectionPersistence()


def load_model() -> None:
    global model, model_error, model_name
    model = None
    model_name = None
    if not MODEL_PATH.is_file():
        model_error = (
            f"YOLO weights were not found at {MODEL_PATH}. "
            "Download the documented fire/smoke checkpoint or set FIRE_MODEL_PATH."
        )
        return
    try:
        from ultralytics import YOLO

        candidate = YOLO(str(MODEL_PATH))
        names = candidate.names
        class_names = names.values() if isinstance(names, dict) else names
        supported_classes = {str(name).strip().lower() for name in class_names}
        if not supported_classes.intersection({"fire", "flame", "smoke"}):
            raise ValueError(
                "The YOLO weights contain no supported classes (fire, flame, smoke)."
            )
        model = candidate
        model_name = MODEL_PATH.name
        model_error = None
    except Exception as exc:
        LOGGER.exception("Could not load YOLO model from %s", MODEL_PATH)
        model_error = f"Could not load YOLO model: {exc}"
        model = None
        model_name = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    database.initialize()
    database.clear_auth_sessions()
    load_model()
    yield


app = FastAPI(
    title="Emberwatch Fire Detection API",
    version="2.0.0",
    description="YOLO fire/smoke inference, persistent incidents, camera configuration and live updates.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "X-Sensor-Key", "X-Room-Token"],
)


class CameraCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    location: str = Field(min_length=1, max_length=120)
    device_id: str = Field(default="", max_length=512)

    @field_validator("name", "location")
    @classmethod
    def require_nonblank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field must not be blank.")
        return value


class SettingsPatch(BaseModel):
    fire_threshold: float | None = Field(default=None, ge=0.01, le=0.99)
    smoke_threshold: float | None = Field(default=None, ge=0.01, le=0.99)
    frame_interval_ms: int | None = Field(default=None, ge=500, le=15000)
    auto_logging: bool | None = None
    sound_enabled: bool | None = None
    browser_notifications: bool | None = None
    email_notifications: bool | None = None
    email_to: str | None = Field(default=None, max_length=254)

    @field_validator("email_to")
    @classmethod
    def normalize_email(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if value and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("email_to must be a valid email address.")
        return value


class SensorReading(BaseModel):
    sensor_id: str = Field(min_length=1, max_length=100)
    temperature_c: float | None = Field(default=None, ge=-80, le=150)
    carbon_monoxide_ppm: float | None = Field(default=None, ge=0, le=100000)
    smoke_ppm: float | None = Field(default=None, ge=0, le=100000)

    @field_validator("sensor_id")
    @classmethod
    def normalize_sensor_id(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("sensor_id must not be blank.")
        return value

    @model_validator(mode="after")
    def require_sensor_measurement(self) -> "SensorReading":
        if all(
            value is None
            for value in (
                self.temperature_c,
                self.carbon_monoxide_ppm,
                self.smoke_ppm,
            )
        ):
            raise ValueError("At least one sensor measurement is required.")
        return self


class EmergencyContactCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=3, max_length=254)
    phone: str = Field(default="", max_length=40)
    email_enabled: bool = False

    @field_validator("name", "email")
    @classmethod
    def require_nonblank_contact_fields(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field must not be blank.")
        return value


class SosCreate(BaseModel):
    location: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=1000)
    notify_contacts: bool = False
    contact_ids: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("location", "message")
    @classmethod
    def require_nonblank_sos_fields(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field must not be blank.")
        return value


class SosAcknowledgement(BaseModel):
    acknowledged_by: str = Field(min_length=1, max_length=100)

    @field_validator("acknowledged_by")
    @classmethod
    def require_acknowledger(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("acknowledged_by must not be blank.")
        return value


class FeedbackCreate(BaseModel):
    persona: str = Field(min_length=1, max_length=60)
    category: str = Field(min_length=1, max_length=60)
    rating: int = Field(ge=1, le=5)
    message: str = Field(min_length=1, max_length=2000)
    scenario: str = Field(default="", max_length=100)
    accessibility_mode: bool = False

    @field_validator("persona", "category", "message")
    @classmethod
    def require_nonblank_feedback_fields(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field must not be blank.")
        return value


class QrCodeCreate(BaseModel):
    value: str = Field(min_length=1, max_length=1024)

    @field_validator("value")
    @classmethod
    def require_http_url(cls, value: str) -> str:
        value = value.strip()
        if not re.match(r"^https?://[^/\s]+", value, re.IGNORECASE):
            raise ValueError("QR value must be an absolute HTTP or HTTPS URL.")
        return value


def _validate_date(value: str | None, name: str) -> str:
    if value is None or value == "":
        return ""
    try:
        return time.strftime("%Y-%m-%d", time.strptime(value, "%Y-%m-%d"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{name} must use YYYY-MM-DD.") from exc


def _origin_is_allowed(origin: str | None) -> bool:
    if not origin:
        return True
    if origin in ALLOWED_ORIGINS:
        return True
    return bool(ALLOWED_ORIGIN_REGEX and re.fullmatch(ALLOWED_ORIGIN_REGEX, origin))


AUTH_COOKIE_NAME = "emberwatch_session"
SESSION_WINDOW_SECONDS = 15 * 60
MAX_LOGIN_ATTEMPTS = 5
_login_attempts: dict[str, list[float]] = {}
_login_attempts_lock = Lock()


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)


def _admin_credentials() -> tuple[str, str] | None:
    username = os.getenv("EMBERWATCH_ADMIN_USERNAME", "").strip()
    password = os.getenv("EMBERWATCH_ADMIN_PASSWORD", "")
    if not username or len(password) < 12:
        return None
    return username, password


def _session_cookie_options(request: Request) -> tuple[int, str, bool]:
    try:
        hours = int(os.getenv("EMBERWATCH_SESSION_TTL_HOURS", "8"))
    except ValueError as exc:
        raise ValueError("EMBERWATCH_SESSION_TTL_HOURS must be an integer.") from exc
    if not 1 <= hours <= 168:
        raise ValueError("EMBERWATCH_SESSION_TTL_HOURS must be between 1 and 168.")
    same_site = os.getenv("EMBERWATCH_COOKIE_SAMESITE", "lax").strip().lower()
    if same_site not in {"lax", "strict", "none"}:
        raise ValueError("EMBERWATCH_COOKIE_SAMESITE must be lax, strict, or none.")
    secure_value = os.getenv("EMBERWATCH_COOKIE_SECURE", "").strip().lower()
    if secure_value and secure_value not in {"true", "false"}:
        raise ValueError("EMBERWATCH_COOKIE_SECURE must be true or false.")
    secure = secure_value == "true" if secure_value else request.url.scheme == "https"
    if same_site == "none" and not secure:
        raise ValueError("SameSite=None requires EMBERWATCH_COOKIE_SECURE=true.")
    return hours * 60 * 60, same_site, secure


def _session_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _session_is_valid(token: str | None) -> bool:
    return bool(
        token
        and database.has_auth_session(_session_token_hash(token), time.time())
    )


@app.middleware("http")
async def require_operator_session(request: Request, call_next: Any) -> Any:
    path = request.url.path
    if (
        not path.startswith("/api/")
        or path in {"/api/health", "/api/auth/session", "/api/auth/login", "/api/auth/logout"}
        or request.method == "OPTIONS"
        or (
            request.method == "GET"
            and re.fullmatch(r"/api/camera-rooms/[^/]+", path)
        )
    ):
        return await call_next(request)
    if (
        path == "/api/sensors"
        and request.method == "POST"
        and os.getenv("SENSOR_API_KEY")
    ):
        return await call_next(request)
    if _admin_credentials() is None:
        return JSONResponse(
            status_code=503,
            content={"detail": "Operator login is not configured. Set EMBERWATCH_ADMIN_USERNAME and EMBERWATCH_ADMIN_PASSWORD in backend\\.env."},
        )
    if not _session_is_valid(request.cookies.get(AUTH_COOKIE_NAME)):
        return JSONResponse(
            status_code=401,
            content={"detail": "Sign in to access Emberwatch."},
        )
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        if origin and not _origin_is_allowed(origin):
            return JSONResponse(
                status_code=403,
                content={"detail": "Request origin is not allowed."},
            )
    return await call_next(request)


@app.get("/api/auth/session")
def get_auth_session(request: Request) -> dict[str, Any]:
    configured = _admin_credentials() is not None
    authenticated = configured and _session_is_valid(
        request.cookies.get(AUTH_COOKIE_NAME)
    )
    return {
        "configured": configured,
        "authenticated": authenticated,
        "username": _admin_credentials()[0] if authenticated else None,
    }


@app.post("/api/auth/login")
def login(
    credentials: LoginRequest,
    request: Request,
    response: Response,
) -> dict[str, str]:
    configured = _admin_credentials()
    if configured is None:
        raise HTTPException(
            status_code=503,
            detail="Set EMBERWATCH_ADMIN_USERNAME and a password of at least 12 characters in backend\\.env.",
        )
    client_ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    with _login_attempts_lock:
        recent = [
            attempt
            for attempt in _login_attempts.get(client_ip, [])
            if now - attempt < SESSION_WINDOW_SECONDS
        ]
        _login_attempts[client_ip] = recent
        if len(recent) >= MAX_LOGIN_ATTEMPTS:
            raise HTTPException(
                status_code=429,
                detail="Too many sign-in attempts. Wait 15 minutes and try again.",
                headers={"Retry-After": str(SESSION_WINDOW_SECONDS)},
            )

    username_matches = secrets.compare_digest(
        credentials.username.encode("utf-8"), configured[0].encode("utf-8")
    )
    password_matches = secrets.compare_digest(
        credentials.password.encode("utf-8"), configured[1].encode("utf-8")
    )
    if not (username_matches and password_matches):
        with _login_attempts_lock:
            _login_attempts.setdefault(client_ip, []).append(now)
        raise HTTPException(status_code=401, detail="Username or password is incorrect.")

    try:
        ttl, same_site, secure = _session_cookie_options(request)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    token = secrets.token_urlsafe(32)
    database.create_auth_session(_session_token_hash(token), time.time() + ttl)
    with _login_attempts_lock:
        _login_attempts.pop(client_ip, None)
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=token,
        max_age=ttl,
        httponly=True,
        secure=secure,
        samesite=same_site,
        path="/api",
    )
    return {"status": "authenticated", "username": configured[0]}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response) -> dict[str, str]:
    token = request.cookies.get(AUTH_COOKIE_NAME)
    if token:
        database.delete_auth_session(_session_token_hash(token))
    response.delete_cookie(
        key=AUTH_COOKIE_NAME,
        httponly=True,
        secure=os.getenv("EMBERWATCH_COOKIE_SECURE", "").strip().lower() == "true",
        samesite=os.getenv("EMBERWATCH_COOKIE_SAMESITE", "lax").strip().lower(),
        path="/api",
    )
    return {"status": "signed_out"}


def _infer(frame: np.ndarray, fire_threshold: float, smoke_threshold: float) -> tuple[list[dict[str, Any]], float]:
    if model is None:
        raise RuntimeError(model_error or "No fire/smoke detection model is loaded.")
    if frame.ndim < 2 or frame.shape[0] == 0 or frame.shape[1] == 0:
        raise ValueError("The decoded image frame is empty.")
    started = time.perf_counter()
    with INFERENCE_LOCK:
        predictions = model.predict(
            source=frame,
            conf=min(fire_threshold, smoke_threshold),
            device=MODEL_DEVICE,
            verbose=False,
            max_det=300,
        )
    elapsed_ms = round((time.perf_counter() - started) * 1000, 1)

    prediction = predictions[0]
    names = prediction.names
    boxes = prediction.boxes
    detections: list[dict[str, Any]] = []
    height, width = frame.shape[:2]
    if boxes is None:
        return detections, elapsed_ms
    for box in boxes:
        class_id = int(box.cls.item())
        if isinstance(names, dict):
            class_name = names.get(class_id)
        else:
            class_name = names[class_id] if 0 <= class_id < len(names) else None
        if class_name is None:
            LOGGER.warning("Ignoring YOLO result with unknown class index %s.", class_id)
            continue
        raw_name = str(class_name).strip().lower()
        if raw_name not in {"fire", "flame", "smoke"}:
            continue
        confidence = float(box.conf.item())
        threshold = smoke_threshold if raw_name == "smoke" else fire_threshold
        if confidence < threshold:
            continue
        x1, y1, x2, y2 = (float(value) for value in box.xyxy[0].tolist())
        detections.append(
            {
                "label": "Smoke" if raw_name == "smoke" else "Fire",
                "confidence": round(confidence, 4),
                "box": [
                    max(0.0, min(1.0, x1 / width)),
                    max(0.0, min(1.0, y1 / height)),
                    max(0.0, min(1.0, x2 / width)),
                    max(0.0, min(1.0, y2 / height)),
                ],
            }
        )
    return detections, elapsed_ms


async def _finish_detection(
    detections: list[dict[str, Any]],
    location: str,
    inference_ms: float,
    background_tasks: BackgroundTasks,
    persistence_required: bool = False,
) -> dict[str, Any]:
    settings = database.get_settings()
    confirmed_types = detection_persistence.confirmed_labels(
        location, detections, persistence_required
    )
    confirmed_detections = [
        detection for detection in detections if detection["label"] in confirmed_types
    ]
    alerts = database.record_alerts(
        confirmed_detections,
        location,
        bool(settings["auto_logging"]),
    )
    for alert in alerts:
        await hub.broadcast({"type": "alert", "data": alert})
        if (
            alert["type"] == "Fire"
            and settings["email_notifications"]
            and settings["email_to"]
            and email_is_configured()
        ):
            background_tasks.add_task(send_critical_email, alert, settings["email_to"])
    result = {
        "detections": detections,
        "confirmed_types": sorted(confirmed_types),
        "alerts": alerts,
        "model": model_name,
        "inference_ms": inference_ms,
        "timestamp": time.time(),
        "location": location,
    }
    await hub.broadcast({"type": "detection", "data": result})
    return result


@app.get("/api/health")
def health() -> dict[str, Any]:
    try:
        database_status = "ok" if database.health_check() else "unavailable"
    except Exception:
        LOGGER.exception("Database health check failed.")
        database_status = "unavailable"
    return {
        "status": "ok" if database_status == "ok" else "degraded",
        "model_loaded": model is not None,
        "model": model_name,
        "model_error": model_error,
        "uptime_seconds": int(time.monotonic() - STARTED_AT),
        "database": database_status,
        "email_configured": email_is_configured(),
    }


def local_network_address() -> str | None:
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        address = probe.getsockname()[0]
        if not ipaddress.ip_address(address).is_loopback:
            return address
    except OSError:
        pass
    finally:
        probe.close()

    try:
        addresses = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        return None
    for address in addresses:
        candidate = address[4][0]
        parsed = ipaddress.ip_address(candidate)
        if not parsed.is_loopback and not parsed.is_link_local:
            return candidate
    return None


@app.get("/api/network-info")
def network_info(request: Request) -> dict[str, str]:
    client_host = request.client.host if request.client else ""
    try:
        is_local_request = ipaddress.ip_address(client_host).is_loopback
    except ValueError:
        is_local_request = False
    if not is_local_request:
        raise HTTPException(status_code=403, detail="Network address discovery is available only from this computer.")
    address = local_network_address()
    if address is None:
        raise HTTPException(
            status_code=503,
            detail="No local network address is available. Connect both devices to the same Wi-Fi and try again.",
        )
    return {"lan_address": address}


@app.websocket("/api/ws")
async def websocket_events(websocket: WebSocket) -> None:
    if not _origin_is_allowed(websocket.headers.get("origin")):
        await websocket.close(code=4403, reason="Origin is not allowed.")
        return
    if _admin_credentials() is None or not _session_is_valid(
        websocket.cookies.get(AUTH_COOKIE_NAME)
    ):
        await websocket.close(code=4401, reason="Sign in to access Emberwatch.")
        return
    await hub.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await hub.disconnect(websocket)


@app.post("/api/detect")
async def detect(
    background_tasks: BackgroundTasks,
    file: Annotated[UploadFile, File()],
    confidence_threshold: Annotated[float | None, Query(ge=0.01, le=0.99)] = None,
    fire_threshold: Annotated[float | None, Query(ge=0.01, le=0.99)] = None,
    smoke_threshold: Annotated[float | None, Query(ge=0.01, le=0.99)] = None,
    location: Annotated[str, Query(max_length=120)] = "Unassigned camera",
    persistence_required: Annotated[bool, Query()] = False,
) -> dict[str, Any]:
    if model is None:
        raise HTTPException(status_code=503, detail=model_error or "No model is loaded.")
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Upload a supported image frame.")
    contents = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Image exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload limit.",
        )
    if not contents:
        raise HTTPException(status_code=400, detail="The uploaded image is empty.")
    frame = cv2.imdecode(np.frombuffer(contents, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise HTTPException(status_code=400, detail="Could not decode the uploaded image.")

    settings = database.get_settings()
    fire_confidence = (
        fire_threshold
        if fire_threshold is not None
        else confidence_threshold
        if confidence_threshold is not None
        else settings["fire_threshold"]
    )
    smoke_confidence = (
        smoke_threshold
        if smoke_threshold is not None
        else confidence_threshold
        if confidence_threshold is not None
        else settings["smoke_threshold"]
    )
    try:
        detections, elapsed_ms = await run_in_threadpool(
            _infer, frame, fire_confidence, smoke_confidence
        )
    except Exception as exc:
        LOGGER.exception("YOLO inference failed for image %s", file.filename)
        raise HTTPException(status_code=500, detail="YOLO inference failed. Check backend logs for details.") from exc
    return await _finish_detection(
        detections,
        location,
        elapsed_ms,
        background_tasks,
        persistence_required,
    )


@app.post("/api/detect/video")
async def detect_video(
    background_tasks: BackgroundTasks,
    file: Annotated[UploadFile, File()],
    interval_seconds: Annotated[float, Query(ge=0.5, le=30)] = 2.5,
    fire_threshold: Annotated[float | None, Query(ge=0.01, le=0.99)] = None,
    smoke_threshold: Annotated[float | None, Query(ge=0.01, le=0.99)] = None,
    location: Annotated[str, Query(max_length=120)] = "Uploaded video",
) -> dict[str, Any]:
    if model is None:
        raise HTTPException(status_code=503, detail=model_error or "No model is loaded.")
    if not file.content_type or not file.content_type.startswith("video/"):
        raise HTTPException(status_code=415, detail="Upload a supported video file.")
    settings = database.get_settings()
    fire_confidence = fire_threshold or settings["fire_threshold"]
    smoke_confidence = smoke_threshold or settings["smoke_threshold"]
    suffix = Path(file.filename or "upload.mp4").suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
        suffix = ".mp4"
    temporary_path = ""
    capture: cv2.VideoCapture | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary:
            temporary_path = temporary.name
            size = 0
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_VIDEO_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Video exceeds the {MAX_VIDEO_BYTES // (1024 * 1024)} MB upload limit.",
                    )
                temporary.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="The uploaded video is empty.")
        capture = cv2.VideoCapture(temporary_path)
        if not capture.isOpened():
            raise HTTPException(status_code=400, detail="Could not open the uploaded video.")
        fps = capture.get(cv2.CAP_PROP_FPS)
        frame_count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
        if not fps or not frame_count:
            raise HTTPException(status_code=400, detail="Video metadata is unavailable or invalid.")

        stride = max(1, round(fps * interval_seconds))
        total_frames = int(frame_count)
        sampled_frames: list[dict[str, Any]] = []
        total_inference_ms = 0.0
        frame_index = 0
        while frame_index < total_frames and len(sampled_frames) < 300:
            capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
            ok, frame = capture.read()
            if not ok:
                break
            try:
                detections, elapsed_ms = await run_in_threadpool(
                    _infer, frame, fire_confidence, smoke_confidence
                )
            except Exception as exc:
                LOGGER.exception("YOLO inference failed for uploaded video %s", file.filename)
                raise HTTPException(status_code=500, detail="YOLO inference failed. Check backend logs for details.") from exc
            frame_result = await _finish_detection(
                detections,
                location,
                elapsed_ms,
                background_tasks,
                persistence_required=True,
            )
            frame_result["frame_seconds"] = round(frame_index / fps, 2)
            sampled_frames.append(frame_result)
            total_inference_ms += elapsed_ms
            frame_index += stride
        return {
            "model": model_name,
            "frames_analyzed": len(sampled_frames),
            "video_duration_seconds": round(total_frames / fps, 2),
            "total_inference_ms": round(total_inference_ms, 1),
            "sampled_frames": sampled_frames,
            "truncated": frame_index < total_frames,
        }
    finally:
        if capture is not None:
            capture.release()
        if temporary_path and os.path.exists(temporary_path):
            try:
                os.unlink(temporary_path)
            except OSError:
                LOGGER.exception("Could not remove temporary video file %s.", temporary_path)
        await file.close()


@app.get("/api/alerts")
def get_alerts(
    search: Annotated[str, Query(max_length=200)] = "",
    alert_type: Annotated[str, Query(alias="type")] = "",
    severity: Annotated[str, Query()] = "",
    date_from: Annotated[str | None, Query()] = None,
    date_to: Annotated[str | None, Query()] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> dict[str, Any]:
    if alert_type not in {"", "Fire", "Smoke"}:
        raise HTTPException(status_code=422, detail="type must be Fire or Smoke.")
    if severity not in {"", "Critical", "Warning"}:
        raise HTTPException(status_code=422, detail="severity must be Critical or Warning.")
    return database.list_alerts(
        search=search,
        alert_type=alert_type,
        severity=severity,
        date_from=_validate_date(date_from, "date_from"),
        date_to=_validate_date(date_to, "date_to"),
        page=page,
        page_size=page_size,
    ) | {"counts": database.alert_counts()}


@app.patch("/api/alerts/{alert_id}/acknowledge")
async def acknowledge_alert(alert_id: str) -> dict[str, Any]:
    alert = database.acknowledge_alert(alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found.")
    await hub.broadcast({"type": "alert_updated", "data": alert})
    return alert


@app.delete("/api/alerts")
async def delete_alerts(
    confirm: Annotated[bool, Query()] = False,
) -> dict[str, int]:
    if not confirm:
        raise HTTPException(status_code=400, detail="Pass confirm=true to delete alert history.")
    deleted = database.clear_alerts()
    await hub.broadcast({"type": "alerts_cleared", "data": {"deleted": deleted}})
    return {"deleted": deleted}


@app.get("/api/cameras")
def get_cameras() -> dict[str, Any]:
    return {"items": database.list_cameras()}


@app.post("/api/cameras", status_code=201)
async def create_camera(camera: CameraCreate) -> dict[str, Any]:
    created = database.add_camera(
        camera.name.strip(),
        camera.location.strip(),
        camera.device_id,
    )
    await hub.broadcast({"type": "camera_added", "data": created})
    return created


@app.delete("/api/cameras/{camera_id}")
async def remove_camera(camera_id: str) -> dict[str, str]:
    if not database.delete_camera(camera_id):
        raise HTTPException(status_code=404, detail="Camera configuration not found.")
    await hub.broadcast({"type": "camera_removed", "data": {"id": camera_id}})
    return {"status": "deleted"}


@app.get("/api/settings")
def get_settings() -> dict[str, Any]:
    return {
        **database.get_settings(),
        "email_configured": email_is_configured(),
        "model_device": MODEL_DEVICE,
    }


@app.patch("/api/settings")
async def patch_settings(settings: SettingsPatch) -> dict[str, Any]:
    values = settings.model_dump(exclude_unset=True)
    effective_settings = {**database.get_settings(), **values}
    if effective_settings["email_notifications"] and not effective_settings["email_to"]:
        raise HTTPException(
            status_code=422,
            detail="Set email_to before enabling email notifications.",
        )
    if effective_settings["email_notifications"] and not email_is_configured():
        raise HTTPException(
            status_code=503,
            detail="Configure SMTP_HOST and SMTP_FROM in backend\\.env before enabling email notifications.",
        )
    updated = database.update_settings(values)
    response = {
        **updated,
        "email_configured": email_is_configured(),
        "model_device": MODEL_DEVICE,
    }
    await hub.broadcast({"type": "settings_updated", "data": response})
    return response


@app.post("/api/settings/email/test")
async def send_email_test() -> dict[str, str]:
    if not email_is_configured():
        raise HTTPException(
            status_code=503,
            detail="Configure a valid TLS SMTP relay in backend\\.env before sending a test email.",
        )
    recipient = database.get_settings()["email_to"]
    if not recipient:
        raise HTTPException(
            status_code=422,
            detail="Save a critical-alert recipient before sending a test email.",
        )
    try:
        await send_test_email(recipient)
    except (OSError, RuntimeError, ValueError, smtplib.SMTPException) as exc:
        LOGGER.exception("SMTP test delivery failed.")
        raise HTTPException(
            status_code=502,
            detail="SMTP could not send the test message. Check the backend logs and SMTP settings.",
        ) from exc
    return {"status": "sent", "recipient": recipient}


@app.get("/api/analytics")
def get_analytics(days: Annotated[int, Query(ge=1, le=365)] = 30) -> dict[str, Any]:
    return database.analytics(days)


@app.get("/api/sensors")
def get_sensor_readings(
    limit: Annotated[int, Query(ge=1, le=500)] = 60,
) -> dict[str, Any]:
    return {"items": database.latest_sensor_readings(limit)}


@app.post("/api/sensors", status_code=201)
async def ingest_sensor_reading(
    reading: SensorReading,
    sensor_key: Annotated[str | None, Header(alias="X-Sensor-Key")] = None,
) -> dict[str, Any]:
    expected_key = os.getenv("SENSOR_API_KEY")
    if expected_key and (
        sensor_key is None or not secrets.compare_digest(sensor_key, expected_key)
    ):
        raise HTTPException(status_code=401, detail="Invalid sensor API key.")
    saved = database.save_sensor_reading(
        reading.sensor_id,
        reading.temperature_c,
        reading.carbon_monoxide_ppm,
        reading.smoke_ppm,
    )
    await hub.broadcast({"type": "sensor_reading", "data": saved})
    return saved


@app.get("/api/risk")
def get_risk_assessment() -> dict[str, Any]:
    return evaluate_risk(database.recent_risk_inputs())


@app.get("/api/emergency/contacts")
def get_emergency_contacts() -> dict[str, Any]:
    return {"items": database.list_emergency_contacts()}


@app.post("/api/emergency/contacts", status_code=201)
def create_emergency_contact(contact: EmergencyContactCreate) -> dict[str, Any]:
    name = contact.name.strip()
    email = contact.email.strip()
    if not name or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise HTTPException(status_code=422, detail="Provide a name and a valid email address.")
    return database.add_emergency_contact(
        name,
        email,
        contact.phone.strip(),
        contact.email_enabled,
    )


@app.delete("/api/emergency/contacts/{contact_id}")
def delete_emergency_contact(contact_id: str) -> dict[str, str]:
    if not database.delete_emergency_contact(contact_id):
        raise HTTPException(status_code=404, detail="Emergency contact not found.")
    return {"status": "deleted"}


@app.get("/api/emergency/sos")
def get_sos_requests() -> dict[str, Any]:
    return {"items": database.list_sos_requests()}


@app.post("/api/emergency/sos", status_code=201)
async def create_sos_request(
    request: SosCreate,
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    location = request.location.strip()
    message = request.message.strip()
    if not location or not message:
        raise HTTPException(status_code=422, detail="Location and emergency message are required.")

    recipients: list[dict[str, Any]] = []
    if request.notify_contacts:
        if not email_is_configured():
            raise HTTPException(
                status_code=503,
                detail="Email delivery is not configured. Configure SMTP before requesting external notifications.",
            )
        if not request.contact_ids:
            raise HTTPException(
                status_code=422,
                detail="Select at least one email-enabled contact before requesting notification.",
            )
        recipients = database.contacts_for_email(request.contact_ids)
        if len(recipients) != len(set(request.contact_ids)):
            raise HTTPException(
                status_code=422,
                detail="Every selected contact must exist and have email notification enabled.",
            )

    incident = database.create_sos_request(
        location,
        message,
        request.notify_contacts,
        len(recipients),
    )
    for recipient in recipients:
        background_tasks.add_task(send_sos_email, incident, recipient["email"])
    await hub.broadcast({"type": "emergency_sos", "data": incident})
    return incident


@app.patch("/api/emergency/sos/{incident_id}/acknowledge")
async def acknowledge_sos_request(
    incident_id: str,
    acknowledgement: SosAcknowledgement,
) -> dict[str, Any]:
    incident = database.acknowledge_sos_request(
        incident_id, acknowledgement.acknowledged_by.strip()
    )
    if incident is None:
        raise HTTPException(status_code=404, detail="SOS request not found.")
    await hub.broadcast({"type": "emergency_sos_updated", "data": incident})
    return incident


@app.post("/api/feedback", status_code=201)
async def submit_feedback(feedback: FeedbackCreate) -> dict[str, Any]:
    saved = database.add_feedback(
        feedback.persona.strip(),
        feedback.category.strip(),
        feedback.rating,
        feedback.message.strip(),
        feedback.scenario.strip(),
        feedback.accessibility_mode,
    )
    await hub.broadcast({"type": "feedback_submitted"})
    return saved


@app.get("/api/feedback")
def get_feedback(limit: Annotated[int, Query(ge=1, le=200)] = 100) -> dict[str, Any]:
    return {"items": database.list_feedback(limit)}


@app.get("/api/feedback/summary")
def get_feedback_summary() -> dict[str, Any]:
    return database.feedback_summary()


@app.post("/api/camera-rooms", status_code=201)
async def create_camera_room() -> dict[str, Any]:
    try:
        return await rooms.create()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/api/camera-rooms/qr")
def create_camera_room_qr(request: QrCodeCreate) -> dict[str, str]:
    try:
        import qrcode
        from qrcode.constants import ERROR_CORRECT_M

        code = qrcode.QRCode(
            version=None,
            error_correction=ERROR_CORRECT_M,
            box_size=7,
            border=4,
        )
        code.add_data(request.value)
        code.make(fit=True)
        image = code.make_image(fill_color="black", back_color="white")
        output = BytesIO()
        image.save(output, format="PNG")
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="QR generation is unavailable. Install backend requirements.",
        ) from exc
    except Exception as exc:
        LOGGER.exception("Could not encode a camera pairing QR code.")
        raise HTTPException(status_code=422, detail="Could not encode the pairing link as a QR code.") from exc
    return {"image_data": base64.b64encode(output.getvalue()).decode("ascii")}


@app.delete("/api/camera-rooms/{room_id}")
async def delete_camera_room(
    room_id: str,
    room_token: Annotated[str, Header(alias="X-Room-Token")],
) -> dict[str, str]:
    if not await rooms.close(room_id, room_token):
        raise HTTPException(status_code=404, detail="Camera room expired or owner token is invalid.")
    return {"status": "closed"}


@app.get("/api/camera-rooms/{room_id}")
async def get_camera_room_configuration(
    room_id: str,
    room_token: Annotated[str, Header(alias="X-Room-Token")],
) -> dict[str, Any]:
    configuration = await rooms.viewer_configuration(room_id, room_token)
    if configuration is None:
        raise HTTPException(status_code=404, detail="Camera room expired or viewer token is invalid.")
    return configuration


@app.websocket("/api/camera-rooms/{room_id}/ws")
async def camera_room_signaling(websocket: WebSocket, room_id: str) -> None:
    if not _origin_is_allowed(websocket.headers.get("origin")):
        await websocket.close(code=4403, reason="Origin is not allowed.")
        return
    await rooms.serve(websocket, room_id)
