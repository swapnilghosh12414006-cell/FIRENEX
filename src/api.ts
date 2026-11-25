export type Detection = {
  label: 'Fire' | 'Smoke';
  confidence: number;
  box: [number, number, number, number];
};

export type AlertRecord = {
  id: string;
  timestamp: string;
  type: 'Fire' | 'Smoke';
  location: string;
  confidence: number;
  risk: 'Critical' | 'Warning';
  action: string;
  acknowledged: boolean;
};

export type CameraRecord = {
  id: string;
  name: string;
  location: string;
  device_id: string;
  created_at: string;
};

export type DetectionSettings = {
  fire_threshold: number;
  smoke_threshold: number;
  frame_interval_ms: number;
  auto_logging: boolean;
  sound_enabled: boolean;
  browser_notifications: boolean;
  email_notifications: boolean;
  email_to: string;
  email_configured: boolean;
  model_device: string;
};

export type Health = {
  status: string;
  model_loaded: boolean;
  model: string | null;
  model_error: string | null;
  uptime_seconds: number;
  database: string;
  email_configured: boolean;
};

export type AuthSession = {
  configured: boolean;
  authenticated: boolean;
  username: string | null;
};

export type AlertCounts = {
  total: number;
  fire: number;
  smoke: number;
  critical: number;
};

export type SensorReading = {
  id: number;
  sensor_id: string;
  temperature_c: number | null;
  carbon_monoxide_ppm: number | null;
  smoke_ppm: number | null;
  created_at: string;
};

export type Analytics = {
  days: number;
  counts: AlertCounts;
  series: { date: string; fire: number; smoke: number; critical: number; warning: number }[];
  average_confidence: number | null;
};

export type AlertPage = {
  items: AlertRecord[];
  total: number;
  page: number;
  page_size: number;
  counts: AlertCounts;
};

export type DetectionResponse = {
  detections: Detection[];
  confirmed_types: Array<'Fire' | 'Smoke'>;
  alerts: AlertRecord[];
  model: string;
  inference_ms: number;
  timestamp: number;
  location: string;
};

export type EmergencyContact = {
  id: string;
  name: string;
  email: string;
  phone: string;
  email_enabled: boolean;
  created_at: string;
};

export type SosRequest = {
  id: string;
  timestamp: string;
  location: string;
  message: string;
  status: 'open' | 'acknowledged';
  email_requested: boolean;
  emails_queued: number;
  acknowledged_by: string;
};

export type RiskAssessment = {
  score: number | null;
  level: 'SAFE' | 'LOW RISK' | 'MODERATE RISK' | 'HIGH RISK' | 'CRITICAL' | 'INSUFFICIENT DATA';
  basis: string;
  signals: string[];
  recommended_actions: string[];
  sensor_readings: number;
  sensor_count?: number;
  latest_detection: AlertRecord | null;
  evaluated_at?: string;
};

export type FeedbackRecord = {
  id: string;
  timestamp: string;
  persona: string;
  category: string;
  rating: number;
  message: string;
  scenario: string;
  accessibility_mode: boolean;
};

export type FeedbackSummary = {
  count: number;
  average_rating: number | null;
  categories: Record<string, number>;
  scenarios: Record<string, number>;
};

export type CameraRoom = {
  room_id: string;
  owner_token: string;
  viewer_token: string;
  expires_at: number;
  ttl_seconds: number;
  max_viewers: number;
  ice_servers: RTCIceServer[];
  turn_configured: boolean;
};

export type CameraRoomViewerConfiguration = {
  room_id: string;
  expires_at: number;
  ice_servers: RTCIceServer[];
  turn_configured: boolean;
};

export type LiveEvent =
  | { type: 'alert' | 'alert_updated'; data: AlertRecord }
  | { type: 'emergency_sos' | 'emergency_sos_updated'; data: SosRequest }
  | { type: 'detection'; data: DetectionResponse }
  | { type: 'alerts_cleared'; data: { deleted: number } }
  | { type: 'sensor_reading'; data: SensorReading }
  | { type: 'settings_updated'; data: DetectionSettings }
  | { type: 'camera_added'; data: CameraRecord }
  | { type: 'camera_removed'; data: { id: string } }
  | { type: 'feedback_submitted' };

const configuredApiUrl = import.meta.env.VITE_API_URL;
const pageHost = window.location.hostname;
const configuredApiHost = configuredApiUrl ? new URL(configuredApiUrl).hostname : '';
const localApiHosts = ['localhost', '127.0.0.1', pageHost];
const useViteApiProxy = import.meta.env.DEV
  && (!configuredApiUrl || localApiHosts.includes(configuredApiHost));
const usePageHost = !configuredApiUrl
  || ((configuredApiHost === 'localhost' || configuredApiHost === '127.0.0.1')
    && pageHost !== 'localhost' && pageHost !== '127.0.0.1');
const BASE_URL = (
  useViteApiProxy
    ? window.location.origin
    : usePageHost
    ? `${window.location.protocol}//${pageHost}:8000`
    : configuredApiUrl
).replace(/\/+$/, '');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { ...init, credentials: 'include' });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Could not reach the Emberwatch API.');
  }
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login') {
      window.dispatchEvent(new Event('emberwatch:unauthorized'));
    }
    const body = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(body?.detail ?? `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

function jsonBody(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const api = {
  authSession: () => request<AuthSession>('/api/auth/session'),
  login: (username: string, password: string) =>
    request<{ status: string; username: string }>('/api/auth/login', jsonBody({ username, password })),
  logout: () => request<{ status: string }>('/api/auth/logout', { method: 'POST' }),
  health: () => request<Health>('/api/health'),
  networkInfo: () => request<{ lan_address: string }>('/api/network-info'),
  settings: () => request<DetectionSettings>('/api/settings'),
  updateSettings: (settings: Partial<DetectionSettings>) => request<DetectionSettings>('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  }),
  testEmail: () => request<{ status: string; recipient: string }>('/api/settings/email/test', { method: 'POST' }),
  alerts: (filters: {
    search?: string;
    type?: string;
    severity?: string;
    date_from?: string;
    date_to?: string;
    page?: number;
    page_size?: number;
  }) => request<AlertPage>(`/api/alerts?${new URLSearchParams(
    Object.entries(filters)
      .filter((entry) => entry[1] !== undefined && entry[1] !== '')
      .map(([key, value]) => [key, String(value)]),
  )}`),
  acknowledge: (id: string) => request<AlertRecord>(`/api/alerts/${encodeURIComponent(id)}/acknowledge`, { method: 'PATCH' }),
  clearAlerts: () => request<{ deleted: number }>('/api/alerts?confirm=true', { method: 'DELETE' }),
  cameras: () => request<{ items: CameraRecord[] }>('/api/cameras'),
  createCamera: (camera: { name: string; location: string; device_id: string }) =>
    request<CameraRecord>('/api/cameras', jsonBody(camera)),
  removeCamera: (id: string) => request<{ status: string }>(`/api/cameras/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  analytics: (days: number) => request<Analytics>(`/api/analytics?days=${days}`),
  sensors: () => request<{ items: SensorReading[] }>('/api/sensors'),
  detect: (
    blob: Blob,
    filename: string,
    settings: DetectionSettings,
    location: string,
    signal: AbortSignal,
    persistenceRequired = false,
  ) => {
    const formData = new FormData();
    formData.append('file', blob, filename);
    const query = new URLSearchParams({
      fire_threshold: String(settings.fire_threshold),
      smoke_threshold: String(settings.smoke_threshold),
      location,
      persistence_required: String(persistenceRequired),
    });
    return request<DetectionResponse>(`/api/detect?${query}`, { method: 'POST', body: formData, signal });
  },
  video: (file: File, settings: DetectionSettings, location: string, signal: AbortSignal) => {
    const formData = new FormData();
    formData.append('file', file, file.name);
    const query = new URLSearchParams({
      interval_seconds: String(settings.frame_interval_ms / 1000),
      fire_threshold: String(settings.fire_threshold),
      smoke_threshold: String(settings.smoke_threshold),
      location,
    });
    return request<{ frames_analyzed: number; sampled_frames: DetectionResponse[] }>(
      `/api/detect/video?${query}`,
      { method: 'POST', body: formData, signal },
    );
  },
  risk: () => request<RiskAssessment>('/api/risk'),
  emergencyContacts: () => request<{ items: EmergencyContact[] }>('/api/emergency/contacts'),
  createEmergencyContact: (contact: {
    name: string; email: string; phone: string; email_enabled: boolean;
  }) => request<EmergencyContact>('/api/emergency/contacts', jsonBody(contact)),
  deleteEmergencyContact: (id: string) =>
    request<{ status: string }>(`/api/emergency/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  sosRequests: () => request<{ items: SosRequest[] }>('/api/emergency/sos'),
  createSos: (payload: {
    location: string; message: string; notify_contacts: boolean; contact_ids: string[];
  }) => request<SosRequest>('/api/emergency/sos', jsonBody(payload)),
  acknowledgeSos: (id: string, acknowledged_by: string) =>
    request<SosRequest>(`/api/emergency/sos/${encodeURIComponent(id)}/acknowledge`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acknowledged_by }),
    }),
  submitFeedback: (payload: {
    persona: string; category: string; rating: number; message: string;
    scenario: string; accessibility_mode: boolean;
  }) => request<FeedbackRecord>('/api/feedback', jsonBody(payload)),
  feedback: (limit = 100) => request<{ items: FeedbackRecord[] }>(`/api/feedback?limit=${limit}`),
  feedbackSummary: () => request<FeedbackSummary>('/api/feedback/summary'),
  createCameraRoom: () => request<CameraRoom>('/api/camera-rooms', jsonBody({})),
  cameraRoomQr: (value: string) => request<{ image_data: string }>('/api/camera-rooms/qr', jsonBody({ value })),
  cameraRoomConfiguration: (roomId: string, viewerToken: string) =>
    request<CameraRoomViewerConfiguration>(`/api/camera-rooms/${encodeURIComponent(roomId)}`, {
      headers: { 'X-Room-Token': viewerToken },
    }),
  closeCameraRoom: (roomId: string, ownerToken: string) =>
    request<{ status: string }>(`/api/camera-rooms/${encodeURIComponent(roomId)}`, {
      method: 'DELETE',
      headers: { 'X-Room-Token': ownerToken },
    }),
  cameraSocket: (roomId: string) =>
    new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/api/camera-rooms/${encodeURIComponent(roomId)}/ws`),
  websocket: () => new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/api/ws`),
};
