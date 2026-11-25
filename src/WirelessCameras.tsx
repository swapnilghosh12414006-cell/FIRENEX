import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera, Check, Copy, Expand, Mic, MicOff, Radio, RefreshCw, Shield,
  Signal, Square, Video, VideoOff, Wifi, X,
} from 'lucide-react';
import { api, type CameraRoom, type CameraRoomViewerConfiguration } from './api';

type CameraRole = 'sender' | 'viewer';
type WirelessCamerasProps = {
  viewerOnly?: boolean;
};
type SignalMessage = {
  type: string;
  role?: CameraRole;
  peer_id?: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  reason?: string;
};

const RESOLUTIONS = {
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

export default function WirelessCameras({ viewerOnly = false }: WirelessCamerasProps) {
  const [role, setRole] = useState<CameraRole>(viewerOnly ? 'viewer' : 'sender');
  const [room, setRoom] = useState<CameraRoom | null>(null);
  const [roomId, setRoomId] = useState('');
  const [pairingToken, setPairingToken] = useState('');
  const [viewerUrl, setViewerUrl] = useState('');
  const [qrImage, setQrImage] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [resolution, setResolution] = useState<keyof typeof RESOLUTIONS>('720p');
  const [frameRate, setFrameRate] = useState(30);
  const [cameraFacing, setCameraFacing] = useState<'user' | 'environment'>('environment');
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [status, setStatus] = useState('Not connected');
  const [latency, setLatency] = useState<number | null>(null);
  const [turnConfigured, setTurnConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pairedFromLink, setPairedFromLink] = useState(false);

  const senderVideo = useRef<HTMLVideoElement | null>(null);
  const viewerVideo = useRef<HTMLVideoElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const senderStreamRef = useRef<MediaStream | null>(null);
  const viewerPeerRef = useRef<RTCPeerConnection | null>(null);
  const senderPeersRef = useRef(new Map<string, RTCPeerConnection>());
  const senderRetryCounts = useRef(new Map<string, number>());
  const senderRetryTimers = useRef(new Map<string, number>());
  const pendingIceRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const roomRef = useRef<CameraRoom | null>(null);
  const roleRef = useRef<CameraRole>('sender');
  const reconnectRef = useRef<(role: CameraRole, id: string, token: string) => void>(() => undefined);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectDelay = useRef(1000);
  const intentionalClose = useRef(false);

  useEffect(() => { roleRef.current = role; }, [role]);
  useEffect(() => { roomRef.current = room; }, [room]);
  useEffect(() => {
    if (senderVideo.current) senderVideo.current.srcObject = stream;
  }, [stream]);
  useEffect(() => {
    if (viewerVideo.current) viewerVideo.current.srcObject = remoteStream;
  }, [remoteStream]);
  useEffect(() => {
    const track = senderStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const size = RESOLUTIONS[resolution];
    void track.applyConstraints({
      width: { ideal: size.width },
      height: { ideal: size.height },
      frameRate: { ideal: frameRate, max: frameRate },
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'The active camera could not apply the selected video settings.');
    });
  }, [frameRate, resolution]);

  const sendSignal = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  const closePeer = useCallback((peerId: string) => {
    const retryTimer = senderRetryTimers.current.get(peerId);
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    senderRetryTimers.current.delete(peerId);
    const peer = senderPeersRef.current.get(peerId);
    if (peer) {
      peer.onicecandidate = null;
      peer.onconnectionstatechange = null;
      peer.close();
      senderPeersRef.current.delete(peerId);
    }
    pendingIceRef.current.delete(peerId);
    setViewerCount(senderPeersRef.current.size);
  }, []);

  const createSenderPeer = useCallback(async (peerId: string) => {
    const currentStream = senderStreamRef.current;
    if (!currentStream) {
      setError('Start camera permission before accepting a viewer.');
      return;
    }
    closePeer(peerId);
    const peer = new RTCPeerConnection({ iceServers: iceServersRef.current });
    senderPeersRef.current.set(peerId, peer);
    for (const track of currentStream.getTracks()) peer.addTrack(track, currentStream);
    peer.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type: 'ice', peer_id: peerId, candidate: event.candidate.toJSON() });
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed') {
        const attempts = senderRetryCounts.current.get(peerId) ?? 0;
        if (attempts < 3 && senderStreamRef.current && !intentionalClose.current) {
          senderRetryCounts.current.set(peerId, attempts + 1);
          closePeer(peerId);
          setStatus(`Media path failed · retrying (${attempts + 1}/3)`);
          const retryTimer = window.setTimeout(() => {
            senderRetryTimers.current.delete(peerId);
            if (!senderStreamRef.current || socketRef.current?.readyState !== WebSocket.OPEN) return;
            void createSenderPeer(peerId).catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : 'Could not reconnect the viewer stream.');
            });
          }, 1000 * (attempts + 1));
          senderRetryTimers.current.set(peerId, retryTimer);
        } else {
          closePeer(peerId);
          setStatus('Media connection failed · reconnect signaling or restart the camera');
        }
      } else if (peer.connectionState === 'closed') closePeer(peerId);
      else if (peer.connectionState === 'connected') {
        senderRetryCounts.current.delete(peerId);
        setStatus('Live stream connected');
      }
    };
    setViewerCount(senderPeersRef.current.size);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    sendSignal({ type: 'offer', peer_id: peerId, description: peer.localDescription });
  }, [closePeer, sendSignal]);

  const connectSignaling = useCallback((nextRole: CameraRole, id: string, token: string) => {
    if (intentionalClose.current) return;
    let socket: WebSocket;
    try {
      socket = api.cameraSocket(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open the signaling connection.');
      return;
    }
    socketRef.current = socket;
    setStatus('Connecting signaling…');
    socket.onopen = () => {
      reconnectDelay.current = 1000;
      socket.send(JSON.stringify({ type: 'auth', token }));
    };
    socket.onmessage = (event) => {
      let message: SignalMessage;
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) throw new Error('Invalid signaling message.');
        message = parsed as SignalMessage;
      } catch {
        setError('Received an invalid camera signaling message.');
        return;
      }
      if (message.type === 'authenticated') {
        if (nextRole === 'sender') {
          setStatus('Waiting for viewers');
        } else {
          const peer = new RTCPeerConnection({ iceServers: iceServersRef.current });
          viewerPeerRef.current?.close();
          viewerPeerRef.current = peer;
          peer.ontrack = (trackEvent) => {
            const incoming = trackEvent.streams[0] ?? new MediaStream([trackEvent.track]);
            setRemoteStream(incoming);
            setStatus('Live stream connected');
          };
          peer.onicecandidate = (iceEvent) => {
            if (iceEvent.candidate) sendSignal({ type: 'ice', peer_id: 'owner', candidate: iceEvent.candidate.toJSON() });
          };
          peer.onconnectionstatechange = () => {
            if (peer.connectionState === 'connected') setStatus('Live stream connected');
            else if (peer.connectionState === 'failed') setStatus('Connection failed');
            else if (peer.connectionState === 'disconnected') setStatus('Reconnecting media…');
          };
          setStatus('Authenticated · waiting for camera');
        }
        return;
      }
      if (message.type === 'viewer_joined' && nextRole === 'sender' && message.peer_id) {
        void createSenderPeer(message.peer_id).catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : 'Could not establish a viewer connection.');
        });
        return;
      }
      if (message.type === 'viewer_left' && message.peer_id) {
        closePeer(message.peer_id);
        senderRetryCounts.current.delete(message.peer_id);
        return;
      }
      if (message.type === 'owner_ready') { setStatus('Camera owner connected · negotiating media'); return; }
      if (message.type === 'waiting_for_owner') { setStatus('Waiting for camera owner'); return; }
      if (message.type === 'owner_disconnected') { setStatus('Camera owner disconnected'); return; }
      if (message.type === 'room_closed') {
        setStatus('Camera room closed');
        setRemoteStream(null);
        setError('The camera owner ended this pairing.');
        socket.close();
        return;
      }
      if (message.type === 'error') {
        setError(message.reason || 'Camera signaling failed.');
        return;
      }
      const peerId = nextRole === 'sender' ? message.peer_id : 'owner';
      const peer = nextRole === 'sender'
        ? senderPeersRef.current.get(peerId ?? '')
        : viewerPeerRef.current;
      if (!peer || !peerId) return;
      if (message.type === 'answer' && message.description && nextRole === 'sender') {
        void peer.setRemoteDescription(message.description)
          .then(async () => {
            for (const candidate of pendingIceRef.current.get(peerId) ?? []) {
              await peer.addIceCandidate(candidate);
            }
            pendingIceRef.current.delete(peerId);
          })
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not apply viewer answer.'));
      } else if (message.type === 'offer' && message.description && nextRole === 'viewer') {
        void peer.setRemoteDescription(message.description)
          .then(async () => {
            for (const candidate of pendingIceRef.current.get(peerId) ?? []) {
              await peer.addIceCandidate(candidate);
            }
            pendingIceRef.current.delete(peerId);
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            sendSignal({ type: 'answer', peer_id: 'owner', description: peer.localDescription });
          })
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not negotiate the live stream.'));
      } else if (message.type === 'ice' && message.candidate) {
        if (peer.remoteDescription) {
          void peer.addIceCandidate(message.candidate).catch((reason: unknown) => {
            setError(reason instanceof Error ? reason.message : 'Could not add a network candidate.');
          });
        } else {
          const queued = pendingIceRef.current.get(peerId) ?? [];
          queued.push(message.candidate);
          pendingIceRef.current.set(peerId, queued);
        }
      }
    };
    socket.onerror = () => setStatus('Signaling connection error');
    socket.onclose = (event) => {
      if (socketRef.current === socket) socketRef.current = null;
      if (intentionalClose.current) return;
      if (event.code === 4401 || event.code === 4403) {
        setStatus('Pairing expired or unauthorized');
        setError('This camera pairing is invalid or expired. Ask the camera owner to create a new pairing and scan its QR code.');
        return;
      }
      setStatus('Signaling disconnected · retrying');
      const delay = reconnectDelay.current;
      reconnectDelay.current = Math.min(delay * 2, 15000);
      if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = window.setTimeout(
        () => reconnectRef.current(nextRole, id, token),
        delay,
      );
    };
  }, [closePeer, createSenderPeer, sendSignal]);
  useEffect(() => { reconnectRef.current = connectSignaling; }, [connectSignaling]);

  const discoverDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError('Camera device discovery is not supported in this browser.');
      return;
    }
    try {
      const available = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'videoinput');
      setDevices(available);
      if (!available.some((device) => device.deviceId === deviceId)) {
        setDeviceId(available[0]?.deviceId ?? '');
      }
      setNotice(`${available.length} camera device(s) listed by this browser.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not list available cameras.');
    }
  }, [deviceId]);

  const createPairing = useCallback(async () => {
    setBusy(true); setError(''); setNotice('');
    let created: CameraRoom | null = null;
    try {
      created = await api.createCameraRoom();
      const viewerOrigin = new URL(window.location.origin);
      if (viewerOrigin.hostname === 'localhost' || viewerOrigin.hostname === '127.0.0.1') {
        const network = await api.networkInfo();
        viewerOrigin.hostname = network.lan_address;
      }
      const url = `${viewerOrigin.origin}${window.location.pathname}#camera=${encodeURIComponent(created.room_id)}&token=${encodeURIComponent(created.viewer_token)}`;
      const qr = await api.cameraRoomQr(url);
      setRoom(created);
      roomRef.current = created;
      setRoomId(created.room_id);
      setPairingToken(created.owner_token);
      setViewerUrl(url);
      setQrImage(`data:image/png;base64,${qr.image_data}`);
      setTurnConfigured(created.turn_configured);
      iceServersRef.current = created.ice_servers;
      intentionalClose.current = false;
      setNotice(`Pairing ready for ${viewerOrigin.hostname}. Both devices must be on the same Wi-Fi network.`);
    } catch (reason) {
      if (created) {
        try {
          await api.closeCameraRoom(created.room_id, created.owner_token);
        } catch (cleanupReason) {
          const failure = reason instanceof Error ? reason.message : 'Could not create a camera pairing.';
          const cleanupFailure = cleanupReason instanceof Error
            ? cleanupReason.message
            : 'Could not close the temporary room.';
          setError(`${failure} Temporary room cleanup failed: ${cleanupFailure}`);
          return;
        }
      }
      setError(reason instanceof Error ? reason.message : 'Could not create a camera pairing.');
    } finally {
      setBusy(false);
    }
  }, []);

  const startCamera = useCallback(async () => {
    setError(''); setNotice('');
    if (!roomRef.current) {
      setError('Create a temporary pairing before starting a shared camera.');
      return;
    }
    if (!window.isSecureContext) {
      setError('Mobile browsers block camera access on HTTP Wi-Fi pages. Open Emberwatch at a trusted HTTPS address to send this phone’s camera; viewing a paired stream does not require camera permission.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera access requires HTTPS or localhost and a browser that supports getUserMedia.');
      return;
    }
    if (!('RTCPeerConnection' in window)) {
      setError('WebRTC is not supported in this browser.');
      return;
    }
    try {
      const size = RESOLUTIONS[resolution];
      const video: MediaTrackConstraints = {
        width: { ideal: size.width },
        height: { ideal: size.height },
        frameRate: { ideal: frameRate, max: frameRate },
      };
      if (deviceId) video.deviceId = { exact: deviceId };
      else video.facingMode = { ideal: cameraFacing };
      const nextStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      const oldStream = senderStreamRef.current;
      senderStreamRef.current = nextStream;
      setStream(nextStream);
      oldStream?.getTracks().forEach((track) => track.stop());
      const tracks = await navigator.mediaDevices.enumerateDevices();
      setDevices(tracks.filter((device) => device.kind === 'videoinput'));
      const chosenDevice = nextStream.getVideoTracks()[0]?.getSettings().deviceId;
      setDeviceId(chosenDevice ?? deviceId);
      setRole('sender'); roleRef.current = 'sender';
      iceServersRef.current = roomRef.current.ice_servers;
      intentionalClose.current = false;
      connectSignaling('sender', roomRef.current.room_id, roomRef.current.owner_token);
      setStatus('Camera permission granted · connecting');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Camera permission or device access failed.');
      setStatus('Camera unavailable');
    }
  }, [cameraFacing, connectSignaling, deviceId, frameRate, resolution]);

  const openViewer = useCallback(async (linkPairing = false) => {
    setError(''); setNotice('');
    if (!roomId.trim() || !pairingToken.trim()) {
      setError('Enter both the camera ID and viewer pairing token.');
      return;
    }
    if (!('RTCPeerConnection' in window)) {
      setError('WebRTC is not supported in this browser.');
      return;
    }
    setBusy(true);
    try {
      const configuration: CameraRoomViewerConfiguration = await api.cameraRoomConfiguration(
        roomId.trim(), pairingToken.trim(),
      );
      iceServersRef.current = configuration.ice_servers;
      setTurnConfigured(configuration.turn_configured);
      setRoomId(configuration.room_id);
      setRole('viewer'); roleRef.current = 'viewer';
      intentionalClose.current = false;
      connectSignaling('viewer', configuration.room_id, pairingToken.trim());
      if (linkPairing) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        setPairedFromLink(false);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not validate this camera pairing.');
    } finally {
      setBusy(false);
    }
  }, [connectSignaling, pairingToken, roomId]);

  const stopSession = useCallback((closeRoom: boolean) => {
    intentionalClose.current = true;
    if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
    const socket = socketRef.current;
    if (closeRoom && roleRef.current === 'sender' && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'close' }));
    }
    const activeRoom = roomRef.current;
    if (closeRoom && roleRef.current === 'sender' && activeRoom && socket?.readyState !== WebSocket.OPEN) {
      void api.closeCameraRoom(activeRoom.room_id, activeRoom.owner_token)
        .then(() => setNotice('Camera room closed and viewers disconnected.'))
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not close the camera room.'));
    }
    socket?.close();
    socketRef.current = null;
    viewerPeerRef.current?.close();
    viewerPeerRef.current = null;
    for (const peer of senderPeersRef.current.values()) peer.close();
    senderPeersRef.current.clear();
    for (const timer of senderRetryTimers.current.values()) window.clearTimeout(timer);
    senderRetryTimers.current.clear();
    senderRetryCounts.current.clear();
    pendingIceRef.current.clear();
    setViewerCount(0);
    senderStreamRef.current?.getTracks().forEach((track) => track.stop());
    senderStreamRef.current = null;
    setStream(null);
    setRemoteStream(null);
    setMicrophoneEnabled(false);
    setLatency(null);
    setStatus(closeRoom ? 'Camera stopped · pairing closed' : 'Disconnected');
    if (closeRoom) {
      setRoom(null);
      roomRef.current = null;
      setViewerUrl(''); setQrImage('');
      setPairingToken('');
    }
  }, []);

  const switchCamera = useCallback(async (
    nextDeviceId: string,
    nextFacing: 'user' | 'environment' = cameraFacing,
  ) => {
    setDeviceId(nextDeviceId);
    if (!senderStreamRef.current || !roomRef.current) return;
    try {
      const size = RESOLUTIONS[resolution];
      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(nextDeviceId
            ? { deviceId: { exact: nextDeviceId } }
            : { facingMode: { ideal: nextFacing } }),
          width: { ideal: size.width },
          height: { ideal: size.height },
          frameRate: { ideal: frameRate, max: frameRate },
        },
        audio: false,
      });
      const newTrack = nextStream.getVideoTracks()[0];
      for (const [peerId, peer] of senderPeersRef.current) {
        const sender = peer.getSenders().find((item) => item.track?.kind === 'video');
        if (sender) await sender.replaceTrack(newTrack);
        else {
          peer.addTrack(newTrack, nextStream);
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          sendSignal({ type: 'offer', peer_id: peerId, description: peer.localDescription });
        }
      }
      const currentStream = senderStreamRef.current;
      for (const audioTrack of currentStream.getAudioTracks()) nextStream.addTrack(audioTrack);
      currentStream.getVideoTracks().forEach((track) => track.stop());
      senderStreamRef.current = nextStream;
      setStream(nextStream);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not switch camera device.');
    }
  }, [cameraFacing, frameRate, resolution, sendSignal]);

  const toggleMicrophone = useCallback(async () => {
    const currentStream = senderStreamRef.current;
    if (!currentStream || !roomRef.current) {
      setError('Start the camera before enabling microphone audio.');
      return;
    }
    if (microphoneEnabled) {
      for (const peer of senderPeersRef.current.values()) {
        const sender = peer.getSenders().find((item) => item.track?.kind === 'audio');
        if (sender) await sender.replaceTrack(null);
      }
      currentStream.getAudioTracks().forEach((track) => { track.stop(); currentStream.removeTrack(track); });
      setMicrophoneEnabled(false);
      return;
    }
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const audioTrack = audioStream.getAudioTracks()[0];
      currentStream.addTrack(audioTrack);
      for (const [peerId, peer] of senderPeersRef.current) {
        const sender = peer.getSenders().find((item) => item.track?.kind === 'audio');
        if (sender) await sender.replaceTrack(audioTrack);
        else {
          peer.addTrack(audioTrack, currentStream);
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          sendSignal({ type: 'offer', peer_id: peerId, description: peer.localDescription });
        }
      }
      setMicrophoneEnabled(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Microphone permission was denied or unavailable.');
    }
  }, [microphoneEnabled, sendSignal]);

  const copyViewerUrl = async () => {
    try {
      await navigator.clipboard.writeText(viewerUrl);
      setNotice('Private viewer link copied.');
    } catch {
      setError('Could not access the clipboard. Use the QR code or copy the link manually.');
    }
  };

  useEffect(() => {
    const parts = new URLSearchParams(window.location.hash.slice(1));
    const id = parts.get('camera');
    const token = parts.get('token');
    if (id && token) {
      setRole('viewer');
      setRoomId(id);
      setPairingToken(token);
      setPairedFromLink(true);
    }
  }, []);

  useEffect(() => {
    if (pairedFromLink && roomId && pairingToken) void openViewer(true);
  }, [openViewer, pairedFromLink, pairingToken, roomId]);

  useEffect(() => {
    if (role !== 'viewer' || status !== 'Live stream connected') return;
    const timer = window.setInterval(() => {
      const peer = viewerPeerRef.current;
      if (!peer) return;
      void peer.getStats().then((report) => {
        for (const stat of report.values()) {
          if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.currentRoundTripTime !== undefined) {
            setLatency(Math.round(stat.currentRoundTripTime * 1000));
            return;
          }
        }
      }).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Could not read WebRTC connection statistics.');
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [role, status]);

  useEffect(() => () => {
    intentionalClose.current = true;
    const socket = socketRef.current;
    if (roleRef.current === 'sender' && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'close' }));
    }
    socket?.close();
    senderStreamRef.current?.getTracks().forEach((track) => track.stop());
    viewerPeerRef.current?.close();
    for (const peer of senderPeersRef.current.values()) peer.close();
  }, []);

  const senderActive = role === 'sender' && Boolean(stream);
  const viewerActive = role === 'viewer' && Boolean(remoteStream);
  return (
    <div className="subpage wireless-page">
      <div className="subpage-heading">
        <div className="eyebrow"><span className="eyebrow-line" />{viewerOnly ? 'PRIVATE CAMERA VIEWER' : 'WIRELESS CAMERA CONNECTION'}</div>
        <h1>{viewerOnly ? 'Live camera viewer' : 'Camera sender & viewer'}</h1>
        <p>{viewerOnly
          ? 'You are viewing a camera shared with you. The owner controls the camera and can end this stream at any time.'
          : 'Browser-to-browser WebRTC video. The sender grants camera permission; media travels peer-to-peer and is not recorded by Emberwatch.'}</p>
      </div>
      <div className="wireless-disclaimer"><Shield size={16} /><span>{viewerOnly
        ? <><strong>Private viewer link:</strong> this page can only join the camera room in the link. It does not expose the operator dashboard or request camera permission.</>
        : <><strong>Private pairing:</strong> rooms expire after 10 minutes and the owner can close viewers. Use HTTPS for remote devices. STUN alone cannot traverse every network; configure TURN for dependable connectivity.</>}</span></div>
      {!viewerOnly && <div className="wireless-mode-switch" role="tablist" aria-label="Camera role">
        <button role="tab" aria-selected={role === 'sender'} className={role === 'sender' ? 'selected' : ''} onClick={() => { stopSession(false); setRole('sender'); }}>Camera sender</button>
        <button role="tab" aria-selected={role === 'viewer'} className={role === 'viewer' ? 'selected' : ''} onClick={() => { stopSession(false); setRole('viewer'); }}>Camera viewer</button>
      </div>}
      <div className="wireless-grid">
        <section className="panel wireless-video-panel">
          <div className="panel-header"><div><h2>{role === 'sender' ? 'Camera preview' : 'Remote live video'}</h2><p>{status}</p></div><span className={`live-badge ${senderActive || viewerActive ? 'live' : ''}`}><span />{senderActive || viewerActive ? 'CONNECTED' : 'IDLE'}</span></div>
          <div className="wireless-video">
            {role === 'sender'
              ? <video ref={senderVideo} muted autoPlay playsInline />
              : <video ref={viewerVideo} autoPlay playsInline />}
            {!senderActive && !viewerActive && <div className="wireless-video-empty"><Camera size={28} /><strong>{role === 'sender' ? 'Camera is off' : 'Waiting for a paired camera'}</strong><span>Video appears here only after explicit permission and a successful WebRTC connection.</span></div>}
          </div>
          <div className="connection-metrics"><span><i className={senderActive || viewerActive ? 'metric-online' : ''} />{status}</span><span><Signal size={14} />{latency === null ? 'Latency —' : `${latency} ms RTT`}</span>{role === 'sender' && <span><Radio size={14} />{viewerCount} / {room?.max_viewers ?? 3} viewers</span>}</div>
          {role === 'sender' ? <div className="wireless-controls">
            <label className="experience-field"><span>Camera device</span><select value={deviceId} onChange={(event) => void switchCamera(event.target.value)}><option value="">Use browser default</option>{devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></label>
            <label className="experience-field"><span>Resolution</span><select value={resolution} onChange={(event) => setResolution(event.target.value as keyof typeof RESOLUTIONS)}><option>480p</option><option>720p</option><option>1080p</option></select></label>
            <label className="experience-field"><span>Frame rate</span><select value={frameRate} onChange={(event) => setFrameRate(Number(event.target.value))}><option value={15}>15 FPS</option><option value={24}>24 FPS</option><option value={30}>30 FPS</option></select></label>
            <label className="experience-field"><span>Camera direction</span><select value={cameraFacing} onChange={(event) => { const facing = event.target.value as 'user' | 'environment'; setCameraFacing(facing); if (senderActive) { setDeviceId(''); void switchCamera('', facing); } }}><option value="environment">Rear / environment</option><option value="user">Front / user-facing</option></select></label>
            <div className="wireless-button-row">
              <button className="btn btn-primary" disabled={senderActive || !room} onClick={() => void startCamera()}><Video size={14} />Start camera</button>
              <button className="btn btn-ghost" disabled={!senderActive} onClick={() => void toggleMicrophone()}>{microphoneEnabled ? <MicOff size={14} /> : <Mic size={14} />}{microphoneEnabled ? 'Mute microphone' : 'Enable microphone'}</button>
              <button className="btn btn-danger-ghost" disabled={!senderActive && !room} onClick={() => stopSession(true)}><VideoOff size={14} />Stop & disconnect</button>
            </div>
            <p className="microcopy">Microphone is off until explicitly enabled. Resolution and frame-rate changes are applied to the active track when the browser supports them.</p>
          </div> : <div className="wireless-controls">
            <div className="wireless-button-row">
              <button className="btn btn-primary" disabled={busy || viewerActive || socketRef.current?.readyState === WebSocket.OPEN} onClick={() => void openViewer()}><Wifi size={14} />{busy ? 'Connecting…' : 'Connect camera'}</button>
              <button className="btn btn-ghost" disabled={!viewerActive} onClick={() => viewerVideo.current?.requestFullscreen().catch(() => setError('Fullscreen is unavailable in this browser.'))}><Expand size={14} />Fullscreen</button>
              <button className="btn btn-danger-ghost" disabled={!socketRef.current && !viewerActive} onClick={() => stopSession(false)}><X size={14} />Disconnect</button>
            </div>
            <p className="microcopy">Viewer receives no camera permission request. Pair only with a sender you trust.</p>
          </div>}
        </section>
        {viewerOnly ? <aside className="panel pairing-panel">
          <div className="panel-header"><div><h2>Pairing status</h2><p>{status}</p></div></div>
          <div className={`turn-status ${turnConfigured ? 'turn-enabled' : ''}`}><Signal size={15} /><span>{turnConfigured ? 'TURN relay configured' : 'STUN only · some networks may not connect'}</span></div>
          <div className="info-callout"><Wifi size={15} /><span>Keep this page open while watching. If it does not connect, ask the camera owner to start the camera and confirm both devices are on the same Wi-Fi network.</span></div>
          {error && <div className="experience-error" role="alert">{error}</div>}
          {notice && <div className="experience-success" role="status"><Check size={14} />{notice}</div>}
        </aside> : <aside className="panel pairing-panel">
          <div className="panel-header"><div><h2>{role === 'sender' ? 'Secure pairing' : 'Connect to a sender'}</h2><p>{role === 'sender' ? 'One-time viewer token · expires after 10 minutes' : 'Scan the owner’s QR code or enter pairing credentials'}</p></div></div>
          {role === 'sender' ? <>
            <button className="btn btn-primary pairing-create" disabled={busy} onClick={() => void createPairing()}><Radio size={14} />{busy ? 'Creating…' : room ? 'Create new pairing' : 'Create camera pairing'}</button>
            {room && <div className="pairing-content">
              {qrImage && <img className="pairing-qr" src={qrImage} alt="Private camera viewer pairing QR code" />}
              <label className="experience-field"><span>Camera ID</span><input readOnly value={room.room_id} /></label>
              <label className="experience-field"><span>Owner token · keep private</span><input readOnly value={room.owner_token} /></label>
              <div className="pairing-link-row"><button className="btn btn-ghost" onClick={() => void copyViewerUrl()}><Copy size={14} />Copy viewer link</button><span>Viewer limit: {room.max_viewers}</span></div>
              <p className="microcopy">The QR opens the viewer on this computer’s Wi-Fi address. Both devices must be on the same network. The token stays in the URL fragment and is not sent in the page request; share only with authorized viewers.</p>
            </div>}
            <div className={`turn-status ${turnConfigured ? 'turn-enabled' : ''}`}><Signal size={15} /><span>{turnConfigured ? 'TURN relay configured' : 'TURN not configured'}</span></div>
            <div className="wireless-button-row"><button className="btn btn-ghost" onClick={() => void discoverDevices()}><RefreshCw size={14} />List camera devices</button></div>
          </> : <>
            <label className="experience-field"><span>Camera ID</span><input value={roomId} onChange={(event) => setRoomId(event.target.value)} placeholder="Enter the sender’s camera ID" autoComplete="off" /></label>
            <label className="experience-field"><span>Viewer pairing token</span><input value={pairingToken} onChange={(event) => setPairingToken(event.target.value)} placeholder="Scan QR or enter the token" autoComplete="off" /></label>
            <div className="wireless-button-row"><button className="btn btn-primary" disabled={busy} onClick={() => void openViewer()}><Wifi size={14} />Connect</button><button className="btn btn-ghost" onClick={() => { setRoomId(''); setPairingToken(''); setError(''); }}><Square size={13} />Clear</button></div>
            <div className={`turn-status ${turnConfigured ? 'turn-enabled' : ''}`}><Signal size={15} /><span>{turnConfigured ? 'TURN relay configured' : 'STUN only · some networks may not connect'}</span></div>
            <div className="info-callout"><Wifi size={15} /><span>QR scanning can be done with the device camera app; it opens the viewer page and validates the short-lived token with this API.</span></div>
          </>}
          {error && <div className="experience-error" role="alert">{error}</div>}
          {notice && <div className="experience-success" role="status"><Check size={14} />{notice}</div>}
        </aside>}
      </div>
      {!viewerOnly && <div className="info-callout experience-notice"><Radio size={16} /><span>Streaming is peer-to-peer; Emberwatch relays only temporary WebRTC offers, answers, and ICE candidates. Internet connectivity requires a publicly reachable HTTPS/WSS deployment, and TURN is needed on restrictive NATs. RTSP/ONVIF/IP cameras need a separate secured media gateway and are not directly supported in this browser MVP.</span></div>}
    </div>
  );
}
