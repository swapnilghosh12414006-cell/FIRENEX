import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Accessibility, Activity, AlertTriangle, ArrowDownToLine, Bell, Camera, Check,
  ChevronLeft, ChevronRight, CircleHelp, Clock3, ClipboardCheck, CloudUpload, Cpu, Download,
  ExternalLink, Flame, LayoutDashboard, ListChecks, Map as MapIcon, Maximize2, Menu, Plus, Radio,
  LogOut, Search, Settings, Shield, ShieldAlert, ShieldCheck, Siren,
  Thermometer, Trash2, Video, Wifi, X, Zap,
} from 'lucide-react';
import {
  Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  api, type AlertCounts, type AlertRecord, type Analytics, type CameraRecord,
  type Detection, type DetectionResponse, type DetectionSettings, type Health,
  type LiveEvent, type SensorReading,
} from './api';
import WirelessCameras from './WirelessCameras';
import { DesignThinkingLab, EmergencyResponsePage, EvacuationAssistant } from './humanExperience';

type Page =
  | 'Dashboard'
  | 'Live Detection'
  | 'Alert History'
  | 'Camera Management'
  | 'Analytics & Reports'
  | 'Detection Settings'
  | 'Emergency Response'
  | 'Evacuation Assistant'
  | 'Wireless Cameras'
  | 'Human-centered Testing';

const EMPTY_COUNTS: AlertCounts = { total: 0, fire: 0, smoke: 0, critical: 0 };
const DEFAULT_SETTINGS: DetectionSettings = {
  fire_threshold: 0.45,
  smoke_threshold: 0.45,
  frame_interval_ms: 2500,
  auto_logging: true,
  sound_enabled: true,
  browser_notifications: false,
  email_notifications: false,
  email_to: '',
  email_configured: false,
  model_device: 'cpu',
};
const NAV_ITEMS: { name: Page; icon: typeof LayoutDashboard }[] = [
  { name: 'Dashboard', icon: LayoutDashboard },
  { name: 'Live Detection', icon: Video },
  { name: 'Emergency Response', icon: Siren },
  { name: 'Evacuation Assistant', icon: MapIcon },
  { name: 'Wireless Cameras', icon: Radio },
  { name: 'Alert History', icon: ListChecks },
  { name: 'Camera Management', icon: Camera },
  { name: 'Analytics & Reports', icon: Activity },
  { name: 'Detection Settings', icon: Settings },
  { name: 'Human-centered Testing', icon: ClipboardCheck },
];

function formatDuration(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
}

function riskLabel(detections: Detection[]) {
  if (detections.some((item) => item.label === 'Fire')) return 'CRITICAL';
  if (detections.some((item) => item.label === 'Smoke')) {
    return Math.max(...detections.filter((item) => item.label === 'Smoke').map((item) => item.confidence)) >= 0.7
      ? 'WARNING'
      : 'LOW RISK';
  }
  return 'NORMAL';
}

function downloadCsv(alerts: AlertRecord[]) {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = [
    ['Timestamp', 'Detection Type', 'Location Zone', 'Confidence', 'Severity', 'Action', 'Acknowledged'],
    ...alerts.map((alert) => [
      new Date(alert.timestamp).toLocaleString(),
      alert.type,
      alert.location,
      `${(alert.confidence * 100).toFixed(1)}%`,
      alert.risk,
      alert.action,
      alert.acknowledged ? 'Yes' : 'No',
    ]),
  ];
  const url = URL.createObjectURL(new Blob(
    [rows.map((row) => row.map(escape).join(',')).join('\r\n')],
    { type: 'text/csv;charset=utf-8' },
  ));
  const link = document.createElement('a');
  link.href = url;
  link.download = `emberwatch-incidents-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function App({ onLogout }: { onLogout: () => void }) {
  const [page, setPage] = useState<Page>(
    new URLSearchParams(window.location.hash.slice(1)).has('camera') ? 'Wireless Cameras' : 'Dashboard',
  );
  const [mobileNav, setMobileNav] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [accessibilityMode, setAccessibilityMode] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [settings, setSettings] = useState<DetectionSettings>(DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  const settingsSaveTimer = useRef<number | null>(null);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [confirmedTypes, setConfirmedTypes] = useState<Array<'Fire' | 'Smoke'>>([]);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [counts, setCounts] = useState<AlertCounts>(EMPTY_COUNTS);
  const [totalAlerts, setTotalAlerts] = useState(0);
  const [alertPage, setAlertPage] = useState(1);
  const [search, setSearch] = useState('');
  const [alertType, setAlertType] = useState('');
  const [severity, setSeverity] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [cameras, setCameras] = useState<CameraRecord[]>([]);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraError, setCameraError] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const [mediaKind, setMediaKind] = useState<'camera' | 'video' | 'image' | null>(null);
  const [cameraId, setCameraId] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [detectionLocation, setDetectionLocation] = useState('');
  const [newCameraName, setNewCameraName] = useState('');
  const [newCameraLocation, setNewCameraLocation] = useState('');
  const [newCameraDevice, setNewCameraDevice] = useState('');
  const [savingCamera, setSavingCamera] = useState(false);
  const [testingEmail, setTestingEmail] = useState(false);
  const [sensorReadings, setSensorReadings] = useState<SensorReading[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [analyticsDays, setAnalyticsDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [detectionError, setDetectionError] = useState('');
  const [apiError, setApiError] = useState('');
  const [toast, setToast] = useState('');
  const [now, setNow] = useState(new Date());
  const [websocketConnected, setWebsocketConnected] = useState(false);
  const [emergencyGuideOpen, setEmergencyGuideOpen] = useState(false);
  const [mediaSize, setMediaSize] = useState({ width: 16, height: 9 });

  const videoRef = useRef({ current: null as HTMLVideoElement | null }).current;
  const fileVideoRef = useRef({ current: null as HTMLVideoElement | null }).current;
  const imageRef = useRef({ current: null as HTMLImageElement | null }).current;
  const canvasRef = useRef({ current: null as HTMLCanvasElement | null }).current;
  const bindVideo = useCallback((element: HTMLVideoElement | null) => { videoRef.current = element; }, []);
  const bindFileVideo = useCallback((element: HTMLVideoElement | null) => { fileVideoRef.current = element; }, []);
  const bindImage = useCallback((element: HTMLImageElement | null) => { imageRef.current = element; }, []);
  const bindCanvas = useCallback((element: HTMLCanvasElement | null) => { canvasRef.current = element; }, []);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaKindRef = useRef<'camera' | 'video' | 'image' | null>(null);
  const sourceLocationRef = useRef('Unassigned camera');
  const frameTimer = useRef<number | null>(null);
  const frameProcessor = useRef<() => void>(() => undefined);
  const frameBusy = useRef(false);
  const frameController = useRef<AbortController | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const lastFireSound = useRef(0);
  const handledAlertIds = useRef(new Set<string>());
  const objectUrl = useRef('');
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const fireCount = counts.fire;
  const smokeCount = counts.smoke;
  const fireConfirmed = confirmedTypes.includes('Fire');
  const smokeConfirmed = confirmedTypes.includes('Smoke');
  const confirmedDetections = detections.filter((detection) => confirmedTypes.includes(detection.label));
  const currentRisk = riskLabel(confirmedDetections);
  const monitoring = mediaKind !== null;
  const pageCount = Math.max(1, Math.ceil(totalAlerts / 20));
  const latestSensor = sensorReadings[0];
  const modelName = health?.model_loaded ? health.model : '';
  const modelError = health?.model_error ?? (health?.status === 'ok' ? 'Model not loaded' : 'FastAPI service is unavailable.');
  const mergeAlerts = useCallback((incoming: AlertRecord[]) => {
    if (!incoming.length) return;
    setAlerts((old) => {
      const byId = new Map(old.map((alert) => [alert.id, alert]));
      incoming.forEach((alert) => byId.set(alert.id, alert));
      return [...byId.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 20);
    });
  }, []);

  const refreshAlerts = useCallback(async (pageNumber = 1) => {
    const result = await api.alerts({
      search,
      type: alertType,
      severity,
      date_from: dateFrom,
      date_to: dateTo,
      page: pageNumber,
      page_size: 20,
    });
    setAlerts(result.items);
    setCounts(result.counts);
    setTotalAlerts(result.total);
    setAlertPage(result.page);
  }, [search, alertType, severity, dateFrom, dateTo]);

  const alertPageRef = useRef(alertPage);
  const refreshAlertsRef = useRef(refreshAlerts);

  useEffect(() => { alertPageRef.current = alertPage; }, [alertPage]);
  useEffect(() => { refreshAlertsRef.current = refreshAlerts; }, [refreshAlerts]);

  const refreshHealth = useCallback(async () => {
    try {
      const result = await api.health();
      setHealth(result);
      setApiError('');
    } catch (error) {
      setHealth(null);
      setApiError(error instanceof Error ? error.message : 'Detection API unavailable.');
    }
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    let active = true;
    const loadInitialData = async () => {
      const results = await Promise.allSettled([
        api.health(),
        api.settings(),
        api.alerts({ page: 1, page_size: 20 }),
        api.cameras(),
        api.sensors(),
      ]);
      if (!active) return;
      const [healthResult, settingsResult, alertsResult, camerasResult, sensorResult] = results;
      if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
      else setApiError(healthResult.reason instanceof Error ? healthResult.reason.message : 'Detection API unavailable.');
      if (settingsResult.status === 'fulfilled') {
        setSettings((current) => ({ ...current, ...settingsResult.value }));
        settingsRef.current = { ...DEFAULT_SETTINGS, ...settingsResult.value };
      }
      if (alertsResult.status === 'fulfilled') {
        setAlerts(alertsResult.value.items);
        setCounts(alertsResult.value.counts);
        setTotalAlerts(alertsResult.value.total);
      }
      if (camerasResult.status === 'fulfilled') setCameras(camerasResult.value.items);
      if (sensorResult.status === 'fulfilled') setSensorReadings(sensorResult.value.items);
    };
    void loadInitialData();
    const clock = window.setInterval(() => setNow(new Date()), 1000);
    const healthPoll = window.setInterval(() => void refreshHealth(), 10000);
    return () => {
      active = false;
      window.clearInterval(clock);
      window.clearInterval(healthPoll);
    };
  }, [refreshHealth]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshAlerts(alertPage).catch((error: unknown) => {
        setApiError(error instanceof Error ? error.message : 'Could not load incident history.');
      });
    }, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [refreshAlerts, alertPage, search]);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let reconnect: number | null = null;
    let delay = 1000;
    const connect = () => {
      if (!active) return;
      try {
        socket = api.websocket();
        socket.onopen = () => { delay = 1000; setWebsocketConnected(true); };
        socket.onmessage = (message) => {
          let event: LiveEvent;
          try { event = JSON.parse(message.data) as LiveEvent; }
          catch { setApiError('Received an invalid live event from the backend.'); return; }
          if (event.type === 'detection') {
            setDetections(event.data.detections);
            setConfirmedTypes(event.data.confirmed_types);
          }
          if (event.type === 'alert' || event.type === 'alert_updated') {
            mergeAlerts([event.data]);
            void refreshAlertsRef.current(alertPageRef.current).catch((error: unknown) => {
              setApiError(error instanceof Error ? error.message : 'Could not refresh incident history.');
            });
            if (event.type === 'alert' && !handledAlertIds.current.has(event.data.id)) {
              handledAlertIds.current.add(event.data.id);
              if (handledAlertIds.current.size > 1000) handledAlertIds.current.clear();
              if (event.data.type === 'Fire' && Date.now() - lastFireSound.current > 30000) {
                lastFireSound.current = Date.now();
                playAlarm();
              }
              notifyBrowser(event.data);
            }
          }
          if (event.type === 'alerts_cleared') {
            setAlerts([]);
            setCounts(EMPTY_COUNTS);
            setTotalAlerts(0);
            setAlertPage(1);
          }
          if (event.type === 'camera_added') setCameras((old) => [...old.filter((item) => item.id !== event.data.id), event.data]);
          if (event.type === 'camera_removed') setCameras((old) => old.filter((item) => item.id !== event.data.id));
          if (event.type === 'sensor_reading') setSensorReadings((old) => [event.data, ...old].slice(0, 60));
          if (event.type === 'settings_updated') {
            setSettings((old) => ({ ...old, ...event.data }));
            settingsRef.current = { ...settingsRef.current, ...event.data };
          }
        };
        socket.onerror = () => socket?.close();
        socket.onclose = () => {
          setWebsocketConnected(false);
          if (active) {
            reconnect = window.setTimeout(connect, delay);
            delay = Math.min(delay * 2, 15000);
          }
        };
      } catch {
        setWebsocketConnected(false);
        if (active) reconnect = window.setTimeout(connect, delay);
      }
    };
    connect();
    return () => {
      active = false;
      if (reconnect !== null) window.clearTimeout(reconnect);
      socket?.close();
    };
  }, [mergeAlerts]);

  useEffect(() => {
    if (page !== 'Analytics & Reports') return;
    let active = true;
    api.analytics(analyticsDays)
      .then((result) => { if (active) setAnalytics(result); })
      .catch((error: unknown) => { if (active) setApiError(error instanceof Error ? error.message : 'Analytics are unavailable.'); });
    return () => { active = false; };
  }, [page, analyticsDays, counts.total]);

  const playAlarm = useCallback(() => {
    if (!settingsRef.current.sound_enabled) return;
    try {
      const context = audioContext.current ?? new AudioContext();
      audioContext.current = context;
      const startAt = context.currentTime;
      const duration = 5;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(880, startAt);
      for (let sweep = 1; sweep <= 10; sweep += 1) {
        oscillator.frequency.linearRampToValueAtTime(sweep % 2 === 0 ? 880 : 660, startAt + sweep * 0.5);
      }
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.17, startAt + 0.03);
      gain.gain.setValueAtTime(0.17, startAt + duration - 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + duration);
    } catch { setToast('Alarm audio is unavailable in this browser.'); }
  }, []);

  const notifyBrowser = useCallback((alert: AlertRecord) => {
    if (!settingsRef.current.browser_notifications || !('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification(`${alert.type} detection · ${alert.location}`, {
      body: `${(alert.confidence * 100).toFixed(1)}% confidence · ${alert.risk}. Follow site emergency procedures.`,
      tag: alert.id,
    });
  }, []);

  useEffect(() => {
    if (frameTimer.current === null) return;
    window.clearInterval(frameTimer.current);
    frameTimer.current = window.setInterval(
      frameProcessor.current,
      settings.frame_interval_ms,
    );
  }, [settings.frame_interval_ms]);

  const persistSettings = useCallback((patch: Partial<DetectionSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    if (settingsSaveTimer.current !== null) window.clearTimeout(settingsSaveTimer.current);
    settingsSaveTimer.current = window.setTimeout(() => {
      void api.updateSettings(patch).then((saved) => {
        settingsRef.current = { ...settingsRef.current, ...saved };
        setSettings((current) => ({ ...current, ...saved }));
        setToast('Detection settings saved.');
      }).catch((error: unknown) => {
        setApiError(error instanceof Error ? error.message : 'Could not save detection settings.');
        setToast('Could not save settings. Check the backend connection.');
      });
    }, 350);
  }, []);

  const testEmail = useCallback(async () => {
    const recipient = settings.email_to.trim();
    if (!recipient) return;
    setTestingEmail(true);
    setApiError('');
    try {
      const saved = await api.updateSettings({ email_to: recipient });
      settingsRef.current = { ...settingsRef.current, ...saved };
      setSettings((current) => ({ ...current, ...saved }));
      const result = await api.testEmail();
      setToast(`Test email accepted for ${result.recipient}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not send the SMTP test email.';
      setApiError(message);
      setToast('SMTP test failed. Check the backend configuration and logs.');
    } finally {
      setTestingEmail(false);
    }
  }, [settings.email_to]);

  const acknowledge = useCallback(async (id: string) => {
    try {
      const updated = await api.acknowledge(id);
      setAlerts((old) => old.map((item) => item.id === id ? updated : item));
      setToast('Incident acknowledged.');
    } catch (error) {
      setApiError(error instanceof Error ? error.message : 'Could not acknowledge this alert.');
    }
  }, []);

  const clearAlerts = useCallback(async () => {
    if (!window.confirm('Permanently delete all incidents from the shared SQLite history? This cannot be undone.')) return;
    try {
      await api.clearAlerts();
      setAlerts([]);
      setCounts(EMPTY_COUNTS);
      setTotalAlerts(0);
      setAlertPage(1);
      setToast('Incident history cleared.');
    } catch (error) {
      setApiError(error instanceof Error ? error.message : 'Could not clear incident history.');
    }
  }, []);

  const exportFilteredCsv = useCallback(async () => {
    try {
      const first = await api.alerts({
        search, type: alertType, severity, date_from: dateFrom, date_to: dateTo, page: 1, page_size: 100,
      });
      const all = [...first.items];
      for (let currentPage = 2; all.length < first.total; currentPage += 1) {
        const next = await api.alerts({
          search, type: alertType, severity, date_from: dateFrom, date_to: dateTo,
          page: currentPage, page_size: 100,
        });
        if (!next.items.length) break;
        all.push(...next.items);
      }
      downloadCsv(all);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : 'Could not export incident history.');
    }
  }, [search, alertType, severity, dateFrom, dateTo]);

  const startDetectionLoop = useCallback(() => {
    if (frameTimer.current !== null) window.clearInterval(frameTimer.current);
    const processFrame = () => {
      if (frameBusy.current || !modelName) return;
      let frameSource: HTMLVideoElement | HTMLImageElement | null = null;
      if (mediaKindRef.current === 'camera') frameSource = videoRef.current;
      if (mediaKindRef.current === 'video') frameSource = fileVideoRef.current;
      if (mediaKindRef.current === 'image') frameSource = imageRef.current;
      if (!frameSource) return;

      const canvas = canvasRef.current ?? document.createElement('canvas');
      let width = 0;
      let height = 0;
      if (frameSource instanceof HTMLVideoElement) {
        if (frameSource.readyState < 2 || !frameSource.videoWidth) return;
        width = frameSource.videoWidth;
        height = frameSource.videoHeight;
      } else {
        if (!frameSource.complete || !frameSource.naturalWidth) return;
        width = frameSource.naturalWidth;
        height = frameSource.naturalHeight;
      }
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) { setDetectionError('Could not create an image-processing canvas.'); return; }
      context.drawImage(frameSource, 0, 0, width, height);
      canvas.toBlob(async (blob) => {
        if (!blob) { setDetectionError('Could not encode the current camera frame.'); return; }
        frameBusy.current = true;
        setBusy(true);
        const controller = new AbortController();
        frameController.current = controller;
        try {
          const result: DetectionResponse = await api.detect(
            blob, 'camera-frame.jpg', settingsRef.current, sourceLocationRef.current, controller.signal,
            mediaKindRef.current === 'camera' || mediaKindRef.current === 'video',
          );
          setDetectionError('');
          setDetections(result.detections);
          setConfirmedTypes(result.confirmed_types);
          if (result.alerts.length) {
            mergeAlerts(result.alerts);
            void refreshAlertsRef.current(alertPageRef.current).catch((error: unknown) => {
              setApiError(error instanceof Error ? error.message : 'Could not refresh incident history.');
            });
            for (const alert of result.alerts) {
              if (handledAlertIds.current.has(alert.id)) continue;
              handledAlertIds.current.add(alert.id);
              if (handledAlertIds.current.size > 1000) handledAlertIds.current.clear();
              if (alert.type === 'Fire' && Date.now() - lastFireSound.current > 30000) {
                lastFireSound.current = Date.now();
                playAlarm();
              }
              notifyBrowser(alert);
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            setDetections([]);
            setConfirmedTypes([]);
            setDetectionError(error instanceof Error ? error.message : 'Frame inference failed.');
          }
        } finally {
          frameBusy.current = false;
          frameController.current = null;
          setBusy(false);
        }
      }, 'image/jpeg', 0.88);
    };
    frameProcessor.current = processFrame;
    processFrame();
    frameTimer.current = window.setInterval(processFrame, settingsRef.current.frame_interval_ms);
  }, [mergeAlerts, modelName, notifyBrowser, playAlarm]);

  const stopMonitoring = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (fileVideoRef.current) fileVideoRef.current.srcObject = null;
    if (frameTimer.current !== null) window.clearInterval(frameTimer.current);
    frameTimer.current = null;
    frameProcessor.current = () => undefined;
    frameController.current?.abort();
    if (fileVideoRef.current) {
      fileVideoRef.current.pause();
      fileVideoRef.current.removeAttribute('src');
      fileVideoRef.current.load();
    }
    imageRef.current?.removeAttribute('src');
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = '';
    }
    mediaKindRef.current = null;
    setMediaKind(null);
    setCameraActive(false);
    setDetections([]);
    setConfirmedTypes([]);
  }, []);

  useEffect(() => {
    if (!cameraActive || !streamRef.current) return;
    const stream = streamRef.current;
    if (videoRef.current && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => setCameraError('Camera stream opened, but the browser could not play its preview.'));
    }
    if (fileVideoRef.current && fileVideoRef.current.srcObject !== stream) {
      fileVideoRef.current.srcObject = stream;
    }
  }, [cameraActive, page]);

  const startCamera = useCallback(async (deviceId?: string, camera?: CameraRecord) => {
    setCameraError('');
    if (!health?.model_loaded) {
      setCameraError(modelError || 'Start the backend with a valid YOLO model before monitoring.');
      return;
    }
    stopMonitoring();
    try {
      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices?.getUserMedia) throw new Error('Camera access is not available. Use localhost or HTTPS.');
      const stream = await mediaDevices.getUserMedia({
        audio: false,
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      mediaKindRef.current = 'camera';
      setMediaKind('camera');
      if (videoRef.current) videoRef.current.srcObject = stream;
      if (fileVideoRef.current) fileVideoRef.current.srcObject = stream;
      setCameraActive(true);
      const track = stream.getVideoTracks()[0];
      setSourceName(camera?.name ?? track?.label ?? 'Webcam');
      const location = camera?.location ?? 'Unassigned camera';
      sourceLocationRef.current = location;
      setDetectionLocation(location);
      setCameraId(track?.getSettings().deviceId ?? deviceId ?? '');
      const available = await mediaDevices.enumerateDevices();
      setCameraDevices(available.filter((item) => item.kind === 'videoinput'));
      setPage('Live Detection');
      window.setTimeout(startDetectionLoop, 450);
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      mediaKindRef.current = null;
      setMediaKind(null);
      setCameraActive(false);
      const name = error instanceof Error ? error.name : '';
      setCameraError(name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access in your browser settings and retry.'
        : name === 'NotFoundError'
          ? 'No camera was found. Connect a camera or upload image/video footage.'
          : error instanceof Error ? error.message : 'Could not start the webcam.');
    }
  }, [health?.model_loaded, modelError, startDetectionLoop, stopMonitoring]);

  const loadFile = useCallback((file?: File) => {
    if (!file) return;
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) {
      setDetectionError('Choose a supported image or video file.');
      return;
    }
    if (!health?.model_loaded) {
      setDetectionError(modelError || 'Start the backend with a valid YOLO model before uploading footage.');
      return;
    }
    stopMonitoring();
    setDetectionError('');
    const url = URL.createObjectURL(file);
    objectUrl.current = url;
    setSourceName(file.name);
    const location = `Upload · ${file.name}`;
    sourceLocationRef.current = location;
    setDetectionLocation(location);
    mediaKindRef.current = isImage ? 'image' : 'video';
    setMediaKind(mediaKindRef.current);
    if (isImage && imageRef.current) {
      imageRef.current.onload = () => setMediaSize({
        width: imageRef.current?.naturalWidth ?? 16,
        height: imageRef.current?.naturalHeight ?? 9,
      });
      imageRef.current.src = url;
    }
    if (isVideo && fileVideoRef.current) {
      fileVideoRef.current.onloadedmetadata = () => setMediaSize({
        width: fileVideoRef.current?.videoWidth ?? 16,
        height: fileVideoRef.current?.videoHeight ?? 9,
      });
      fileVideoRef.current.srcObject = null;
      fileVideoRef.current.src = url;
      fileVideoRef.current.load();
      fileVideoRef.current.play().catch(() => setDetectionError('Could not play this video in the browser.'));
    }
    setPage('Live Detection');
    window.setTimeout(startDetectionLoop, isImage ? 250 : 600);
  }, [health?.model_loaded, modelError, startDetectionLoop, stopMonitoring]);

  const discoverCameras = useCallback(async () => {
    setCameraError('');
    try {
      if (!navigator.mediaDevices?.enumerateDevices) throw new Error('Camera discovery is not supported in this browser.');
      const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      permissionStream.getTracks().forEach((track) => track.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((item) => item.kind === 'videoinput');
      setCameraDevices(videoDevices);
      setToast(videoDevices.length ? `Found ${videoDevices.length} available camera${videoDevices.length === 1 ? '' : 's'}.` : 'No cameras are connected.');
    } catch (error) {
      setCameraError(error instanceof Error && error.name === 'NotAllowedError'
        ? 'Camera discovery needs permission. Allow camera access in browser settings.'
        : error instanceof Error ? error.message : 'Could not discover cameras.');
    }
  }, []);

  const addCamera = useCallback(async () => {
    if (!newCameraName.trim() || !newCameraLocation.trim()) {
      setApiError('Enter both a camera name and a location zone.');
      return;
    }
    setSavingCamera(true);
    try {
      const camera = await api.createCamera({
        name: newCameraName.trim(),
        location: newCameraLocation.trim(),
        device_id: newCameraDevice,
      });
      setCameras((old) => [...old, camera]);
      setNewCameraName('');
      setNewCameraLocation('');
      setNewCameraDevice('');
      setToast('Camera configuration saved.');
    } catch (error) {
      setApiError(error instanceof Error ? error.message : 'Could not save camera configuration.');
    } finally { setSavingCamera(false); }
  }, [newCameraDevice, newCameraLocation, newCameraName]);

  const removeCamera = useCallback(async (camera: CameraRecord) => {
    if (!window.confirm(`Remove "${camera.name}" from camera management?`)) return;
    try {
      await api.removeCamera(camera.id);
      setCameras((old) => old.filter((item) => item.id !== camera.id));
      setToast('Camera configuration removed.');
    } catch (error) {
      setApiError(error instanceof Error ? error.message : 'Could not remove camera.');
    }
  }, []);

  const requestBrowserNotifications = useCallback(async (enabled: boolean) => {
    if (enabled && !('Notification' in window)) {
      setToast('Browser notifications are not supported here.');
      return;
    }
    if (enabled && Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setToast('Browser notification permission was not granted.');
        return;
      }
    }
    persistSettings({ browser_notifications: enabled });
  }, [persistSettings]);

  const exportAllReports = useCallback(async () => {
    try {
      const first = await api.alerts({ page: 1, page_size: 100 });
      const all = [...first.items];
      for (let current = 2; all.length < first.total; current += 1) {
        const next = await api.alerts({ page: current, page_size: 100 });
        if (!next.items.length) break;
        all.push(...next.items);
      }
      downloadCsv(all);
      setToast(`Exported ${all.length} persisted incident${all.length === 1 ? '' : 's'} as CSV.`);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : 'Could not export reports.');
    }
  }, []);

  useEffect(() => () => {
    if (frameTimer.current !== null) window.clearInterval(frameTimer.current);
    frameController.current?.abort();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    if (settingsSaveTimer.current !== null) window.clearTimeout(settingsSaveTimer.current);
    audioContext.current?.close();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const chartData = useMemo(() => {
    const dateMap = new Map((analytics?.series ?? []).map((item) => [item.date, item]));
    return Array.from({ length: analyticsDays }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (analyticsDays - index - 1));
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const item = dateMap.get(key);
      return {
        day: analyticsDays <= 7
          ? date.toLocaleDateString(undefined, { weekday: 'short' })
          : date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }),
        fire: item?.fire ?? 0,
        smoke: item?.smoke ?? 0,
      };
    });
  }, [analytics, analyticsDays]);
  const riskPie = [
    { name: 'Critical · Fire', value: counts.fire, color: '#FF3B30' },
    { name: 'Warning · Smoke', value: counts.smoke, color: '#FFC107' },
  ];
  const formattedDate = now.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const onNavigate = (nextPage: Page) => {
    setPage(nextPage);
    setMobileNav(false);
  };
  const showEmergencyGuide = () => setEmergencyGuideOpen(true);

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${accessibilityMode ? 'accessibility-mode' : ''}`}>
      {mobileNav && <button className="sidebar-backdrop" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}
      <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
        <div className="brand">
        <img className="brand-logo" src="/emberwatch-logo.png" alt="Emberwatch" />
          <button className="icon-btn mobile-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={18} /></button>
        </div>
        <div className="workspace-label">MONITORING</div>
        <nav className="navigation" aria-label="Main navigation">
          {NAV_ITEMS.map(({ name, icon: Icon }) => (
            <button key={name} title={sidebarCollapsed ? name : undefined} onClick={() => onNavigate(name)} className={`nav-item ${page === name ? 'active' : ''}`}>
              <Icon size={18} strokeWidth={1.8} /><span>{name}</span>
              {name === 'Alert History' && counts.total > 0 && <span className="nav-count">{counts.total > 99 ? '99+' : counts.total}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="safety-card"><div className="safety-icon"><ShieldCheck size={18} /></div><strong>Safety first</strong><p>Decision support only. Keep certified fire alarms active.</p></div>
          <div className="sidebar-user">
            <div className="avatar">EW</div>
            <div className="user-copy"><strong>Site operator</strong><span>Local workspace</span></div>
            <button className="icon-btn" title="System information" onClick={() => setToast(`Emberwatch · ${health?.database ?? 'API offline'} · SQLite persistence`)}><CircleHelp size={17} /></button>
            <button className="icon-btn" title="Sign out" aria-label="Sign out" onClick={onLogout}><LogOut size={17} /></button>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="icon-btn mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button>
          <button className="icon-btn sidebar-toggle" onClick={() => setSidebarCollapsed((old) => !old)} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {sidebarCollapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
          </button>
          <div className="breadcrumb"><span>EMBERWATCH</span><span className="crumb-slash">/</span><strong>{page}</strong></div>
          <div className="topbar-right">
            <div className={`system-pill ${health?.status === 'ok' && websocketConnected ? 'is-online' : ''}`}><span className="status-dot" />{health?.status === 'ok' ? websocketConnected ? 'System online' : 'API online · reconnecting' : 'System offline'}</div>
            <div className="topbar-date"><Clock3 size={15} /><span>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>
            <button className={`icon-btn accessibility-toggle ${accessibilityMode ? 'accessibility-active' : ''}`} title={accessibilityMode ? 'Turn off accessibility mode' : 'Turn on accessibility mode'} aria-label={accessibilityMode ? 'Turn off accessibility mode' : 'Turn on accessibility mode'} aria-pressed={accessibilityMode} onClick={() => setAccessibilityMode((old) => !old)}><Accessibility size={18} /></button>
            <button className="icon-btn top-bell" title="View alerts" onClick={() => onNavigate('Alert History')}><Bell size={18} />{counts.total > 0 && <i />}</button>
          </div>
        </header>

        <div className="page-content">
          {apiError && <div className="global-error"><AlertTriangle size={15} /><span>{apiError}</span><button onClick={() => setApiError('')} aria-label="Dismiss error"><X size={15} /></button></div>}

          {(page === 'Dashboard' || page === 'Live Detection') && <>
            <section className="page-heading">
              <div><div className="eyebrow"><span className="eyebrow-line" /> {page === 'Dashboard' ? 'FACILITY OVERVIEW' : 'LIVE COMPUTER VISION'}</div>
                <h1>{page === 'Dashboard' ? 'Good Morning, Operator.' : 'Live Detection'}</h1>
                <p>{page === 'Dashboard' ? `${formattedDate} · Here’s the current status of your monitored environment.` : 'Webcam and uploaded media are analyzed by the configured YOLO model.'}</p>
              </div>
              <div className="heading-actions"><span className={`model-badge ${health?.model_loaded ? '' : 'model-missing'}`} title={modelError}><Cpu size={15} />{health?.model_loaded ? `YOLO · ${health.model}` : 'AI model unavailable'}</span>
                <button className="btn btn-danger-ghost emergency-action" onClick={showEmergencyGuide}><Siren size={15} /> Emergency response</button>
                <button className="btn btn-primary" onClick={() => monitoring ? stopMonitoring() : void startCamera()}>{monitoring ? <><X size={15} /> Stop monitoring</> : <><Video size={15} /> Start camera</>}</button>
              </div>
            </section>

            {fireConfirmed && <div className="critical-banner"><div className="critical-pulse"><Siren size={20} /></div><div><strong>FIRE DETECTION CONFIRMED — VERIFY SAFELY</strong><p>Model output can be a false positive. Activate your verified site plan and contact emergency services as appropriate.</p></div><button className="btn btn-ghost" onClick={() => onNavigate('Emergency Response')}>Open response center</button></div>}
            {!fireConfirmed && smokeConfirmed && <div className="smoke-banner"><div className="smoke-pulse"><AlertTriangle size={19} /></div><div><strong>SMOKE DETECTION CONFIRMED — CHECK FROM A SAFE DISTANCE</strong><p>Investigate safely and follow your facility response plan.</p></div><button className="btn btn-ghost" onClick={() => onNavigate('Emergency Response')}>Open response center</button></div>}

            {page === 'Dashboard' && <section className="stats-grid overview-stats">
              <StatCard label="SYSTEM STATUS" value={health?.status === 'ok' ? 'Online' : 'Offline'} icon={Activity} tone={health?.status === 'ok' ? 'green' : 'red'} detail={health?.status === 'ok' ? `${websocketConnected ? 'Live updates connected' : 'Live updates reconnecting'}` : 'Check FastAPI service'} />
              <StatCard label="CAMERA STATUS" value={cameraActive ? 'Active' : 'Inactive'} icon={Camera} tone={cameraActive ? 'green' : 'muted'} detail={cameraActive ? sourceName : `${cameraDevices.length} browser camera${cameraDevices.length === 1 ? '' : 's'} discovered`} />
              <StatCard label="AI DETECTION" value={currentRisk} icon={currentRisk === 'NORMAL' ? ShieldCheck : ShieldAlert} tone={currentRisk === 'NORMAL' ? 'green' : currentRisk === 'CRITICAL' ? 'red' : 'amber'} detail={detections.length ? `${detections.length} model finding${detections.length === 1 ? '' : 's'} in latest frame` : modelName ? 'No detections in latest frame' : 'Model not available'} />
              <StatCard label="TOTAL INCIDENTS" value={`${counts.total}`} icon={Bell} tone={counts.critical ? 'red' : 'amber'} detail={`${fireCount} fire · ${smokeCount} smoke · SQLite`} />
              <StatCard label="SYSTEM UPTIME" value={health ? formatDuration(health.uptime_seconds) : '—'} icon={Zap} tone={health ? 'green' : 'muted'} detail={health?.database === 'sqlite' ? 'Backend and database' : 'Waiting for backend'} />
            </section>}

            <section className={page === 'Dashboard' ? 'primary-grid' : 'live-page-grid'}>
              <FeedPanel
                detections={detections}
                confirmedTypes={confirmedTypes}
                detectionError={detectionError}
                cameraError={cameraError}
                mediaKind={mediaKind}
                fileVideoRef={bindFileVideo}
                videoRef={bindVideo}
                imageRef={bindImage}
                canvasRef={bindCanvas}
                mediaSize={mediaSize}
                setMediaSize={setMediaSize}
                online={Boolean(health?.model_loaded)}
                busy={busy}
                monitoring={monitoring}
                sourceName={sourceName}
                onStart={() => void startCamera()}
                onStop={stopMonitoring}
                onUploadImage={() => imageInputRef.current?.click()}
                onUploadVideo={() => videoInputRef.current?.click()}
                onFullscreen={(element) => void element?.requestFullscreen().catch(() => setToast('Fullscreen is unavailable in this browser.'))}
              />
              {page === 'Dashboard' && <div className="right-stack">
                <DetectionSummary detections={confirmedDetections} fireCount={fireCount} smokeCount={smokeCount} settings={settings} lastDetection={alerts[0]?.timestamp ?? ''} />
                <EmergencyGuide critical={currentRisk === 'CRITICAL'} smoke={currentRisk === 'WARNING' || currentRisk === 'LOW RISK'} onOpen={showEmergencyGuide} />
              </div>}
            </section>

            {page === 'Dashboard' && <section className="lower-grid">
              <EnvironmentalPanel latestSensor={latestSensor} detections={detections} />
              <div className="panel recent-panel"><div className="panel-header"><div><h2>Recent incidents</h2><p>Persistent SQLite alert history</p></div><button className="text-button" onClick={() => onNavigate('Alert History')}>View all <ChevronRight size={14} /></button></div>
                {!alerts.length ? <EmptyState title="No incidents recorded" detail="Real model detections appear here when automatic logging is enabled." /> :
                  <div className="recent-list">{alerts.slice(0, 5).map((alert) => <div className="recent-row" key={alert.id}><span className={`recent-mark ${alert.type === 'Fire' ? 'mark-fire' : 'mark-smoke'}`}>{alert.type === 'Fire' ? <Flame size={15} /> : <Activity size={15} />}</span><div className="recent-detail"><strong>{alert.type} · {alert.risk}</strong><span>{alert.location}</span></div><div className="recent-meta"><strong>{(alert.confidence * 100).toFixed(1)}%</strong><span>{new Date(alert.timestamp).toLocaleTimeString()}</span></div></div>)}</div>}
              </div>
            </section>}
          </>}

          {page === 'Alert History' && <section className="subpage">
            <PageTitle eyebrow="INCIDENT MANAGEMENT" title="Alert History" description="Search, acknowledge, filter, and export incidents persisted in SQLite." />
            <div className="stats-grid small-stats"><StatCard label="TOTAL ALERTS" value={`${counts.total}`} icon={Bell} tone="amber" detail="Persistent database records" /><StatCard label="FIRE INCIDENTS" value={`${fireCount}`} icon={Flame} tone="red" detail="YOLO fire-class detections" /><StatCard label="SMOKE INCIDENTS" value={`${smokeCount}`} icon={Activity} tone="amber" detail="YOLO smoke-class detections" /><StatCard label="CRITICAL INCIDENTS" value={`${counts.critical}`} icon={ShieldAlert} tone="red" detail="Awaiting acknowledgement or reviewed" /></div>
            <div className="panel table-panel"><div className="table-toolbar"><div><h2>Incident log</h2><p>{totalAlerts} matching · page {alertPage} of {pageCount}</p></div><div className="table-actions">
              <label className="search-field"><Search size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setAlertPage(1); }} placeholder="Search zone or action…" /></label>
              <select className="filter-select" value={alertType} onChange={(event) => { setAlertType(event.target.value); setAlertPage(1); }} aria-label="Filter by detection type"><option value="">All detections</option><option value="Fire">Fire</option><option value="Smoke">Smoke</option></select>
              <select className="filter-select" value={severity} onChange={(event) => { setSeverity(event.target.value); setAlertPage(1); }} aria-label="Filter by severity"><option value="">All severity</option><option value="Critical">Critical</option><option value="Warning">Warning</option></select>
              <label className="date-filter"><span>From</span><input aria-label="Filter from date" type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); setAlertPage(1); }} /></label>
              <label className="date-filter"><span>To</span><input aria-label="Filter to date" type="date" value={dateTo} onChange={(event) => { setDateTo(event.target.value); setAlertPage(1); }} /></label>
              <button className="btn btn-ghost" onClick={() => void exportFilteredCsv()}><Download size={14} /> Export CSV</button>
              <button className="btn btn-ghost" onClick={() => window.print()}><ArrowDownToLine size={14} /> Print / PDF</button>
              <button className="btn btn-danger-ghost" onClick={() => void clearAlerts()}><Trash2 size={14} /> Clear</button>
            </div></div>
              {!alerts.length ? <EmptyState title={totalAlerts ? 'No matching incidents' : 'No alerts recorded yet'} detail={totalAlerts ? 'Adjust your filters to see matching history.' : 'Start real-model monitoring to create a persistent incident record.'} /> :
                <div className="table-scroll"><table><thead><tr><th>TIMESTAMP</th><th>DETECTION TYPE</th><th>LOCATION ZONE</th><th>CONFIDENCE</th><th>SEVERITY</th><th>ACKNOWLEDGEMENT</th></tr></thead><tbody>
                  {alerts.map((alert) => <tr key={alert.id}><td className="timestamp-cell">{new Date(alert.timestamp).toLocaleString()}</td><td><span className={`type-pill ${alert.type === 'Fire' ? 'fire-type' : 'smoke-type'}`}>{alert.type === 'Fire' ? <Flame size={13} /> : <Activity size={13} />}{alert.type}</span></td><td>{alert.location}</td><td className="confidence-cell">{(alert.confidence * 100).toFixed(1)}%</td><td><span className={`risk-pill ${alert.risk === 'Critical' ? 'critical-pill' : 'warning-pill'}`}><i />{alert.risk}</span></td><td>{alert.acknowledged ? <span className="acknowledged"><Check size={13} />{alert.action}</span> : <button className="review-button" onClick={() => void acknowledge(alert.id)}>Acknowledge</button>}</td></tr>)}
                </tbody></table></div>}
              <div className="pagination"><span>Showing {totalAlerts ? (alertPage - 1) * 20 + 1 : 0}–{Math.min(alertPage * 20, totalAlerts)} of {totalAlerts}</span><div><button className="icon-btn" disabled={alertPage <= 1} onClick={() => setAlertPage((value) => Math.max(1, value - 1))} aria-label="Previous page"><ChevronLeft size={17} /></button><strong>{alertPage}</strong><button className="icon-btn" disabled={alertPage >= pageCount} onClick={() => setAlertPage((value) => Math.min(pageCount, value + 1))} aria-label="Next page"><ChevronRight size={17} /></button></div></div>
            </div>
          </section>}

          {page === 'Camera Management' && <section className="subpage">
            <PageTitle eyebrow="DEVICE MANAGEMENT" title="Camera Management" description="Register browser camera configurations and only mark a camera active after permission is granted." />
            <div className="camera-management-grid"><div className="panel device-panel">
              <div className="panel-header"><div><h2>Configured cameras</h2><p>{cameras.length} saved configuration{cameras.length === 1 ? '' : 's'} · connected state reflects this browser session</p></div><button className="btn btn-ghost" onClick={() => void discoverCameras()}><Wifi size={14} /> Discover devices</button></div>
              {cameraError && <div className="inline-error"><AlertTriangle size={15} /><span>{cameraError}</span></div>}
              {!cameras.length ? <EmptyState title="No camera configurations" detail="Add a configuration, then connect it to request real browser camera permission." /> : <div className="camera-list">{cameras.map((camera) => {
                const isConnected = cameraActive && camera.device_id !== '' && camera.device_id === cameraId;
                return <div className="camera-record" key={camera.id}><span className={`device-indicator ${isConnected ? 'device-active' : ''}`}><Camera size={19} /></span><div className="camera-record-main"><strong>{camera.name}</strong><span>{camera.location}</span><small>Camera ID · {camera.device_id ? `${camera.device_id.slice(0, 14)}…` : 'Not linked to a browser device'}</small></div><span className={`camera-state ${isConnected ? 'connected-text' : ''}`}><i />{isConnected ? 'Active' : 'Inactive'}</span><button className="btn btn-ghost" onClick={() => void startCamera(camera.device_id || undefined, camera)}>{isConnected ? 'Reconnect' : 'Start'}</button><button className="icon-btn" title="Remove camera" onClick={() => void removeCamera(camera)}><Trash2 size={15} /></button></div>;
              })}</div>}
              <div className="camera-add-form"><div className="form-grid"><label className="form-field"><span>Camera name</span><input value={newCameraName} onChange={(event) => setNewCameraName(event.target.value)} placeholder="e.g. Loading Bay 1" /></label><label className="form-field"><span>Location zone</span><input value={newCameraLocation} onChange={(event) => setNewCameraLocation(event.target.value)} placeholder="e.g. Warehouse North" /></label><label className="form-field"><span>Browser camera ID</span><select value={newCameraDevice} onChange={(event) => setNewCameraDevice(event.target.value)}><option value="">Unassigned · choose on connect</option>{cameraDevices.map((device, index) => <option value={device.deviceId} key={device.deviceId}>{device.label || `Browser camera ${index + 1}`}</option>)}</select></label></div><button className="btn btn-primary" disabled={savingCamera} onClick={() => void addCamera()}><Plus size={15} /> {savingCamera ? 'Saving…' : 'Add camera configuration'}</button></div>
              <div className="info-callout"><Wifi size={16} /><span>A saved configuration is not a connected device. The camera will be labeled active only while this browser holds an authorized live stream. Multiple streams are not processed concurrently.</span></div>
            </div>                        <div className="panel settings-card"><div className="panel-header"><div><h2>Live camera preview</h2><p>{cameraActive ? sourceName : 'No browser camera stream active'}</p></div><span className={`live-badge ${cameraActive ? 'live' : ''}`}><span />{cameraActive ? 'LIVE' : 'OFFLINE'}</span></div><div className={`camera-preview ${cameraActive ? 'preview-active' : ''}`}><video ref={bindVideo} className={cameraActive ? 'preview-visible' : ''} autoPlay muted playsInline /><div className="preview-placeholder"><Camera size={24} /><span>{cameraActive ? 'Video preview appears in Live Detection' : 'Connect an authorized browser camera to preview'}</span></div></div><div className="device-actions"><button className="btn btn-primary" onClick={() => cameraActive ? stopMonitoring() : void startCamera()}>{cameraActive ? 'Stop camera' : 'Connect webcam'}</button><button className="btn btn-ghost" onClick={() => onNavigate('Live Detection')}>Open live detection</button></div></div></div>
          </section>}

          {page === 'Analytics & Reports' && <section className="subpage">
            <PageTitle eyebrow="INCIDENT INSIGHTS" title="Analytics & Reports" description="Interactive statistics are computed from real YOLO detections persisted in SQLite." />
            <div className="stats-grid small-stats"><StatCard label="TOTAL INCIDENTS" value={`${counts.total}`} icon={AlertTriangle} tone="amber" detail="All recorded time" /><StatCard label="FIRE DETECTIONS" value={`${counts.fire}`} icon={Flame} tone="red" detail="YOLO fire class" /><StatCard label="SMOKE DETECTIONS" value={`${counts.smoke}`} icon={Activity} tone="amber" detail="YOLO smoke class" /><StatCard label="AVERAGE CONFIDENCE" value={analytics?.average_confidence === null || analytics?.average_confidence === undefined ? '—' : `${(analytics.average_confidence * 100).toFixed(1)}%`} icon={Cpu} tone="green" detail={`Last ${analyticsDays} days`} /></div>
            <div className="analytics-filter-bar"><span>Report window</span>{[7, 30, 90, 365].map((days) => <button key={days} className={`period-chip ${analyticsDays === days ? 'selected' : ''}`} onClick={() => setAnalyticsDays(days)}>{days === 7 ? '7 days' : days === 30 ? '30 days' : days === 90 ? '3 months' : '12 months'}</button>)}<button className="btn btn-ghost analytics-export" onClick={() => void exportAllReports()}><Download size={14} /> Download incident report (CSV)</button><button className="btn btn-ghost" onClick={() => window.print()}><ArrowDownToLine size={14} /> Print / PDF</button></div>
            <div className="analytics-grid">
              <div className="panel chart-panel">
                <div className="panel-header">
                  <div><h2>Detection trends</h2><p>Daily fire and smoke incidents · last {analyticsDays} days</p></div>
                  <span className="chart-legend"><i className="legend-fire" />Fire <i className="legend-smoke" />Smoke</span>
                </div>
                {!counts.total && <div className="chart-empty">Trends will appear after the first real model detection.</div>}
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 10, right: 8, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="fireGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#FF3B30" stopOpacity={0.24} />
                          <stop offset="95%" stopColor="#FF3B30" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="smokeGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#FFC107" stopOpacity={0.22} />
                          <stop offset="95%" stopColor="#FFC107" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#293241" strokeDasharray="3 5" vertical={false} />
                      <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fill: '#94A3B8', fontSize: 10 }} dy={9} minTickGap={18} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#94A3B8', fontSize: 10 }} />
                      <Tooltip contentStyle={{ background: '#171E28', border: '1px solid #293241', borderRadius: 9, color: '#F8FAFC' }} />
                      <Area type="monotone" dataKey="fire" name="Fire" stroke="#FF3B30" strokeWidth={2} fill="url(#fireGradient)" />
                      <Area type="monotone" dataKey="smoke" name="Smoke" stroke="#FFC107" strokeWidth={2} fill="url(#smokeGradient)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="panel chart-panel distribution-panel"><div className="panel-header"><div><h2>Risk distribution</h2><p>Severity is derived from detected class</p></div></div>{!counts.total ? <EmptyState title="No incidents yet" detail="The chart uses recorded model detections only." /> : <><div className="donut-wrap"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={riskPie.filter((item) => item.value > 0)} dataKey="value" innerRadius={66} outerRadius={88} paddingAngle={5} stroke="none">{riskPie.filter((item) => item.value > 0).map((item) => <Cell key={item.name} fill={item.color} />)}</Pie><Tooltip contentStyle={{ background: '#171a20', border: '1px solid #30333b', borderRadius: 9 }} /></PieChart></ResponsiveContainer><div className="donut-total"><strong>{counts.total}</strong><span>incidents</span></div></div><div className="distribution-legend">{riskPie.map((item) => <span key={item.name}><i style={{ background: item.color }} />{item.name}<strong>{item.value}</strong></span>)}</div></>}</div></div>
            <div className="panel analytics-note"><Shield size={17} /><span><strong>Observed detections, not a risk prediction.</strong> Charts reflect persisted model outputs; sensor readings and AI-predicted future risk are not fabricated.</span></div>
          </section>}

          {page === 'Detection Settings' && <section className="subpage">
            <PageTitle eyebrow="SYSTEM CONFIGURATION" title="Detection Settings" description="Persisted thresholds and alert settings are applied to live frame inference." />
            <div className="settings-grid"><div className="panel settings-card"><div className="panel-header"><div><h2>AI model & backend</h2><p>Inference service and loaded checkpoint status</p></div><span className={`system-pill ${health?.status === 'ok' ? 'is-online' : ''}`}><span className="status-dot" />{health?.status === 'ok' ? 'API connected' : 'Offline'}</span></div>
              <div className="setting-row"><div><strong>FastAPI service</strong><span>{apiError || 'http://localhost:8000'}</span></div><span className={`connection-state ${health?.status === 'ok' ? 'connected-text' : ''}`}><i />{health?.status === 'ok' ? 'Reachable' : 'Unavailable'}</span></div>
              <div className="setting-row"><div><strong>YOLO detector</strong><span>{modelName || modelError}</span></div><Cpu size={17} className="muted-icon" /></div>
              <div className="setting-row"><div><strong>Database & live feed</strong><span>SQLite · {websocketConnected ? 'WebSocket connected' : 'WebSocket reconnecting'}</span></div><span className="connection-state connected-text"><i />{health?.database === 'sqlite' ? 'Ready' : 'Unavailable'}</span></div>
              <ThresholdControl label="Fire confidence threshold" value={settings.fire_threshold} onChange={(value) => persistSettings({ fire_threshold: value })} />
              <ThresholdControl label="Smoke confidence threshold" value={settings.smoke_threshold} onChange={(value) => persistSettings({ smoke_threshold: value })} />
              <label className="range-field interval-field"><span>Frame processing interval <strong>{(settings.frame_interval_ms / 1000).toFixed(1)} sec</strong></span><input type="range" min="500" max="8000" step="500" value={settings.frame_interval_ms} onChange={(event) => persistSettings({ frame_interval_ms: Number(event.target.value) })} /><div className="range-ends"><span>Faster sampling</span><span>Reduce CPU load</span></div></label>
              <p className="settings-note">Lower confidence thresholds increase sensitivity and can increase false positives. Evaluate thresholds using your installed detector and intended environment.</p>
            </div>
              <div className="panel settings-card"><div className="panel-header"><div><h2>Alert configuration</h2><p>These preferences persist in SQLite and affect live notifications.</p></div><Bell size={17} className="muted-icon" /></div>
                <ToggleRow title="Emergency alarm sound" description="Play a 5-second two-tone siren for model-confirmed fire detections." checked={settings.sound_enabled} onChange={(value) => persistSettings({ sound_enabled: value })} />
                <div className="setting-row"><div><strong>Test emergency siren</strong><span>Play the 5-second alarm once to verify browser audio output.</span></div><button className="btn btn-ghost" disabled={!settings.sound_enabled} onClick={playAlarm}>Test alarm</button></div>
                <ToggleRow title="Automatic incident logging" description="Write deduplicated model detections to persistent SQLite alert history." checked={settings.auto_logging} onChange={(value) => persistSettings({ auto_logging: value })} />
                <ToggleRow title="Browser notifications" description="Show desktop notifications when this browser receives an incident." checked={settings.browser_notifications} onChange={(value) => void requestBrowserNotifications(value)} />
                <div className="email-config"><label className="form-field"><span>Critical-alert recipient</span><input type="email" value={settings.email_to} onChange={(event) => setSettings((old) => ({ ...old, email_to: event.target.value }))} placeholder="safety@example.org" /></label><div className="email-actions"><span className={`connection-state ${health?.email_configured ? 'connected-text' : ''}`}><i />{health?.email_configured ? 'SMTP configured' : 'SMTP credentials required'}</span><button className="btn btn-ghost" disabled={!health?.email_configured || !settings.email_to.trim() || testingEmail} onClick={() => void testEmail()}>{testingEmail ? 'Sending test…' : 'Send test email'}</button><button className="btn btn-ghost" disabled={!health?.email_configured || !settings.email_to.trim()} onClick={() => persistSettings({ email_to: settings.email_to.trim(), email_notifications: !settings.email_notifications })}>{settings.email_notifications ? 'Disable email' : 'Enable email alerts'}</button></div><p className="settings-note">Configure SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, SMTP_FROM and TLS mode in backend .env, then restart FastAPI. Credentials stay on the backend; use Send test email to verify delivery before enabling alerts.</p></div>
                <div className="setting-row"><div><strong>Configured cameras</strong><span>{cameras.length} saved · browser streams require permission</span></div><button className="text-button" onClick={() => onNavigate('Camera Management')}>Manage cameras <ExternalLink size={13} /></button></div>
              </div>
              <div className="panel settings-card full-setting"><div className="panel-header"><div><h2>Sensor integration</h2><p>ESP32 / IoT ingestion endpoint</p></div><Thermometer size={17} className="muted-icon" /></div><div className="sensor-warning"><AlertTriangle size={17} /><span><strong>Only real readings are stored.</strong> POST sensor values to <code>http://localhost:8000/api/sensors</code> as JSON: <code>{'{"sensor_id":"esp32-01","temperature_c":23.5,"carbon_monoxide_ppm":2.1,"smoke_ppm":0.4}'}</code>. Configure SENSOR_API_KEY in backend .env and send it as X-Sensor-Key. Until a sensor posts data, temperature and gas values remain unavailable.</span></div></div>
            </div>
          </section>}

          {page === 'Emergency Response' && <EmergencyResponsePage
            fireActive={fireConfirmed}
            confirmedLocation={detectionLocation}
            accessibleMode={accessibilityMode}
          />}
          {page === 'Evacuation Assistant' && <EvacuationAssistant
            fireActive={fireConfirmed}
            confirmedLocation={detectionLocation}
          />}
          {page === 'Wireless Cameras' && <WirelessCameras />}
          {page === 'Human-centered Testing' && <DesignThinkingLab accessibleMode={accessibilityMode} />}

          <footer className="page-footer"><span>EMBERWATCH <span className="footer-dot">·</span> AI-POWERED INDUSTRIAL SAFETY</span><span>Decision support only — not a certified life-safety system.</span></footer>
        </div>
      </main>

      {toast && <div className="toast"><Check size={16} />{toast}<button onClick={() => setToast('')} aria-label="Dismiss notification"><X size={15} /></button></div>}
      {emergencyGuideOpen && <div className="modal-backdrop" role="presentation" onClick={() => setEmergencyGuideOpen(false)}><section className="emergency-modal" role="dialog" aria-modal="true" aria-labelledby="emergency-title" onClick={(event) => event.stopPropagation()}><button className="icon-btn modal-close" onClick={() => setEmergencyGuideOpen(false)} aria-label="Close emergency response guide"><X size={18} /></button><div className="critical-pulse"><Siren size={21} /></div><div className="eyebrow">FACILITY RESPONSE PROTOCOL</div><h2 id="emergency-title">Emergency response guide</h2><p>Follow your facility’s approved response plan. Never investigate smoke or fire if it puts you at risk.</p><ol><li>Activate the certified building alarm and notify occupants.</li><li>Evacuate using the nearest safe exit; do not use elevators.</li><li>Call your local emergency services from a safe location.</li><li>Report the affected zone to the incident commander.</li></ol><span className="safety-disclaimer">AI detections can be false positives. This application does not contact emergency services.</span><button className="btn btn-primary" onClick={() => setEmergencyGuideOpen(false)}>Understood</button></section></div>}

      <input ref={imageInputRef} className="sr-only" type="file" accept="image/*" onChange={(event) => { loadFile(event.target.files?.[0]); event.currentTarget.value = ''; }} />
      <input ref={videoInputRef} className="sr-only" type="file" accept="video/*" onChange={(event) => { loadFile(event.target.files?.[0]); event.currentTarget.value = ''; }} />
    </div>
  );
}

function FeedPanel({
  mediaKind, detections, confirmedTypes, detectionError, cameraError,
  fileVideoRef, videoRef, imageRef, canvasRef, mediaSize, setMediaSize, online,
  busy, monitoring, sourceName, onStart, onStop, onUploadImage,
  onUploadVideo, onFullscreen,
}: {
  mediaKind: 'camera' | 'video' | 'image' | null;
  detections: Detection[];
  confirmedTypes: Array<'Fire' | 'Smoke'>;
  detectionError: string;
  cameraError: string;
  fileVideoRef: React.RefCallback<HTMLVideoElement>;
  videoRef: React.RefCallback<HTMLVideoElement>;
  imageRef: React.RefCallback<HTMLImageElement>;
  canvasRef: React.RefCallback<HTMLCanvasElement>;
  mediaSize: { width: number; height: number };
  setMediaSize: (size: { width: number; height: number }) => void;
  online: boolean;
  busy: boolean;
  monitoring: boolean;
  sourceName: string;
  onStart: () => void;
  onStop: () => void;
  onUploadImage: () => void;
  onUploadVideo: () => void;
  onFullscreen: (element: HTMLDivElement | null) => void;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  return <div className="panel feed-panel">
    <div className="panel-header"><div><h2>Live detection</h2><p>Real-time YOLO fire & smoke inference</p></div><div className="feed-header-actions"><span className={`live-badge ${monitoring ? 'live' : ''}`}><span />{monitoring ? 'LIVE' : 'STANDBY'}</span><button className="icon-btn" aria-label="Enter fullscreen" title="Fullscreen feed" onClick={() => onFullscreen(element)}><Maximize2 size={16} /></button></div></div>
    <div ref={setElement} className={`feed-screen ${detections.some((item) => item.label === 'Fire') ? 'feed-critical' : ''}`}>
      <video ref={videoRef} className={`feed-media ${mediaKind === 'camera' ? 'visible' : ''}`} onLoadedMetadata={(event) => setMediaSize({ width: event.currentTarget.videoWidth || 16, height: event.currentTarget.videoHeight || 9 })} autoPlay muted playsInline />
      <video ref={fileVideoRef} className={`feed-media ${mediaKind === 'video' ? 'visible' : ''}`} onLoadedMetadata={(event) => setMediaSize({ width: event.currentTarget.videoWidth || 16, height: event.currentTarget.videoHeight || 9 })} autoPlay muted playsInline loop />
      <img ref={imageRef} className={`feed-media image-feed ${mediaKind === 'image' ? 'visible' : ''}`} alt="Image currently analyzed by the YOLO detector" />
      <canvas ref={canvasRef} className="hidden-canvas" />
      {detections.length > 0 && <svg className="detection-overlay" viewBox={`0 0 ${mediaSize.width} ${mediaSize.height}`} preserveAspectRatio="xMidYMid meet" aria-label="YOLO detection bounding boxes">{detections.map((detection, index) => {
        const [x1, y1, x2, y2] = detection.box;
        const x = x1 * mediaSize.width;
        const y = y1 * mediaSize.height;
        const fire = detection.label === 'Fire';
        return <g key={`${detection.label}-${index}`} className={fire ? 'svg-fire' : 'svg-smoke'}><rect x={x} y={y} width={(x2 - x1) * mediaSize.width} height={(y2 - y1) * mediaSize.height} /><text x={x} y={Math.max(14, y - 5)}>{detection.label.toUpperCase()} · {(detection.confidence * 100).toFixed(1)}%</text></g>;
      })}</svg>}
      {!monitoring && <div className="feed-placeholder"><div className="feed-icon"><Camera size={24} /></div><strong>No active feed</strong><span>{online ? 'Connect a camera or upload media for real model analysis.' : 'The FastAPI service and compatible YOLO model must be online.'}</span><div className="feed-buttons"><button className="btn btn-primary" onClick={onStart}><Video size={15} /> Start camera</button><button className="btn btn-ghost" onClick={onUploadImage}><CloudUpload size={15} /> Upload image</button><button className="btn btn-ghost" onClick={onUploadVideo}><Video size={15} /> Upload video</button></div></div>}
      {!online && <div className="feed-overlay-note"><AlertTriangle size={14} /> AI model unavailable · no results will be simulated</div>}
      {busy && <div className="feed-processing"><span className="spinner" />Analyzing frame…</div>}
    </div>
    <div className="feed-footer"><div className="feed-source"><span className={`source-dot ${monitoring ? 'active' : ''}`} /><span>{sourceName || 'No camera or media selected'}</span></div><div className="feed-controls">{detections.map((item, index) => <span key={index} className={`detection-chip ${item.label === 'Fire' ? 'fire-chip' : 'smoke-chip'} ${confirmedTypes.includes(item.label) ? 'detection-confirmed' : 'detection-candidate'}`}>{item.label} {(item.confidence * 100).toFixed(1)}% · {confirmedTypes.includes(item.label) ? 'confirmed' : 'verifying'}</span>)}<button className="icon-btn upload-mini" title="Upload image" onClick={onUploadImage}><CloudUpload size={16} /></button><button className="icon-btn upload-mini" title="Upload video" onClick={onUploadVideo}><Video size={16} /></button>{monitoring && <button className="icon-btn" title="Stop monitoring" onClick={onStop}><X size={17} /></button>}</div></div>
    {(detectionError || cameraError) && <div className="inline-error"><AlertTriangle size={15} /><span>{detectionError || cameraError}</span></div>}
  </div>;
}

function DetectionSummary({ detections, fireCount, smokeCount, settings, lastDetection }: {
  detections: Detection[];
  fireCount: number;
  smokeCount: number;
  settings: DetectionSettings;
  lastDetection: string;
}) {
  const highest = detections.length ? Math.max(...detections.map((item) => item.confidence)) : 0;
  const risk = riskLabel(detections);
  return <div className="panel status-panel"><div className="panel-header"><div><h2>Detection summary</h2><p>Latest model-evaluated frame</p></div><div className={`risk-indicator ${risk === 'NORMAL' ? 'risk-normal' : risk === 'CRITICAL' ? 'risk-high' : 'risk-warning'}`}><i />{risk}</div></div>
    <div className="summary-stats"><div><span className="summary-icon fire-summary"><Flame size={17} /></span><div><strong>{fireCount}</strong><span>Fire incidents</span></div></div><div><span className="summary-icon smoke-summary"><Activity size={17} /></span><div><strong>{smokeCount}</strong><span>Smoke incidents</span></div></div></div>
    <div className="confidence-box"><div><span>Latest frame confidence</span><strong>{detections.length ? `${(highest * 100).toFixed(1)}%` : '—'}</strong></div><div className="confidence-track"><span style={{ width: `${highest * 100}%` }} /></div><small>YOLO model output · fire {(settings.fire_threshold * 100).toFixed(0)}% · smoke {(settings.smoke_threshold * 100).toFixed(0)}% threshold</small></div>
    <div className="summary-results">{detections.length ? detections.map((item, index) => <div key={`${item.label}-${index}`} className={`summary-result ${item.label === 'Fire' ? 'fire-result' : 'smoke-result'}`}><span>{item.label === 'Fire' ? <Flame size={15} /> : <Activity size={15} />}{item.label} detected</span><strong>{(item.confidence * 100).toFixed(1)}%</strong></div>) : <div className="summary-result normal-result"><span><ShieldCheck size={15} />No detections in latest frame</span></div>}</div>
    <div className="last-scan"><span>Last logged incident</span><strong>{lastDetection ? new Date(lastDetection).toLocaleTimeString() : 'No incidents yet'}</strong></div>
  </div>;
}

function EmergencyGuide({ critical, smoke, onOpen }: { critical: boolean; smoke: boolean; onOpen: () => void }) {
  return <div className={`panel response-panel ${critical ? 'response-critical' : smoke ? 'response-warning' : ''}`}><div className="response-heading"><span className="response-icon"><ShieldAlert size={18} /></span><div><h2>Emergency response</h2><span>Safety guidance · not an emergency dispatch</span></div></div><p>{critical ? 'A fire-class model detection is present. If there is a visible hazard, evacuate safely and activate your approved site plan.' : smoke ? 'A smoke-class model detection is present. Investigate only from a safe distance and follow site procedures.' : 'No hazard identified by this model in the latest frame. Maintain normal safety procedures and keep certified alarms active.'}</p><button className="text-button" onClick={onOpen}>Open response protocol <ChevronRight size={14} /></button></div>;
}

function EnvironmentalPanel({ latestSensor, detections }: { latestSensor?: SensorReading; detections: Detection[] }) {
  const smoke = detections.filter((item) => item.label === 'Smoke');
  const smokeConfidence = smoke.length ? Math.max(...smoke.map((item) => item.confidence)) : 0;
  const sensorTime = latestSensor ? new Date(latestSensor.created_at).toLocaleTimeString() : '';
  return <div className="panel telemetry-panel"><div className="panel-header"><div><h2>Environmental monitoring</h2><p>ESP32 / IoT readings · last update {sensorTime || 'not received'}</p></div><span className={`demo-tag ${latestSensor ? 'live-tag' : ''}`}><span />{latestSensor ? 'LIVE SENSOR DATA' : 'NO SENSOR DATA'}</span></div>
    <div className="telemetry-grid">{[
      { label: 'Temperature', value: latestSensor?.temperature_c, unit: '°C', icon: Thermometer, note: latestSensor ? `Sensor · ${latestSensor.sensor_id}` : 'Waiting for a physical sensor' },
      { label: 'Carbon monoxide', value: latestSensor?.carbon_monoxide_ppm, unit: 'PPM', icon: Activity, note: latestSensor ? `Sensor · ${latestSensor.sensor_id}` : 'Waiting for a physical sensor' },
      { label: 'Visual smoke confidence', value: smoke.length ? Math.round(smokeConfidence * 100) : null, unit: '%', icon: CloudUpload, note: smoke.length ? 'YOLO output · not a sensor value' : 'No visual smoke detected' },
    ].map((item) => <div className="telemetry-item" key={item.label}><div className="telemetry-top"><span className="telemetry-icon"><item.icon size={16} /></span><span className="telemetry-label">{item.label}</span></div><div className="telemetry-value">{item.value ?? '—'}<small>{item.unit}</small></div><span className="telemetry-note">{item.note}</span><div className="mini-meter"><span style={{ width: typeof item.value === 'number' ? `${Math.max(0, Math.min(100, item.value))}%` : '0%' }} /></div></div>)}</div>
    <p className="telemetry-footnote">No sensor readings are simulated. Until hardware posts real data, temperature, CO, and smoke sensor values remain unavailable. Visual confidence is an AI output, not a physical sensor measurement.</p>
  </div>;
}

function ThresholdControl({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="range-field"><span>{label}<strong>{(value * 100).toFixed(0)}%</strong></span><input aria-label={label} type="range" min="0.1" max="0.95" step="0.05" value={value} onChange={(event) => onChange(Number(event.target.value))} /><div className="range-ends"><span>More sensitive</span><span>Fewer detections</span></div></label>;
}

function StatCard({ label, value, icon: Icon, tone, detail }: { label: string; value: string; icon: typeof Activity; tone: string; detail: string }) {
  return <div className="stat-card"><div className="stat-top"><span>{label}</span><span className={`stat-icon stat-${tone}`}><Icon size={17} /></span></div><strong className="stat-value">{value}</strong><span className="stat-detail">{detail}</span></div>;
}

function PageTitle({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="page-heading subpage-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> {eyebrow}</div><h1>{title}</h1><p>{description}</p></div></div>;
}

function ToggleRow({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <div className="toggle-row"><div><strong>{title}</strong><span>{description}</span></div><button className={`toggle ${checked ? 'toggle-on' : ''}`} role="switch" aria-checked={checked} aria-label={title} onClick={() => onChange(!checked)}><i /></button></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><div><ShieldCheck size={19} /></div><strong>{title}</strong><span>{detail}</span></div>;
}

export default App;
