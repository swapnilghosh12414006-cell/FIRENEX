import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


BACKEND_DIR = Path(__file__).resolve().parent
DATABASE_PATH = Path(
    os.getenv("EMBERWATCH_DATABASE", str(BACKEND_DIR / "data" / "emberwatch.sqlite3"))
).expanduser().resolve()
LOCK = threading.RLock()

DEFAULT_SETTINGS: dict[str, Any] = {
    "fire_threshold": 0.45,
    "smoke_threshold": 0.45,
    "frame_interval_ms": 2500,
    "auto_logging": True,
    "sound_enabled": True,
    "browser_notifications": False,
    "email_notifications": False,
    "email_to": "",
}


def _connect() -> sqlite3.Connection:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 15000")
    return connection


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    connection = _connect()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _dict_rows(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(row) for row in rows]


def initialize() -> None:
    with LOCK, _connection() as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS alerts (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('Fire', 'Smoke')),
                location TEXT NOT NULL,
                confidence REAL NOT NULL,
                risk TEXT NOT NULL CHECK(risk IN ('Critical', 'Warning')),
                action TEXT NOT NULL DEFAULT 'Not recorded',
                acknowledged INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_alerts_type_timestamp ON alerts(type, timestamp DESC);
            CREATE TABLE IF NOT EXISTS cameras (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                location TEXT NOT NULL,
                device_id TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash TEXT PRIMARY KEY,
                expires_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
                ON auth_sessions(expires_at);
            CREATE TABLE IF NOT EXISTS sensor_readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sensor_id TEXT NOT NULL,
                temperature_c REAL,
                carbon_monoxide_ppm REAL,
                smoke_ppm REAL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sensor_readings_time
                ON sensor_readings(created_at DESC);
            CREATE TABLE IF NOT EXISTS emergency_contacts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                phone TEXT NOT NULL DEFAULT '',
                email_enabled INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sos_requests (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                location TEXT NOT NULL,
                message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open'
                    CHECK(status IN ('open', 'acknowledged')),
                email_requested INTEGER NOT NULL DEFAULT 0,
                emails_queued INTEGER NOT NULL DEFAULT 0,
                acknowledged_by TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_sos_timestamp ON sos_requests(timestamp DESC);
            CREATE TABLE IF NOT EXISTS user_feedback (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                persona TEXT NOT NULL,
                category TEXT NOT NULL,
                rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
                message TEXT NOT NULL,
                scenario TEXT NOT NULL DEFAULT '',
                accessibility_mode INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_feedback_timestamp ON user_feedback(timestamp DESC);
            """
        )
        for key, value in DEFAULT_SETTINGS.items():
            connection.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
                (key, json.dumps(value)),
            )


def health_check() -> bool:
    with LOCK, _connection() as connection:
        connection.execute("SELECT 1").fetchone()
    return True


def create_auth_session(token_hash: str, expires_at: float) -> None:
    with LOCK, _connection() as connection:
        connection.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (time.time(),))
        connection.execute(
            "INSERT INTO auth_sessions(token_hash, expires_at) VALUES (?, ?)",
            (token_hash, expires_at),
        )


def clear_auth_sessions() -> None:
    with LOCK, _connection() as connection:
        connection.execute("DELETE FROM auth_sessions")


def has_auth_session(token_hash: str, now: float) -> bool:
    with LOCK, _connection() as connection:
        connection.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (now,))
        row = connection.execute(
            "SELECT 1 FROM auth_sessions WHERE token_hash = ? AND expires_at > ?",
            (token_hash, now),
        ).fetchone()
    return row is not None


def delete_auth_session(token_hash: str) -> None:
    with LOCK, _connection() as connection:
        connection.execute(
            "DELETE FROM auth_sessions WHERE token_hash = ?", (token_hash,)
        )


def get_settings() -> dict[str, Any]:
    with LOCK, _connection() as connection:
        settings = DEFAULT_SETTINGS.copy()
        for row in connection.execute("SELECT key, value FROM settings"):
            settings[row["key"]] = json.loads(row["value"])
        return settings


def update_settings(values: dict[str, Any]) -> dict[str, Any]:
    with LOCK, _connection() as connection:
        for key, value in values.items():
            connection.execute(
                """
                INSERT INTO settings(key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, json.dumps(value)),
            )
    return get_settings()


def record_alerts(
    detections: list[dict[str, Any]],
    location: str,
    auto_logging: bool,
) -> list[dict[str, Any]]:
    if not auto_logging or not detections:
        return []

    created: list[dict[str, Any]] = []
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(seconds=30)).isoformat()
    with LOCK, _connection() as connection:
        for detection in detections:
            alert_type = detection["label"]
            existing = connection.execute(
                """
                SELECT id FROM alerts
                WHERE type = ? AND location = ? AND timestamp >= ?
                LIMIT 1
                """,
                (alert_type, location, cutoff),
            ).fetchone()
            if existing:
                continue
            risk = "Critical" if alert_type == "Fire" else "Warning"
            alert = {
                "id": str(uuid.uuid4()),
                "timestamp": now.isoformat(timespec="milliseconds"),
                "type": alert_type,
                "location": location,
                "confidence": detection["confidence"],
                "risk": risk,
                "action": "Not recorded",
                "acknowledged": False,
            }
            connection.execute(
                """
                INSERT INTO alerts(id, timestamp, type, location, confidence, risk, action)
                VALUES (:id, :timestamp, :type, :location, :confidence, :risk, :action)
                """,
                alert,
            )
            created.append(alert)
    return created


def list_alerts(
    *,
    search: str = "",
    alert_type: str = "",
    severity: str = "",
    date_from: str = "",
    date_to: str = "",
    page: int = 1,
    page_size: int = 20,
) -> dict[str, Any]:
    clauses: list[str] = []
    params: list[Any] = []
    if alert_type:
        clauses.append("type = ?")
        params.append(alert_type)
    if severity:
        clauses.append("risk = ?")
        params.append(severity)
    if date_from:
        clauses.append("date(timestamp) >= date(?)")
        params.append(date_from)
    if date_to:
        clauses.append("date(timestamp) <= date(?)")
        params.append(date_to)
    if search:
        clauses.append("(location LIKE ? OR type LIKE ? OR risk LIKE ? OR action LIKE ?)")
        params.extend([f"%{search}%"] * 4)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    offset = (page - 1) * page_size
    with LOCK, _connection() as connection:
        total = connection.execute(
            f"SELECT COUNT(*) FROM alerts {where}", params
        ).fetchone()[0]
        rows = connection.execute(
            f"""
            SELECT id, timestamp, type, location, confidence, risk, action, acknowledged
            FROM alerts {where}
            ORDER BY timestamp DESC, id DESC
            LIMIT ? OFFSET ?
            """,
            [*params, page_size, offset],
        ).fetchall()
    items = _dict_rows(rows)
    for item in items:
        item["acknowledged"] = bool(item["acknowledged"])
    return {"items": items, "total": total, "page": page, "page_size": page_size}


def alert_counts() -> dict[str, int]:
    with LOCK, _connection() as connection:
        rows = connection.execute(
            "SELECT type, risk, COUNT(*) AS count FROM alerts GROUP BY type, risk"
        ).fetchall()
    counts = {"total": 0, "fire": 0, "smoke": 0, "critical": 0}
    for row in rows:
        counts["total"] += row["count"]
        counts["fire" if row["type"] == "Fire" else "smoke"] += row["count"]
        if row["risk"] == "Critical":
            counts["critical"] += row["count"]
    return counts


def acknowledge_alert(alert_id: str) -> dict[str, Any] | None:
    action = f"Acknowledged · {datetime.now().astimezone().isoformat(timespec='seconds')}"
    with LOCK, _connection() as connection:
        connection.execute(
            "UPDATE alerts SET acknowledged = 1, action = ? WHERE id = ?",
            (action, alert_id),
        )
        row = connection.execute(
            """
            SELECT id, timestamp, type, location, confidence, risk, action, acknowledged
            FROM alerts WHERE id = ?
            """,
            (alert_id,),
        ).fetchone()
    if row is None:
        return None
    result = dict(row)
    result["acknowledged"] = bool(result["acknowledged"])
    return result


def clear_alerts() -> int:
    with LOCK, _connection() as connection:
        return connection.execute("DELETE FROM alerts").rowcount


def add_camera(name: str, location: str, device_id: str) -> dict[str, Any]:
    camera = {
        "id": str(uuid.uuid4()),
        "name": name,
        "location": location,
        "device_id": device_id,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    with LOCK, _connection() as connection:
        connection.execute(
            """
            INSERT INTO cameras(id, name, location, device_id, created_at)
            VALUES (:id, :name, :location, :device_id, :created_at)
            """,
            camera,
        )
    return camera


def list_cameras() -> list[dict[str, Any]]:
    with LOCK, _connection() as connection:
        return _dict_rows(
            connection.execute(
                "SELECT id, name, location, device_id, created_at FROM cameras ORDER BY created_at"
            ).fetchall()
        )


def delete_camera(camera_id: str) -> bool:
    with LOCK, _connection() as connection:
        cursor = connection.execute("DELETE FROM cameras WHERE id = ?", (camera_id,))
        return cursor.rowcount > 0


def save_sensor_reading(
    sensor_id: str,
    temperature_c: float | None,
    carbon_monoxide_ppm: float | None,
    smoke_ppm: float | None,
) -> dict[str, Any]:
    reading = {
        "sensor_id": sensor_id,
        "temperature_c": temperature_c,
        "carbon_monoxide_ppm": carbon_monoxide_ppm,
        "smoke_ppm": smoke_ppm,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
    }
    with LOCK, _connection() as connection:
        cursor = connection.execute(
            """
            INSERT INTO sensor_readings(
                sensor_id, temperature_c, carbon_monoxide_ppm, smoke_ppm, created_at
            ) VALUES (
                :sensor_id, :temperature_c, :carbon_monoxide_ppm, :smoke_ppm, :created_at
            )
            """,
            reading,
        )
        reading["id"] = cursor.lastrowid
    return reading


def latest_sensor_readings(limit: int = 60) -> list[dict[str, Any]]:
    with LOCK, _connection() as connection:
        return _dict_rows(
            connection.execute(
                """
                SELECT id, sensor_id, temperature_c, carbon_monoxide_ppm, smoke_ppm, created_at
                FROM sensor_readings ORDER BY created_at DESC LIMIT ?
                """,
                (limit,),
            ).fetchall()
        )


def analytics(days: int = 30) -> dict[str, Any]:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days - 1)).date().isoformat()
    with LOCK, _connection() as connection:
        rows = connection.execute(
            """
            SELECT date(timestamp) AS day, type, risk,
                   COUNT(*) AS count, AVG(confidence) AS average_confidence
            FROM alerts WHERE date(timestamp) >= date(?)
            GROUP BY date(timestamp), type, risk ORDER BY day
            """,
            (cutoff,),
        ).fetchall()
        average_confidence = connection.execute(
            "SELECT AVG(confidence) FROM alerts WHERE date(timestamp) >= date(?)",
            (cutoff,),
        ).fetchone()[0]

    by_day: dict[str, dict[str, Any]] = {}
    for row in rows:
        entry = by_day.setdefault(
            row["day"], {"date": row["day"], "fire": 0, "smoke": 0, "critical": 0, "warning": 0}
        )
        entry["fire" if row["type"] == "Fire" else "smoke"] += row["count"]
        entry["critical" if row["risk"] == "Critical" else "warning"] += row["count"]
    return {
        "days": days,
        "counts": alert_counts(),
        "series": list(by_day.values()),
        "average_confidence": (
            round(average_confidence, 4)
            if average_confidence is not None else None
        ),
    }


def add_emergency_contact(
    name: str, email: str, phone: str, email_enabled: bool
) -> dict[str, Any]:
    contact = {
        "id": str(uuid.uuid4()),
        "name": name,
        "email": email,
        "phone": phone,
        "email_enabled": email_enabled,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    with LOCK, _connection() as connection:
        connection.execute(
            """
            INSERT INTO emergency_contacts(id, name, email, phone, email_enabled, created_at)
            VALUES (:id, :name, :email, :phone, :email_enabled, :created_at)
            """,
            {**contact, "email_enabled": int(email_enabled)},
        )
    return contact


def list_emergency_contacts() -> list[dict[str, Any]]:
    with LOCK, _connection() as connection:
        rows = connection.execute(
            """
            SELECT id, name, email, phone, email_enabled, created_at
            FROM emergency_contacts ORDER BY created_at DESC
            """
        ).fetchall()
    contacts = _dict_rows(rows)
    for contact in contacts:
        contact["email_enabled"] = bool(contact["email_enabled"])
    return contacts


def delete_emergency_contact(contact_id: str) -> bool:
    with LOCK, _connection() as connection:
        cursor = connection.execute(
            "DELETE FROM emergency_contacts WHERE id = ?", (contact_id,)
        )
    return cursor.rowcount > 0


def contacts_for_email(contact_ids: list[str]) -> list[dict[str, Any]]:
    if not contact_ids:
        return []
    placeholders = ",".join("?" for _ in contact_ids)
    with LOCK, _connection() as connection:
        rows = connection.execute(
            f"""
            SELECT id, name, email, phone
            FROM emergency_contacts
            WHERE email_enabled = 1 AND id IN ({placeholders})
            """,
            contact_ids,
        ).fetchall()
    return _dict_rows(rows)


def create_sos_request(
    location: str, message: str, email_requested: bool, emails_queued: int
) -> dict[str, Any]:
    incident = {
        "id": str(uuid.uuid4()),
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "location": location,
        "message": message,
        "status": "open",
        "email_requested": email_requested,
        "emails_queued": emails_queued,
        "acknowledged_by": "",
    }
    with LOCK, _connection() as connection:
        connection.execute(
            """
            INSERT INTO sos_requests(
                id, timestamp, location, message, status, email_requested, emails_queued
            ) VALUES (
                :id, :timestamp, :location, :message, :status, :email_requested, :emails_queued
            )
            """,
            {**incident, "email_requested": int(email_requested)},
        )
    return incident


def list_sos_requests(limit: int = 50) -> list[dict[str, Any]]:
    with LOCK, _connection() as connection:
        rows = connection.execute(
            """
            SELECT id, timestamp, location, message, status,
                   email_requested, emails_queued, acknowledged_by
            FROM sos_requests ORDER BY timestamp DESC LIMIT ?
            """,
            (limit,),
        ).fetchall()
    incidents = _dict_rows(rows)
    for incident in incidents:
        incident["email_requested"] = bool(incident["email_requested"])
    return incidents


def acknowledge_sos_request(
    incident_id: str, acknowledged_by: str
) -> dict[str, Any] | None:
    with LOCK, _connection() as connection:
        connection.execute(
            """
            UPDATE sos_requests SET status = 'acknowledged', acknowledged_by = ?
            WHERE id = ?
            """,
            (acknowledged_by, incident_id),
        )
        row = connection.execute(
            """
            SELECT id, timestamp, location, message, status,
                   email_requested, emails_queued, acknowledged_by
            FROM sos_requests WHERE id = ?
            """,
            (incident_id,),
        ).fetchone()
    if row is None:
        return None
    result = dict(row)
    result["email_requested"] = bool(result["email_requested"])
    return result


def add_feedback(
    persona: str,
    category: str,
    rating: int,
    message: str,
    scenario: str,
    accessibility_mode: bool,
) -> dict[str, Any]:
    feedback = {
        "id": str(uuid.uuid4()),
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "persona": persona,
        "category": category,
        "rating": rating,
        "message": message,
        "scenario": scenario,
        "accessibility_mode": accessibility_mode,
    }
    with LOCK, _connection() as connection:
        connection.execute(
            """
            INSERT INTO user_feedback(
                id, timestamp, persona, category, rating, message, scenario, accessibility_mode
            ) VALUES (
                :id, :timestamp, :persona, :category, :rating, :message, :scenario, :accessibility_mode
            )
            """,
            {**feedback, "accessibility_mode": int(accessibility_mode)},
        )
    return feedback


def list_feedback(limit: int = 100) -> list[dict[str, Any]]:
    with LOCK, _connection() as connection:
        rows = connection.execute(
            """
            SELECT id, timestamp, persona, category, rating, message,
                   scenario, accessibility_mode
            FROM user_feedback ORDER BY timestamp DESC LIMIT ?
            """,
            (limit,),
        ).fetchall()
    results = _dict_rows(rows)
    for item in results:
        item["accessibility_mode"] = bool(item["accessibility_mode"])
    return results


def feedback_summary() -> dict[str, Any]:
    with LOCK, _connection() as connection:
        summary = connection.execute(
            "SELECT COUNT(*) AS count, AVG(rating) AS average_rating FROM user_feedback"
        ).fetchone()
        categories = connection.execute(
            "SELECT category, COUNT(*) AS count FROM user_feedback GROUP BY category"
        ).fetchall()
        scenarios = connection.execute(
            """
            SELECT scenario, COUNT(*) AS count FROM user_feedback
            WHERE scenario != '' GROUP BY scenario
            """
        ).fetchall()
    return {
        "count": summary["count"],
        "average_rating": round(summary["average_rating"], 2)
        if summary["average_rating"] is not None
        else None,
        "categories": {row["category"]: row["count"] for row in categories},
        "scenarios": {row["scenario"]: row["count"] for row in scenarios},
    }


def recent_risk_inputs() -> dict[str, list[dict[str, Any]]]:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    with LOCK, _connection() as connection:
        readings = connection.execute(
            """
            SELECT sensor_id, temperature_c, carbon_monoxide_ppm, smoke_ppm, created_at
            FROM sensor_readings
            WHERE created_at >= ?
            ORDER BY created_at DESC
            LIMIT 500
            """,
            (cutoff,),
        ).fetchall()
        alerts = connection.execute(
            """
            SELECT id, timestamp, type, location, confidence, risk
            FROM alerts WHERE timestamp >= ?
            ORDER BY timestamp DESC LIMIT 200
            """,
            (cutoff,),
        ).fetchall()
    return {"readings": _dict_rows(readings), "alerts": _dict_rows(alerts)}
