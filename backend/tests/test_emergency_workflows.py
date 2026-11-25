import base64
import asyncio
import hashlib
import hmac
import os
import smtplib
import tempfile
import unittest
from pathlib import Path
import sys
from contextlib import contextmanager
from unittest.mock import AsyncMock, patch

import cv2
import numpy as np
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import camera_rooms
import database
import main
import notifications
from risk import evaluate_risk
from starlette.websockets import WebSocketDisconnect


@contextmanager
def authenticated_client():
    with patch.dict(
        os.environ,
        {
            "EMBERWATCH_ADMIN_USERNAME": "operator",
            "EMBERWATCH_ADMIN_PASSWORD": "Test-Operator-Password-123",
        },
    ):
        with TestClient(main.app) as client:
            response = client.post(
                "/api/auth/login",
                json={
                    "username": "operator",
                    "password": "Test-Operator-Password-123",
                },
            )
            if response.status_code != 200:
                raise AssertionError(f"Test login failed: {response.text}")
            yield client


class RiskAssessmentTests(unittest.TestCase):
    def test_missing_sensor_data_is_not_reported_as_safe(self) -> None:
        result = evaluate_risk({"readings": [], "alerts": []})
        self.assertIsNone(result["score"])
        self.assertEqual(result["level"], "INSUFFICIENT DATA")

    def test_rising_sensor_trends_are_labeled_as_heuristic(self) -> None:
        readings = [
            {
                "sensor_id": "sensor-a",
                "temperature_c": temperature,
                "carbon_monoxide_ppm": carbon_monoxide,
                "smoke_ppm": None,
                "created_at": f"2026-01-01T00:00:0{index}+00:00",
            }
            for index, (temperature, carbon_monoxide) in enumerate(
                ((20, 2), (21, 2.1), (30, 3.2))
            )
        ]
        result = evaluate_risk({"readings": readings, "alerts": []})
        self.assertEqual(result["score"], 60)
        self.assertEqual(result["level"], "MODERATE RISK")
        self.assertIn("not a validated prediction", result["basis"])

    def test_logged_fire_detection_takes_priority(self) -> None:
        result = evaluate_risk(
            {
                "readings": [],
                "alerts": [{"type": "Fire", "location": "North zone"}],
            }
        )
        self.assertEqual(result["score"], 100)
        self.assertEqual(result["level"], "CRITICAL")


class EmergencyPersistenceTests(unittest.TestCase):
    def test_email_configuration_requires_exactly_one_encrypted_transport(self) -> None:
        base = {
            "SMTP_HOST": "smtp.example.org",
            "SMTP_FROM": "alerts@example.org",
            "SMTP_STARTTLS": "true",
            "SMTP_USE_SSL": "false",
        }
        with patch.dict(os.environ, base, clear=True):
            self.assertTrue(notifications.email_is_configured())
        with patch.dict(
            os.environ,
            {**base, "SMTP_USE_SSL": "true"},
            clear=True,
        ):
            self.assertFalse(notifications.email_is_configured())

    def test_contacts_sos_acknowledgement_feedback_and_sensor_data_persist(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "emberwatch-test.sqlite3"
            with patch.object(database, "DATABASE_PATH", path):
                database.initialize()
                contact = database.add_emergency_contact(
                    "Safety lead", "safety@example.org", "", True
                )
                incident = database.create_sos_request(
                    "North zone", "Need assistance", False, 0
                )
                acknowledged = database.acknowledge_sos_request(
                    incident["id"], "Operator"
                )
                database.add_feedback(
                    "Student",
                    "Accessibility",
                    5,
                    "Voice prompt was clear",
                    "Smoke exercise",
                    True,
                )
                database.save_sensor_reading("sensor-a", 23.5, 2.1, 0.4)

                self.assertEqual(database.list_emergency_contacts()[0]["id"], contact["id"])
                self.assertEqual(
                    database.list_sos_requests()[0]["status"], "acknowledged"
                )
                self.assertEqual(acknowledged["acknowledged_by"], "Operator")
                self.assertEqual(database.feedback_summary()["average_rating"], 5.0)
                self.assertEqual(database.latest_sensor_readings(1)[0]["sensor_id"], "sensor-a")


class ApiContractTests(unittest.TestCase):
    def test_password_login_protects_api_and_logout_revokes_the_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "emberwatch-auth-test.sqlite3"
            with patch.object(database, "DATABASE_PATH", path), patch.object(
                main, "load_model"
            ), patch.dict(
                os.environ,
                {
                    "EMBERWATCH_ADMIN_USERNAME": "operator",
                    "EMBERWATCH_ADMIN_PASSWORD": "Test-Operator-Password-123",
                },
            ):
                with TestClient(main.app) as client:
                    status = client.get("/api/auth/session")
                    self.assertEqual(status.status_code, 200)
                    self.assertTrue(status.json()["configured"])
                    self.assertFalse(status.json()["authenticated"])
                    self.assertEqual(client.get("/api/alerts").status_code, 401)
                    with self.assertRaises(WebSocketDisconnect) as websocket_error:
                        with client.websocket_connect("/api/ws"):
                            pass
                    self.assertEqual(websocket_error.exception.code, 4401)

                    incorrect = client.post(
                        "/api/auth/login",
                        json={"username": "operator", "password": "wrong-password"},
                    )
                    self.assertEqual(incorrect.status_code, 401)
                    self.assertEqual(
                        incorrect.json()["detail"],
                        "Username or password is incorrect.",
                    )

                    logged_in = client.post(
                        "/api/auth/login",
                        json={
                            "username": "operator",
                            "password": "Test-Operator-Password-123",
                        },
                    )
                    self.assertEqual(logged_in.status_code, 200)
                    self.assertIn("HttpOnly", logged_in.headers["set-cookie"])
                    self.assertEqual(client.get("/api/alerts").status_code, 200)
                    with client.websocket_connect("/api/ws") as websocket:
                        websocket.send_text("keepalive")

                    logged_out = client.post("/api/auth/logout")
                    self.assertEqual(logged_out.status_code, 200)
                    self.assertEqual(client.get("/api/alerts").status_code, 401)

    def test_protected_api_stays_closed_until_operator_credentials_are_configured(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "emberwatch-auth-unconfigured.sqlite3"
            with patch.object(database, "DATABASE_PATH", path), patch.object(
                main, "load_model"
            ), patch.dict(
                os.environ,
                {
                    "EMBERWATCH_ADMIN_USERNAME": "",
                    "EMBERWATCH_ADMIN_PASSWORD": "",
                },
            ):
                with TestClient(main.app) as client:
                    status = client.get("/api/auth/session")
                    self.assertFalse(status.json()["configured"])
                    self.assertEqual(client.get("/api/settings").status_code, 503)
                    login = client.post(
                        "/api/auth/login",
                        json={"username": "operator", "password": "some-password"},
                    )
                    self.assertEqual(login.status_code, 503)

    def test_api_validates_input_and_persists_sensor_and_settings(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "emberwatch-api-test.sqlite3"
            with patch.object(database, "DATABASE_PATH", path), patch.object(
                main, "load_model"
            ):
                with authenticated_client() as client:
                    empty_sensor = client.post(
                        "/api/sensors", json={"sensor_id": "sensor-a"}
                    )
                    self.assertEqual(empty_sensor.status_code, 422)

                    reading = client.post(
                        "/api/sensors",
                        json={"sensor_id": " sensor-a ", "temperature_c": 24.5},
                    )
                    self.assertEqual(reading.status_code, 201)
                    self.assertEqual(reading.json()["sensor_id"], "sensor-a")

                    enabled_without_email = client.patch(
                        "/api/settings", json={"email_notifications": True}
                    )
                    self.assertEqual(enabled_without_email.status_code, 422)

                    invalid_camera = client.post(
                        "/api/cameras", json={"name": "  ", "location": "Lab"}
                    )
                    self.assertEqual(invalid_camera.status_code, 422)

                    health = client.get("/api/health")
                    self.assertEqual(health.status_code, 200)
                    self.assertEqual(health.json()["database"], "ok")

    def test_smtp_test_email_uses_saved_recipient_and_reports_delivery_errors(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "emberwatch-email-test.sqlite3"
            with patch.object(database, "DATABASE_PATH", path), patch.object(
                main, "load_model"
            ), patch.object(main, "email_is_configured", return_value=True):
                with authenticated_client() as client:
                    missing_recipient = client.post("/api/settings/email/test")
                    self.assertEqual(missing_recipient.status_code, 422)

                    recipient = "safety@example.org"
                    saved = client.patch(
                        "/api/settings", json={"email_to": recipient}
                    )
                    self.assertEqual(saved.status_code, 200)

                    with patch.object(
                        main, "send_test_email", new_callable=AsyncMock
                    ) as send:
                        delivered = client.post("/api/settings/email/test")
                    self.assertEqual(delivered.status_code, 200)
                    self.assertEqual(delivered.json()["recipient"], recipient)
                    send.assert_awaited_once_with(recipient)

                    with patch.object(
                        main,
                        "send_test_email",
                        new_callable=AsyncMock,
                        side_effect=smtplib.SMTPAuthenticationError(535, b"auth failed"),
                    ):
                        failed = client.post("/api/settings/email/test")
                    self.assertEqual(failed.status_code, 502)
                    self.assertIn("backend logs", failed.json()["detail"])

                    with patch.object(main, "email_is_configured", return_value=False):
                        unconfigured = client.post("/api/settings/email/test")
                    self.assertEqual(unconfigured.status_code, 503)

    def test_image_detection_endpoint_records_model_result_without_fake_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "emberwatch-detection-test.sqlite3"
            with patch.object(database, "DATABASE_PATH", path), patch.object(
                main, "load_model"
            ), patch.object(main, "model", object()), patch.object(
                main, "model_name", "test-fire-model"
            ), patch.object(
                main,
                "_infer",
                return_value=(
                    [{"label": "Fire", "confidence": 0.91, "box": [0.1, 0.2, 0.8, 0.9]}],
                    12.5,
                ),
            ):
                with authenticated_client() as client:
                    ok, encoded = cv2.imencode(
                        ".jpg", np.zeros((32, 32, 3), dtype=np.uint8)
                    )
                    self.assertTrue(ok)
                    result = client.post(
                        "/api/detect?location=Test%20Zone",
                        files={"file": ("frame.jpg", encoded.tobytes(), "image/jpeg")},
                    )
                    self.assertEqual(result.status_code, 200)
                    body = result.json()
                    self.assertEqual(body["model"], "test-fire-model")
                    self.assertEqual(body["detections"][0]["confidence"], 0.91)
                    self.assertEqual(len(body["alerts"]), 1)
                    self.assertEqual(database.list_alerts()["total"], 1)

    def test_image_detection_reports_model_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "emberwatch-no-model-test.sqlite3"
            with patch.object(database, "DATABASE_PATH", path), patch.object(
                main, "load_model"
            ), patch.object(main, "model", None), patch.object(
                main, "model_error", "Test checkpoint missing."
            ):
                with authenticated_client() as client:
                    ok, encoded = cv2.imencode(
                        ".jpg", np.zeros((32, 32, 3), dtype=np.uint8)
                    )
                    self.assertTrue(ok)
                    result = client.post(
                        "/api/detect",
                        files={"file": ("frame.jpg", encoded.tobytes(), "image/jpeg")},
                    )
                    self.assertEqual(result.status_code, 503)
                    self.assertEqual(result.json()["detail"], "Test checkpoint missing.")

    def test_sensor_api_key_is_required_when_configured(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "emberwatch-sensor-test.sqlite3"
            with patch.object(database, "DATABASE_PATH", path), patch.object(
                main, "load_model"
            ), patch.dict(os.environ, {"SENSOR_API_KEY": "expected-secret"}):
                with authenticated_client() as client:
                    payload = {"sensor_id": "sensor-a", "carbon_monoxide_ppm": 1.2}
                    rejected = client.post("/api/sensors", json=payload)
                    accepted = client.post(
                        "/api/sensors",
                        json=payload,
                        headers={"X-Sensor-Key": "expected-secret"},
                    )
                    self.assertEqual(rejected.status_code, 401)
                    self.assertEqual(accepted.status_code, 201)


class CameraRoomTests(unittest.TestCase):
    def test_viewer_link_can_connect_without_an_operator_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "emberwatch-viewer-link-test.sqlite3"
            with patch.object(database, "DATABASE_PATH", path), patch.object(
                main, "load_model"
            ), patch.dict(
                os.environ,
                {
                    "EMBERWATCH_ADMIN_USERNAME": "operator",
                    "EMBERWATCH_ADMIN_PASSWORD": "Test-Operator-Password-123",
                    "WEBRTC_STUN_URLS": "",
                    "WEBRTC_TURN_URLS": "",
                },
            ):
                with TestClient(main.app) as client:
                    login = client.post(
                        "/api/auth/login",
                        json={
                            "username": "operator",
                            "password": "Test-Operator-Password-123",
                        },
                    )
                    self.assertEqual(login.status_code, 200)
                    created = client.post("/api/camera-rooms")
                    self.assertEqual(created.status_code, 201)
                    room = created.json()

                    client.post("/api/auth/logout")
                    self.assertFalse(client.get("/api/auth/session").json()["authenticated"])
                    configuration = client.get(
                        f"/api/camera-rooms/{room['room_id']}",
                        headers={"X-Room-Token": room["viewer_token"]},
                    )
                    self.assertEqual(configuration.status_code, 200)
                    self.assertEqual(configuration.json()["room_id"], room["room_id"])
                    self.assertEqual(
                        client.get(
                            f"/api/camera-rooms/{room['room_id']}",
                            headers={"X-Room-Token": room["owner_token"]},
                        ).status_code,
                        404,
                    )

                    with client.websocket_connect(
                        f"/api/camera-rooms/{room['room_id']}/ws",
                        headers={"Origin": "http://127.0.0.1:5173"},
                    ) as websocket:
                        websocket.send_json(
                            {"type": "auth", "token": room["viewer_token"]}
                        )
                        authenticated = websocket.receive_json()
                        self.assertEqual(authenticated["type"], "authenticated")
                        self.assertEqual(authenticated["role"], "viewer")

                    client.post(
                        "/api/auth/login",
                        json={
                            "username": "operator",
                            "password": "Test-Operator-Password-123",
                        },
                    )
                    closed = client.delete(
                        f"/api/camera-rooms/{room['room_id']}",
                        headers={"X-Room-Token": room["owner_token"]},
                    )
                    self.assertEqual(closed.status_code, 200)

    def test_browser_websocket_origin_policy_allows_local_lan_and_nonbrowser_clients(self) -> None:
        self.assertTrue(main._origin_is_allowed(None))
        self.assertTrue(main._origin_is_allowed("http://127.0.0.1:5173"))
        self.assertTrue(main._origin_is_allowed("http://192.168.0.55:5173"))
        self.assertFalse(main._origin_is_allowed("https://untrusted.example"))

    def test_network_info_is_loopback_only_and_returns_a_lan_address(self) -> None:
        local_request = Request(
            {"type": "http", "headers": [], "client": ("127.0.0.1", 50000)}
        )
        remote_request = Request(
            {"type": "http", "headers": [], "client": ("192.168.0.20", 50000)}
        )
        with patch.object(main, "local_network_address", return_value="192.168.0.55"):
            self.assertEqual(main.network_info(local_request), {"lan_address": "192.168.0.55"})
            with self.assertRaises(HTTPException) as error:
                main.network_info(remote_request)
        self.assertEqual(error.exception.status_code, 403)

    def test_pairing_qr_decodes_with_standard_scanner_contrast(self) -> None:
        value = "http://192.168.0.55:5173/#camera=room-id&token=viewer-token"
        result = main.create_camera_room_qr(main.QrCodeCreate(value=value))
        image = cv2.imdecode(
            np.frombuffer(base64.b64decode(result["image_data"]), dtype=np.uint8),
            cv2.IMREAD_COLOR,
        )
        decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(image)
        self.assertEqual(decoded, value)

    def test_viewer_token_authorizes_room_configuration_and_owner_closes_room(self) -> None:
        async def exercise() -> None:
            with patch.dict(
                os.environ,
                {"WEBRTC_STUN_URLS": "stun:stun.example.test:3478", "WEBRTC_TURN_URLS": ""},
            ):
                manager = camera_rooms.CameraRoomManager()
                room = await manager.create()
                valid = await manager.viewer_configuration(
                    room["room_id"], room["viewer_token"]
                )
                invalid = await manager.viewer_configuration(
                    room["room_id"], room["owner_token"]
                )
                self.assertIsNotNone(valid)
                self.assertIsNone(invalid)
                self.assertFalse(await manager.close(room["room_id"], room["viewer_token"]))
                self.assertTrue(await manager.close(room["room_id"], room["owner_token"]))
                self.assertIsNone(
                    await manager.viewer_configuration(
                        room["room_id"], room["viewer_token"]
                    )
                )

        asyncio.run(exercise())

    def test_turn_credentials_are_derived_for_the_room_expiry(self) -> None:
        async def exercise() -> None:
            with patch.dict(
                os.environ,
                {
                    "WEBRTC_STUN_URLS": "",
                    "WEBRTC_TURN_URLS": "turn:turn.example.test:3478",
                    "WEBRTC_TURN_SHARED_SECRET": "test-shared-secret",
                    "WEBRTC_TURN_USERNAME": "test-room",
                },
            ):
                manager = camera_rooms.CameraRoomManager()
                room = await manager.create()
                turn = room["ice_servers"][0]
                expected_username = f"{room['expires_at']}:test-room"
                expected_credential = base64.b64encode(
                    hmac.new(
                        b"test-shared-secret",
                        expected_username.encode("utf-8"),
                        hashlib.sha1,
                    ).digest()
                ).decode("ascii")
                self.assertEqual(turn["username"], expected_username)
                self.assertEqual(turn["credential"], expected_credential)
                self.assertTrue(room["turn_configured"])
                self.assertTrue(await manager.close(room["room_id"], room["owner_token"]))

        asyncio.run(exercise())

    def test_owner_viewer_signaling_is_relayed_only_to_the_paired_peer(self) -> None:
        class FakeWebSocket:
            def __init__(self) -> None:
                self.incoming: asyncio.Queue[object] = asyncio.Queue()
                self.outgoing: asyncio.Queue[dict[str, object]] = asyncio.Queue()

            async def accept(self) -> None:
                return

            async def receive_json(self) -> dict[str, object]:
                message = await self.incoming.get()
                if message is None:
                    raise WebSocketDisconnect(code=1000)
                return message

            async def send_json(self, message: dict[str, object]) -> None:
                await self.outgoing.put(message)

            async def close(self, code: int = 1000, reason: str = "") -> None:
                await self.incoming.put(None)

            async def send(self, message: dict[str, object]) -> None:
                await self.incoming.put(message)

            async def next_message(self) -> dict[str, object]:
                return await asyncio.wait_for(self.outgoing.get(), timeout=1)

        async def exercise() -> None:
            with patch.dict(
                os.environ,
                {"WEBRTC_STUN_URLS": "", "WEBRTC_TURN_URLS": ""},
            ):
                manager = camera_rooms.CameraRoomManager()
                room = await manager.create()
                owner = FakeWebSocket()
                viewer = FakeWebSocket()
                owner_task = asyncio.create_task(manager.serve(owner, room["room_id"]))
                await owner.send({"type": "auth", "token": room["owner_token"]})
                self.assertEqual((await owner.next_message())["role"], "owner")

                viewer_task = asyncio.create_task(manager.serve(viewer, room["room_id"]))
                await viewer.send({"type": "auth", "token": room["viewer_token"]})
                viewer_auth = await viewer.next_message()
                peer_id = viewer_auth["peer_id"]
                self.assertEqual(viewer_auth["role"], "viewer")
                self.assertEqual((await owner.next_message())["type"], "viewer_joined")
                self.assertEqual((await viewer.next_message())["type"], "owner_ready")

                offer = {"type": "offer", "peer_id": peer_id, "description": {"type": "offer", "sdp": "offer"}}
                await owner.send(offer)
                self.assertEqual((await viewer.next_message())["type"], "offer")
                answer = {"type": "answer", "peer_id": "owner", "description": {"type": "answer", "sdp": "answer"}}
                await viewer.send(answer)
                self.assertEqual((await owner.next_message())["type"], "answer")

                self.assertTrue(await manager.close(room["room_id"], room["owner_token"]))
                await asyncio.wait_for(asyncio.gather(owner_task, viewer_task), timeout=1)

        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
