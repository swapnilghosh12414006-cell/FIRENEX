from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from statistics import median
from typing import Any


def evaluate_risk(inputs: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    alerts = inputs["alerts"]
    readings = inputs["readings"]
    fire_alert = next((alert for alert in alerts if alert["type"] == "Fire"), None)
    smoke_alert = next((alert for alert in alerts if alert["type"] == "Smoke"), None)

    if fire_alert:
        return {
            "score": 100,
            "level": "CRITICAL",
            "basis": "A logged fire-class model detection occurred in the last hour.",
            "signals": ["Recent fire detection"],
            "recommended_actions": [
                "Follow the facility emergency plan and contact emergency services.",
                "Do not enter or re-enter an affected area.",
            ],
            "sensor_readings": len(readings),
            "latest_detection": fire_alert,
        }
    if smoke_alert:
        return {
            "score": 80,
            "level": "HIGH RISK",
            "basis": "A logged smoke-class model detection occurred in the last hour.",
            "signals": ["Recent smoke detection"],
            "recommended_actions": [
                "Investigate only from a safe location and follow the facility response plan.",
                "Escalate to emergency services if smoke is visible or anyone is at risk.",
            ],
            "sensor_readings": len(readings),
            "latest_detection": smoke_alert,
        }
    if not readings:
        return {
            "score": None,
            "level": "INSUFFICIENT DATA",
            "basis": "No physical sensor readings or recent logged detections are available.",
            "signals": [],
            "recommended_actions": [
                "Connect and verify physical sensors before relying on environmental risk trends."
            ],
            "sensor_readings": 0,
            "latest_detection": None,
        }

    series: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for reading in readings:
        series[reading["sensor_id"]].append(reading)

    rising_signals: list[str] = []
    usable_sensors = 0
    fields = (
        ("temperature_c", "temperature"),
        ("carbon_monoxide_ppm", "carbon monoxide"),
        ("smoke_ppm", "smoke"),
    )
    for sensor_readings in series.values():
        ordered = sorted(
            sensor_readings,
            key=lambda item: item["created_at"],
        )
        usable_sensors += 1
        for field, label in fields:
            values = [item[field] for item in ordered if item[field] is not None]
            if len(values) < 3:
                continue
            baseline = median(values[:-1])
            latest = values[-1]
            if baseline > 0 and latest >= baseline * 1.25:
                signal = f"Rising {label} trend reported by a physical sensor"
                if signal not in rising_signals:
                    rising_signals.append(signal)

    has_trend_data = any(
        any(
            sum(item[field] is not None for item in sensor_readings) >= 3
            for field, _ in fields
        )
        for sensor_readings in series.values()
    )
    if not has_trend_data:
        return {
            "score": None,
            "level": "INSUFFICIENT DATA",
            "basis": "At least three recent readings per sensor and measurement are required for trend comparison.",
            "signals": [],
            "recommended_actions": [
                "Continue monitoring and verify physical sensors are reporting regularly."
            ],
            "sensor_readings": len(readings),
            "latest_detection": None,
        }

    score = min(90, 30 * len(rising_signals))
    if score >= 70:
        level = "HIGH RISK"
    elif score >= 40:
        level = "MODERATE RISK"
    elif score:
        level = "LOW RISK"
    else:
        level = "SAFE"
    basis = (
        "A rule-based trend indicator compared recent physical sensor readings; it is not a validated prediction."
        if score
        else "No rising trends were detected in the available physical sensor readings; this does not prove a site is safe."
    )
    actions = (
        [
            "Verify the sensor and inspect the reported area only from a safe location.",
            "Follow site procedures if a warning is confirmed.",
        ]
        if score
        else ["Keep certified alarms active and continue routine monitoring."]
    )
    return {
        "score": score,
        "level": level,
        "basis": basis,
        "signals": rising_signals,
        "recommended_actions": actions,
        "sensor_readings": len(readings),
        "sensor_count": usable_sensors,
        "latest_detection": None,
        "evaluated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
