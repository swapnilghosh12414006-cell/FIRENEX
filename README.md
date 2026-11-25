# Emberwatch — Fire & Smoke Intelligence

Responsive React monitoring dashboard backed by FastAPI and an actual Ultralytics YOLO fire/smoke detector. Webcam frames and sampled image/video frames are sent to the API for inference; detections, confidences, and boxes come from the loaded model. No model or sensor results are fabricated.

> **Safety:** This is a university demonstration and decision-support prototype, not a certified life-safety system. It must not replace listed fire alarms, professional monitoring, emergency plans, or emergency services. Validate any model and deployment with qualified safety professionals.

## What is implemented

- React + TypeScript + Vite dashboard with responsive overview, live detection, alert history, camera management, analytics, and settings.
- Human-centered emergency response center, rule-based sensor trend indicator, multilingual text-to-speech (English, Bengali, Hindi, and Kannada), high-contrast accessibility mode, and an explicitly illustrative evacuation-map exercise.
- Persisted emergency contacts, operator-created SOS requests with acknowledgment, and local design-thinking feedback/scenario records. Email is opt-in and requires configured TLS SMTP; phone/SMS and public emergency dispatch are not implemented.
- Wireless camera sender/viewer MVP using browser `getUserMedia`, WebRTC peer-to-peer media, FastAPI WebSocket signaling, short-lived owner/viewer tokens, a generated QR pairing code, LAN-address discovery for loopback sessions, and up to three viewers per temporary room.
- A QR viewer opens a camera-only page without requiring the operator password; its short-lived viewer token authorizes only that room. Camera creation and the Emberwatch dashboard remain operator-protected.
- Webcam capture, camera switching where supported, image uploads, and video playback analyzed at the configured interval.
- FastAPI REST endpoints for health, image/video inference, incidents, camera configurations, settings, analytics, and sensor ingestion; `/api/ws` broadcasts live events.
- Backend input validation rejects blank camera/contact/incident data, empty sensor payloads, and incomplete email-notification settings. Health checks verify SQLite is queryable instead of assuming it is available.
- A single-operator password login protects dashboard APIs and WebSocket feeds with expiring, revocable HttpOnly sessions. The password is configured only in the backend environment and is never stored in SQLite or browser storage.
- Video uploads are copied to a bounded temporary file in chunks, then removed after analysis; inference failures are logged server-side and return a non-sensitive API error.
- Real Ultralytics YOLO inference; missing or invalid weights produce an unavailable status/HTTP 503 rather than fabricated detections.
- Fire/smoke bounding boxes and confidences, browser alarm tone, notification preferences, persistent alert history, filters, acknowledgment, CSV export, and browser print-to-PDF.
- Webcam/video alerts require consecutive positive frames before they are logged; single-frame candidates are marked as verifying. Still-image analysis is immediate.
- SQLite persistence at `backend\data\emberwatch.sqlite3` for incidents, camera configurations, settings, received sensor readings, SOS requests, emergency contacts, and feedback.
- Optional critical-fire email notifications via SMTP environment configuration. Sensor readings are accepted only from actual posts to `/api/sensors`; temperature, CO, and smoke sensor values remain unavailable until hardware is connected.

Uploaded images and video frames are sent to the configured API for inference and are not archived. The browser analyzes webcam frames and uploaded-video playback at the selected sampling interval; the API also provides a frame-sampled video-upload endpoint.

## Pretrained checkpoint

The configured checkpoint is [rabahdev/fire-smoke-yolov8n](https://huggingface.co/rabahdev/fire-smoke-yolov8n), an Ultralytics YOLOv8n fine-tune on D-Fire. Its model card identifies classes `smoke` and `fire` and publishes `best.pt`. It is licensed **AGPL-3.0**; review and comply with that license and the Ultralytics license before redistributing or deploying this model/app.

Download the pinned checkpoint from the project root in PowerShell:

```powershell
New-Item -ItemType Directory -Force backend\models | Out-Null
curl.exe -L --fail -o backend\models\fire-smoke.pt "https://huggingface.co/rabahdev/fire-smoke-yolov8n/resolve/13017fe8af477c25f5298d168e2dfede4b000753/best.pt"
$expected = "b91633799ceb052c814b4f8b77a37efc9a40f002d528df97d74463585fa4f28f"
$actual = (Get-FileHash backend\models\fire-smoke.pt -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Checkpoint checksum mismatch." }
```

The backend defaults to `backend\models\fire-smoke.pt`. The `.pt` file is intentionally ignored by Git; run the download command on each machine. The checkpoint's model-card metrics are dataset-specific, not a guarantee of accuracy in your camera environment.

## Prerequisites

- Node.js 20.19+ and npm 10+.
- Python 3.10+ (the project has been set up with Python 3.13).
- Windows x64 internet access for package installation and the checkpoint download.

## Install and run on Windows

### 1. Frontend

From the project root:

```powershell
npm install
npm run dev
```

Open the exact URL printed by Vite. Without local TLS it is normally `http://localhost:5173`; when `.env.local` has `VITE_HTTPS_CERT` and `VITE_HTTPS_KEY`, use `https://localhost:5173` instead—plain HTTP on that port will fail. For a phone, use `https://<computer-Wi-Fi-IPv4>:5173` after installing the local CA. Vite listens on the local network and proxies `/api` and WebSocket requests to FastAPI, so a phone can reach the app through the same Wi-Fi address without trying to contact its own `localhost`. A scanned viewer link opens only the private camera viewer; it does not require the operator password. Both devices must be on the same Wi-Fi, and Windows Firewall must allow the Vite port on the Private network profile. Guest Wi-Fi/client isolation can prevent devices from connecting.

Scanning a QR to **view** a stream does not ask the phone for camera permission. To use the **phone as the camera sender**, the page must be served from trusted HTTPS; browsers block camera access from plain HTTP Wi-Fi addresses. For a local HTTPS development server:

1. Install [mkcert](https://github.com/FiloSottile/mkcert) on Windows and install its local CA with `mkcert -install`.
2. Find the computer's Wi-Fi IPv4 address with `ipconfig` (for example, `192.168.1.20`) and create a certificate for that address:

   ```powershell
   New-Item -ItemType Directory -Force .certs | Out-Null
   mkcert -cert-file .certs\emberwatch.pem -key-file .certs\emberwatch-key.pem localhost 127.0.0.1 192.168.1.20
   ```

   Replace `192.168.1.20` with the actual address. If Wi-Fi later assigns a different address, regenerate the certificate with the new IP, restart Vite, and use the new HTTPS URL; the old address will stop working even if FastAPI is healthy. Transfer only the public `rootCA.pem` from `mkcert -CAROOT` to Android (the prepared copy is `.certs\emberwatch-rootCA.pem`). On most Android versions, open **Settings → Security & privacy → More security settings → Encryption & credentials → Install a certificate → CA certificate**, select the file, and confirm the warning. Menu names vary by device. Never copy `rootCA-key.pem` or the server private key to the phone.
3. Create or update the project-root `.env.local`:

   ```dotenv
   VITE_API_URL=http://127.0.0.1:8000
   VITE_HTTPS_CERT=.certs/emberwatch.pem
   VITE_HTTPS_KEY=.certs/emberwatch-key.pem
   ```

4. Set `EMBERWATCH_COOKIE_SECURE=true` in `backend\.env`, then restart FastAPI and Vite.
5. Open `https://192.168.1.20:5173` on the phone. Sign in, choose **Wireless Cameras → Camera sender**, create a pairing, then allow camera access. The QR viewer URL will also use HTTPS. The local Vite proxy keeps API requests on that HTTPS origin while forwarding them to FastAPI on the computer.

The phone must trust the local certificate for browser camera permissions to work. A publicly trusted HTTPS deployment is another option.

If FastAPI runs elsewhere, copy `.env.example` to `.env` in the project root and set `VITE_API_URL` to that API's URL. Vite reads this value at startup; restart the dev server after changing it.

### 2. Backend and model

From the project root, create a virtual environment and install CPU PyTorch plus the API/inference requirements:

```powershell
python -m venv backend\.venv
.\backend\.venv\Scripts\python.exe -m pip install --upgrade pip
.\backend\.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
.\backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
if (-not (Test-Path backend\.env)) { Copy-Item backend\.env.example backend\.env }
```

Before starting FastAPI, edit `backend\.env` and set `EMBERWATCH_ADMIN_USERNAME` and a private `EMBERWATCH_ADMIN_PASSWORD` of at least 12 characters. Generate a strong password with:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(24))"
```

Paste the generated value into `EMBERWATCH_ADMIN_PASSWORD`, then start FastAPI with the command below. The dashboard stays locked until these credentials are configured. Sessions expire after 8 hours by default, are revoked on sign-out, and are cleared when the backend restarts. Login attempts are limited to five per 15 minutes.

For an HTTPS deployment, set `EMBERWATCH_COOKIE_SECURE=true`. If the frontend and API are on different sites, set `EMBERWATCH_COOKIE_SAMESITE=none`, enable the secure cookie, and add the exact frontend origin to `FIRE_ALLOWED_ORIGINS`. Do not expose the app over plain HTTP on an untrusted network.

Download and verify the checkpoint using the command above. Then start the API:

```powershell
Set-Location backend
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --host 0.0.0.0 --port 8000 --env-file .env
```

Check `http://127.0.0.1:8000/api/health`; it should report `"model_loaded": true`. The Swagger interface is at `http://127.0.0.1:8000/docs`. In a separate terminal, run the frontend command above.

To use different weights, set `FIRE_MODEL_PATH` in `backend\.env` (absolute paths are safest). Other settings are `FIRE_MODEL_DEVICE` (default `cpu`), `FIRE_ALLOWED_ORIGINS` (comma-separated browser origins), `FIRE_ALLOWED_ORIGIN_REGEX` (allows localhost development ports by default; set it to an empty value to disable), `FIRE_MAX_UPLOAD_MB` (default `25`), `FIRE_MAX_VIDEO_MB` (default `200`), and `EMBERWATCH_DATABASE` (optional database path).

### Optional integrations

- **Sensor ingestion:** POST JSON to `http://127.0.0.1:8000/api/sensors` with `sensor_id` and any available `temperature_c`, `carbon_monoxide_ppm`, or `smoke_ppm`. Set `SENSOR_API_KEY` in `backend\.env` to require the matching `X-Sensor-Key` header. Until hardware sends readings, the dashboard shows them as unavailable and does not invent simulated values.
- **Risk indicator:** `GET /api/risk` uses recent logged model incidents and physical sensor readings. Sensor trends are an experimental 25%-increase heuristic, not a trained or validated prediction. It returns `INSUFFICIENT DATA` when readings are unavailable or too sparse; a `SAFE` label is not proof of safety.
- **SMTP email:** Copy `backend\.env.example` to `backend\.env` if needed and configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, and exactly one encrypted transport (`SMTP_STARTTLS=true` with `SMTP_USE_SSL=false`, or the reverse). For Gmail, enable 2-Step Verification and create an App Password; use `smtp.gmail.com`, port `587`, STARTTLS, and the App Password (not your account password). Keep credentials only in `backend\.env`, never in the frontend or source control. Restart FastAPI after editing the file. In Detection Settings, enter the recipient and choose **Send test email**; Emberwatch sends only to that saved recipient. The API reports success only after the SMTP server accepts the message. Once verified, enable email alerts. Critical-fire notifications and explicitly confirmed SOS emails use those settings. Phone numbers are directory-only; there is no SMS provider or direct emergency dispatch.
- **Multilingual voice:** The response center uses the browser Speech Synthesis API. Voice availability and pronunciation depend on installed browser/operating-system language packs; text instructions remain available.
- **Evacuation exercise:** The map and its route graph are sample data. Routes exclude selected simulated hazards and blocked sample exits but are never asserted to be safe. Connect a verified building floorplan and reliable hazard-location data before using any site-specific routing.
- **Wireless camera:** Open Wireless Cameras on the signed-in sender, create a pairing, and grant camera permission. The QR uses the sender page origin, or automatically substitutes the computer's LAN IP when the sender is open on `localhost`/`127.0.0.1`. Scan it from a viewer on the same Wi-Fi; the Vite server must be reachable through the firewall, and the backend allows private IPv4 origins by default. The viewer token grants only access to that temporary camera room. Rooms expire after 10 minutes and allow up to three viewers. The owner can stop the camera to close the room. Camera and microphone access require explicit permission; microphone audio is off until enabled. A mobile sender requires trusted HTTPS; see the local HTTPS steps above.
- **Local-network binding:** The backend startup command binds to `0.0.0.0` so a paired device can reach the API. Use only on a trusted private network, allow the ports through Windows Firewall only on the Private profile if prompted, and do not port-forward the demo API to the internet without HTTPS and deployment hardening.
- **Wireless network requirements:** Media is peer-to-peer and is not stored by the backend. Localhost works for development; remote devices require a publicly reachable HTTPS frontend and WSS/HTTPS FastAPI service. STUN is configured by default but cannot traverse every NAT. For dependable internet connectivity, configure `WEBRTC_TURN_URLS`, `WEBRTC_TURN_SHARED_SECRET`, and `WEBRTC_TURN_USERNAME` for a Coturn REST-auth deployment in `backend\.env`; the backend derives credentials that expire with the 10-minute room. Do not use long-lived TURN credentials in the browser or expose the shared secret. RTSP/ONVIF/IP cameras require a separate secured media gateway and are not directly supported.
- **Persistence:** SQLite is created automatically on startup. Stop and restart FastAPI without deleting the database file to retain alerts, cameras, settings, and sensor records.
- **Live updates:** The UI connects to `/api/ws` and reconnects if the API restarts. Camera signaling rooms are in-memory and expire; they do not survive a backend restart. Sensor devices can post without a dashboard session only when `SENSOR_API_KEY` is configured and supplied.

## Validate

```powershell
npm run build
.\backend\.venv\Scripts\python.exe -m pip check
Invoke-RestMethod http://127.0.0.1:8000/api/health
.\backend\.venv\Scripts\python.exe -m unittest discover -s backend\tests -v
```

Use `/docs` or upload a real image through the app to test inference. Keep certified alarms active: this detector samples video frames and is not hard-real-time or safety-certified.

## Limitations

- Login uses one operator account from backend environment variables; there is no public registration, password-reset flow, or multi-user role management.
- Video is sampled every 2.5 seconds; it can miss short events.
- WebRTC tests must be run on localhost or an HTTPS/WSS deployment. Browser camera and microphone permission prompts cannot be bypassed. Restrictive networks need an operator-managed TURN service.
- Camera switching is supported where the browser exposes multiple devices; multiple live feeds are not processed concurrently.
- Multiple wireless sender rooms and up to three viewers per room are supported, but multi-user accounts, recording, and cross-room administration are not.
- Physical sensor hardware must be separately wired/programmed to post readings. The experimental sensor-trend indicator is not a validated fire-risk predictor.
- The sample evacuation map is not connected to a real building floorplan or verified hazard-location system; never treat its routes as safety instructions.
- Do not expose the development API to untrusted networks without authentication, TLS, resource limits, and deployment review.
