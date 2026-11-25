import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Check, CircleAlert, Flame, LifeBuoy,
  MapPinned, Mic, Plus, Radio, Route, Send, ShieldAlert, Trash2, Volume2,
} from 'lucide-react';
import {
  api, type EmergencyContact, type FeedbackSummary, type RiskAssessment,
  type SosRequest,
} from './api';

const VOICE_MESSAGES = {
  English: {
    code: 'en-US',
    text: 'Fire detected. Please evacuate immediately using your facility emergency plan. Do not use elevators.',
  },
  Bengali: {
    code: 'bn-IN',
    text: 'আগুন শনাক্ত হয়েছে। অনুগ্রহ করে আপনার প্রতিষ্ঠানের জরুরি পরিকল্পনা অনুসরণ করে অবিলম্বে বেরিয়ে যান। লিফট ব্যবহার করবেন না।',
  },
  Hindi: {
    code: 'hi-IN',
    text: 'आग का पता चला है। कृपया अपनी सुविधा की आपातकालीन योजना का पालन करते हुए तुरंत बाहर निकलें। लिफ्ट का उपयोग न करें।',
  },
  Kannada: {
    code: 'kn-IN',
    text: 'ಬೆಂಕಿ ಪತ್ತೆಯಾಗಿದೆ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಸ್ಥಳದ ತುರ್ತು ಯೋಜನೆಯನ್ನು ಅನುಸರಿಸಿ ತಕ್ಷಣ ಹೊರಹೋಗಿ. ಲಿಫ್ಟ್ ಬಳಸಬೇಡಿ.',
  },
} as const;

type VoiceLanguage = keyof typeof VOICE_MESSAGES;

function speakEmergency(language: VoiceLanguage) {
  if (!('speechSynthesis' in window)) {
    throw new Error('Text-to-speech is not supported in this browser.');
  }
  window.speechSynthesis.cancel();
  const message = new SpeechSynthesisUtterance(VOICE_MESSAGES[language].text);
  message.lang = VOICE_MESSAGES[language].code;
  message.rate = 0.88;
  window.speechSynthesis.speak(message);
}

function PageHeader(props: { eyebrow: string; title: string; detail: string }) {
  return (
    <div className="subpage-heading">
      <div className="eyebrow"><span className="eyebrow-line" />{props.eyebrow}</div>
      <h1>{props.title}</h1>
      <p>{props.detail}</p>
    </div>
  );
}

function VoiceAssistant(props: { fireActive: boolean }) {
  const [language, setLanguage] = useState<VoiceLanguage>('English');
  const [error, setError] = useState('');
  const speak = () => {
    try {
      speakEmergency(language);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Voice announcement could not start.');
    }
  };
  return (
    <section className={`panel experience-card voice-card ${props.fireActive ? 'voice-critical' : ''}`}>
      <div className="experience-card-head">
        <span className="experience-icon"><Volume2 size={17} /></span>
        <div><h2>Multilingual voice assistant</h2><p>Browser speech · user-initiated, repeatable instructions</p></div>
      </div>
      {props.fireActive && <div className="voice-emergency"><Flame size={18} /><strong>FIRE DETECTION CONFIRMED — follow your facility response plan.</strong></div>}
      <p className="voice-message">{VOICE_MESSAGES[language].text}</p>
      <div className="experience-actions">
        <label className="experience-field"><span>Announcement language</span>
          <select value={language} onChange={(event) => setLanguage(event.target.value as VoiceLanguage)}>
            {Object.keys(VOICE_MESSAGES).map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <button className="btn btn-primary" onClick={speak}><Mic size={15} /> Repeat announcement</button>
      </div>
      {error && <div className="experience-error" role="alert">{error}</div>}
      <small>Voice availability and pronunciation depend on voices installed in this browser/operating system. Text remains available if speech is unavailable.</small>
    </section>
  );
}

type MapNode = {
  id: string;
  label: string;
  kind: 'room' | 'corridor' | 'exit';
  neighbors: string[];
};

const MAP_NODES: MapNode[] = [
  { id: 'north-room', label: 'North room', kind: 'room', neighbors: ['north-hall'] },
  { id: 'east-lab', label: 'East lab', kind: 'room', neighbors: ['east-hall'] },
  { id: 'south-workshop', label: 'South workshop', kind: 'room', neighbors: ['south-hall'] },
  { id: 'west-storage', label: 'West storage', kind: 'room', neighbors: ['west-hall'] },
  { id: 'north-hall', label: 'North corridor', kind: 'corridor', neighbors: ['junction'] },
  { id: 'east-hall', label: 'East corridor', kind: 'corridor', neighbors: ['junction'] },
  { id: 'south-hall', label: 'South corridor', kind: 'corridor', neighbors: ['junction'] },
  { id: 'west-hall', label: 'West corridor', kind: 'corridor', neighbors: ['junction'] },
  { id: 'junction', label: 'Central junction', kind: 'corridor', neighbors: ['exit-west', 'exit-east', 'exit-north', 'exit-south'] },
  { id: 'exit-west', label: 'West exit', kind: 'exit', neighbors: [] },
  { id: 'exit-east', label: 'East exit', kind: 'exit', neighbors: [] },
  { id: 'exit-north', label: 'North exit', kind: 'exit', neighbors: [] },
  { id: 'exit-south', label: 'South exit', kind: 'exit', neighbors: [] },
];

const NODE_BY_ID = new Map(MAP_NODES.map((node) => [node.id, node]));
const ROOM_BY_LABEL = new Map(
  MAP_NODES.filter((node) => node.kind === 'room').map((node) => [node.label.toLowerCase(), node.id]),
);

export function findIllustrativeRoute(
  start: string,
  hazards: string[],
  blockedExits: string[],
): string[] {
  if (hazards.includes(start) || blockedExits.includes(start) || !NODE_BY_ID.has(start)) return [];
  const queue: string[][] = [[start]];
  const visited = new Set([start]);
  while (queue.length) {
    const path = queue.shift()!;
    const current = NODE_BY_ID.get(path[path.length - 1]);
    if (!current) continue;
    if (current.kind === 'exit') return path;
    const neighbors = MAP_NODES
      .filter((node) => node.neighbors.includes(current.id))
      .map((node) => node.id)
      .concat(current.neighbors);
    for (const neighborId of neighbors) {
      const neighbor = NODE_BY_ID.get(neighborId);
      if (!neighbor || visited.has(neighborId) || hazards.includes(neighborId)) continue;
      if (neighbor.kind === 'exit' && blockedExits.includes(neighborId)) continue;
      visited.add(neighborId);
      queue.push([...path, neighborId]);
    }
  }
  return [];
}

export function EvacuationAssistant(props: {
  confirmedLocation: string;
  fireActive: boolean;
}) {
  const [start, setStart] = useState('north-room');
  const [simulation, setSimulation] = useState(false);
  const [simulatedHazard, setSimulatedHazard] = useState('east-lab');
  const [blockedExits, setBlockedExits] = useState<string[]>([]);
  const mappedLiveHazard = props.fireActive
    ? ROOM_BY_LABEL.get(props.confirmedLocation.trim().toLowerCase())
    : undefined;
  const hazards = simulation ? [simulatedHazard] : mappedLiveHazard ? [mappedLiveHazard] : [];
  const route = useMemo(
    () => findIllustrativeRoute(start, hazards, blockedExits),
    [start, hazards.join('|'), blockedExits.join('|')],
  );
  const toggleExit = (id: string) => {
    setBlockedExits((old) => old.includes(id) ? old.filter((item) => item !== id) : [...old, id]);
  };
  const mapColumns: Record<string, string> = {
    'north-room': '2 / span 2',
    'east-lab': '5 / span 2',
    'west-storage': '1 / span 2',
    'south-workshop': '5 / span 2',
    'north-hall': '3 / span 2',
    'east-hall': '5 / span 2',
    'west-hall': '1 / span 2',
    'south-hall': '3 / span 2',
    junction: '3 / span 2',
    'exit-west': '1 / span 2',
    'exit-east': '5 / span 2',
    'exit-north': '3 / span 2',
    'exit-south': '3 / span 2',
  };
  const mapRows: Record<string, string> = {
    'north-room': '1',
    'east-lab': '2',
    'west-storage': '2',
    'south-workshop': '5',
    'north-hall': '2',
    'east-hall': '3',
    'west-hall': '3',
    'south-hall': '4',
    junction: '3',
    'exit-west': '3',
    'exit-east': '3',
    'exit-north': '1',
    'exit-south': '5',
  };
  const routeSet = new Set(route);
  return (
    <div className="subpage">
      <PageHeader eyebrow="EVACUATION ASSISTANT" title="Evacuation route explorer" detail="A graph-based route exercise for a sample floor plan—not building navigation or a safety certification." />
      <div className="info-callout experience-notice"><MapPinned size={17} /><span><strong>Illustrative map only.</strong> It is not your building layout. Route suggestions do not account for live fire, smoke, people, doors, or building-code requirements. Use verified local plans and emergency personnel instructions.</span></div>
      <section className="evacuation-layout">
        <div className="panel map-panel">
          <div className="panel-header"><div><h2>Sample building · Level 1</h2><p>Nodes and paths are demonstration data</p></div><span className="demo-tag"><span /> DEMO MAP</span></div>
          <div className="floor-map" aria-label="Illustrative building map">
            {MAP_NODES.map((node) => {
              const isHazard = hazards.includes(node.id);
              const isBlocked = blockedExits.includes(node.id);
              const className = [
                'map-node',
                `map-${node.kind}`,
                routeSet.has(node.id) ? 'map-route' : '',
                isHazard ? 'map-hazard' : '',
                isBlocked ? 'map-blocked' : '',
                start === node.id ? 'map-start' : '',
              ].filter(Boolean).join(' ');
              return (
                <button
                  type="button"
                  key={node.id}
                  className={className}
                  style={{ gridColumn: mapColumns[node.id], gridRow: mapRows[node.id] }}
                  title={node.label}
                  onClick={() => node.kind === 'exit'
                    ? toggleExit(node.id)
                    : setStart(node.id)}
                  aria-label={`${node.label}${isHazard ? ', illustrative fire area' : ''}${isBlocked ? ', marked blocked' : ''}`}
                >
                  {isHazard ? <Flame size={14} /> : node.kind === 'exit' ? <Route size={14} /> : <span className="map-node-dot" />}
                  <span>{node.label}</span>
                  {isBlocked && <small>BLOCKED</small>}
                </button>
              );
            })}
          </div>
          <div className="map-legend"><span><i className="legend-route" />Example route</span><span><i className="legend-hazard" />Illustrative hazard</span><span><i className="legend-blocked" />Blocked exit</span></div>
        </div>
        <aside className="panel evacuation-controls">
          <div className="panel-header"><div><h2>Route exercise</h2><p>Choose inputs to test alternate paths</p></div></div>
          <label className="experience-field"><span>Starting point</span>
            <select value={start} onChange={(event) => setStart(event.target.value)}>
              {MAP_NODES.filter((node) => node.kind !== 'exit').map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
            </select>
          </label>
          <label className="toggle-row"><input type="checkbox" checked={simulation} onChange={(event) => setSimulation(event.target.checked)} /><span><strong>Simulate an incident</strong><small>Illustrative only; does not create an alert.</small></span></label>
          {simulation && <label className="experience-field"><span>Simulated affected zone</span>
            <select value={simulatedHazard} onChange={(event) => setSimulatedHazard(event.target.value)}>
              {MAP_NODES.filter((node) => node.kind === 'room').map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
            </select>
          </label>}
          <fieldset className="blocked-exit-list"><legend>Mark exits unavailable in this exercise</legend>
            {MAP_NODES.filter((node) => node.kind === 'exit').map((node) => <label key={node.id}><input type="checkbox" checked={blockedExits.includes(node.id)} onChange={() => toggleExit(node.id)} />{node.label}</label>)}
          </fieldset>
          {hazards.length > 0 && <div className="risk-note"><AlertTriangle size={15} /><span>{mappedLiveHazard && !simulation ? `A confirmed camera location matches “${props.confirmedLocation}” on this illustration only.` : 'Simulated incident selected.'} No real floorplan or verified hazard-location data is connected.</span></div>}
          <div className={`route-result ${route.length ? '' : 'route-unavailable'}`}>
            <strong>{route.length ? 'Illustrative path found' : 'No illustrative path available'}</strong>
            {route.length
              ? <ol>{route.map((nodeId) => <li key={nodeId}>{NODE_BY_ID.get(nodeId)?.label ?? nodeId}</li>)}</ol>
              : <p>Do not assume any route is safe. Follow verified building instructions, move away from immediate danger if possible, and contact emergency responders.</p>}
          </div>
          <p className="microcopy">The pathfinder excludes the selected sample hazard and blocked exits. It cannot verify current conditions.</p>
        </aside>
      </section>
      <section className="panel emergency-steps">
        <h2>Simple emergency instructions</h2>
        <ol><li>Stay calm; warn others nearby if it is safe.</li><li>Use your site’s verified evacuation plan and marked exits.</li><li>Do not use elevators. Do not re-enter a hazardous area.</li><li>Call local emergency services when needed; follow responders’ directions.</li></ol>
      </section>
    </div>
  );
}

function RiskCard(props: { assessment: RiskAssessment | null; error: string }) {
  const risk = props.assessment;
  const levelClass = risk?.level === 'CRITICAL' || risk?.level === 'HIGH RISK'
    ? 'risk-danger'
    : risk?.level === 'MODERATE RISK' || risk?.level === 'LOW RISK'
      ? 'risk-caution'
      : risk?.level === 'SAFE' ? 'risk-safe' : '';
  return (
    <section className="panel risk-card">
      <div className="experience-card-head"><span className="experience-icon"><ShieldAlert size={17} /></span><div><h2>Rule-based risk indicator</h2><p>Uses recent logged detections and actual sensor submissions</p></div></div>
      {risk ? <>
        <div className="risk-score-row"><strong className={levelClass}>{risk.score === null ? '—' : `${risk.score}`}<small>{risk.score === null ? '' : '/100'}</small></strong><span className={`risk-level ${levelClass}`}>{risk.level}</span></div>
        <p className="risk-basis">{risk.basis}</p>
        <div className="risk-metadata"><span>{risk.sensor_readings} physical reading{risk.sensor_readings === 1 ? '' : 's'} in the last hour</span><span>{risk.sensor_count ?? 0} sensor series</span></div>
        {risk.signals.length > 0 && <ul className="risk-signals">{risk.signals.map((signal) => <li key={signal}>{signal}</li>)}</ul>}
        <ul className="risk-actions">{risk.recommended_actions.map((action) => <li key={action}>{action}</li>)}</ul>
      </> : <p>{props.error || 'Loading the recent sensor and incident data…'}</p>}
      <small className="microcopy">This is an experimental trend heuristic, not a trained prediction model, certified alarm, or proof that an area is safe. Sensor values are real only when supplied by connected physical sensors.</small>
    </section>
  );
}

export function EmergencyResponsePage(props: {
  fireActive: boolean;
  confirmedLocation: string;
  accessibleMode: boolean;
}) {
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [requests, setRequests] = useState<SosRequest[]>([]);
  const [risk, setRisk] = useState<RiskAssessment | null>(null);
  const [riskError, setRiskError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [location, setLocation] = useState('');
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [notifyContacts, setNotifyContacts] = useState(false);
  const [emailConfigured, setEmailConfigured] = useState(false);

  const refresh = async () => {
    const results = await Promise.allSettled([
      api.emergencyContacts(), api.sosRequests(), api.risk(), api.health(),
    ]);
    const [contactResult, sosResult, riskResult, healthResult] = results;
    if (contactResult.status === 'fulfilled') setContacts(contactResult.value.items);
    if (sosResult.status === 'fulfilled') setRequests(sosResult.value.items);
    if (riskResult.status === 'fulfilled') { setRisk(riskResult.value); setRiskError(''); }
    else setRiskError(riskResult.reason instanceof Error ? riskResult.reason.message : 'Risk data unavailable.');
    if (healthResult.status === 'fulfilled') setEmailConfigured(healthResult.value.email_configured);
  };
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, []);

  const saveContact = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      const contact = await api.createEmergencyContact({
        name, email, phone, email_enabled: emailEnabled,
      });
      setContacts((old) => [contact, ...old]);
      setName(''); setEmail(''); setPhone(''); setEmailEnabled(false);
      setNotice('Contact saved. No notification was sent.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save this contact.');
    }
  };

  const removeContact = async (contact: EmergencyContact) => {
    if (!window.confirm(`Remove emergency contact ${contact.name}?`)) return;
    try {
      await api.deleteEmergencyContact(contact.id);
      setContacts((old) => old.filter((item) => item.id !== contact.id));
      setSelectedContacts((old) => old.filter((id) => id !== contact.id));
      setNotice('Emergency contact removed.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not remove this contact.');
    }
  };

  const sendSos = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(''); setNotice('');
    if (!window.confirm('Create a persistent SOS request now? External email will only be sent if you also enable notifications and confirm the next prompt. This does not contact emergency services.')) return;
    if (notifyContacts && !window.confirm(`Send an email notification to ${selectedContacts.length} selected contact(s)?`)) return;
    try {
      const incident = await api.createSos({
        location, message, notify_contacts: notifyContacts, contact_ids: selectedContacts,
      });
      setRequests((old) => [incident, ...old]);
      setMessage('');
      setNotice(notifyContacts
        ? `SOS recorded. Email delivery was queued for ${incident.emails_queued} contact(s); delivery is not guaranteed.`
        : 'SOS request recorded locally. No external notification was sent.');
      setNotifyContacts(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create the SOS request.');
    }
  };

  const acknowledge = async (incident: SosRequest) => {
    try {
      const updated = await api.acknowledgeSos(incident.id, 'Site operator');
      setRequests((old) => old.map((item) => item.id === updated.id ? updated : item));
      setNotice('SOS request acknowledged.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not acknowledge this SOS request.');
    }
  };

  return (
    <div className={`subpage ${props.accessibleMode ? 'experience-accessible' : ''}`}>
      <PageHeader eyebrow="EMERGENCY RESPONSE CENTER" title="Response coordination" detail="Review verified incident records, share an opt-in SOS, and keep human responders in control." />
      {props.fireActive && <div className="critical-banner experience-banner"><div className="critical-pulse"><Flame size={19} /></div><div><strong>CONFIRMED FIRE-CLASS MODEL OUTPUT</strong><p>Verify only from a safe location. Activate your facility’s verified response plan and contact local emergency services as appropriate.</p></div></div>}
      <div className="response-center-grid">
        <RiskCard assessment={risk} error={riskError} />
        <VoiceAssistant fireActive={props.fireActive} />
      </div>
      <section className="panel sos-panel">
        <div className="panel-header"><div><h2><LifeBuoy size={17} /> Emergency SOS</h2><p>Creates a persistent local request; external notification is optional and separately confirmed.</p></div><span className="demo-tag live-tag"><span /> HUMAN ACKNOWLEDGEMENT REQUIRED</span></div>
        {props.fireActive && <div className="risk-note"><CircleAlert size={15} /><span>Current camera location: {props.confirmedLocation || 'not mapped'}. Location is operator-provided and may not identify a building zone.</span></div>}
        <form className="sos-form" onSubmit={(event) => void sendSos(event)}>
          <label className="experience-field"><span>Incident location</span><input required maxLength={120} value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Enter a location people can identify" /></label>
          <label className="experience-field sos-message"><span>Message</span><textarea required maxLength={1000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Describe the request for help" /></label>
          <label className="toggle-row sos-notify"><input type="checkbox" checked={notifyContacts} onChange={(event) => setNotifyContacts(event.target.checked)} /><span><strong>Request email notification</strong><small>{emailConfigured ? 'Requires selecting enabled contacts and a second confirmation.' : 'SMTP is not configured; external notification is unavailable.'}</small></span></label>
          {notifyContacts && <fieldset className="contact-select"><legend>Choose enabled email contacts</legend>
            {contacts.filter((contact) => contact.email_enabled).map((contact) => <label key={contact.id}><input type="checkbox" checked={selectedContacts.includes(contact.id)} onChange={() => setSelectedContacts((old) => old.includes(contact.id) ? old.filter((id) => id !== contact.id) : [...old, contact.id])} /><span>{contact.name} · {contact.email}</span></label>)}
            {!contacts.some((contact) => contact.email_enabled) && <small>No contacts are configured for email.</small>}
          </fieldset>}
          <button className="btn btn-primary sos-submit" type="submit"><Send size={15} /> Submit SOS request</button>
        </form>
        {error && <div className="experience-error" role="alert">{error}</div>}
        {notice && <div className="experience-success" role="status"><Check size={14} />{notice}</div>}
      </section>
      <div className="response-center-grid">
        <section className="panel contact-panel">
          <div className="panel-header"><div><h2>Emergency contact directory</h2><p>Stored in this application; phone numbers are not used to send SMS.</p></div></div>
          <form className="contact-form" onSubmit={(event) => void saveContact(event)}>
            <label className="experience-field"><span>Name</span><input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label className="experience-field"><span>Email</span><input required type="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label className="experience-field"><span>Phone (directory only)</span><input maxLength={40} value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
            <label className="toggle-row"><input type="checkbox" checked={emailEnabled} onChange={(event) => setEmailEnabled(event.target.checked)} /><span><strong>Allow opt-in email notifications</strong><small>Does not send messages by itself.</small></span></label>
            <button className="btn btn-ghost" type="submit"><Plus size={14} /> Add contact</button>
          </form>
          <div className="contact-list">{contacts.map((contact) => <div className="contact-row" key={contact.id}><div><strong>{contact.name}</strong><span>{contact.email}</span><small>{contact.email_enabled ? 'Email opt-in enabled' : 'No email notifications'}{contact.phone ? ` · ${contact.phone}` : ''}</small></div><button className="icon-btn" title={`Remove ${contact.name}`} onClick={() => void removeContact(contact)}><Trash2 size={15} /></button></div>)}
            {!contacts.length && <p className="microcopy">No emergency contacts saved.</p>}
          </div>
        </section>
        <section className="panel sos-history">
          <div className="panel-header"><div><h2>Active SOS requests</h2><p>{requests.filter((item) => item.status === 'open').length} awaiting acknowledgement · SQLite history</p></div><button className="btn btn-ghost" onClick={() => void refresh()}>Refresh</button></div>
          <div className="sos-list">{requests.map((incident) => <article className={`sos-record ${incident.status === 'open' ? 'sos-open' : ''}`} key={incident.id}>
            <span className="sos-record-icon"><Radio size={16} /></span><div className="sos-record-copy"><strong>{incident.location}</strong><span>{incident.message}</span><small>{new Date(incident.timestamp).toLocaleString()} · {incident.email_requested ? `${incident.emails_queued} email(s) queued` : 'No external message'}</small></div>
            {incident.status === 'open' ? <button className="btn btn-ghost" onClick={() => void acknowledge(incident)}>Acknowledge</button> : <span className="acknowledged"><Check size={13} />Acknowledged</span>}
          </article>)}
            {!requests.length && <p className="microcopy">No SOS requests have been submitted.</p>}
          </div>
        </section>
      </div>
      <div className="info-callout experience-notice"><AlertTriangle size={16} /><span>Emberwatch SOS is not a public emergency dispatch service. For immediate danger, contact your local emergency number directly. Email is queued only after explicit consent, and phone/SMS delivery is not implemented.</span></div>
    </div>
  );
}

const DESIGN_STAGES = [
  ['Empathize', 'Listen to people facing evacuation, accessibility, and communication barriers.'],
  ['Define', 'Prioritize delayed detection, unclear exits, panic, language barriers, and false alarms.'],
  ['Ideate', 'Explore accessible guidance, multilingual communication, incident review, and safer coordination.'],
  ['Prototype', 'Exercise the illustrative evacuation map, voice announcements, and SOS workflow.'],
  ['Test', 'Record user feedback and scenario ratings; review the summary below.'],
];

export function DesignThinkingLab(props: { accessibleMode: boolean }) {
  const [persona, setPersona] = useState('Student / resident');
  const [category, setCategory] = useState('Usability');
  const [rating, setRating] = useState(4);
  const [message, setMessage] = useState('');
  const [scenario, setScenario] = useState('');
  const [scenarioStarted, setScenarioStarted] = useState(false);
  const [summary, setSummary] = useState<FeedbackSummary | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refreshSummary = async () => {
    try { setSummary(await api.feedbackSummary()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Feedback summary unavailable.'); }
  };
  useEffect(() => { void refreshSummary(); }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(''); setNotice('');
    try {
      await api.submitFeedback({
        persona, category, rating, message, scenario,
        accessibility_mode: props.accessibleMode,
      });
      setMessage('');
      setNotice('Feedback saved to the local SQLite testing record.');
      setScenarioStarted(false);
      await refreshSummary();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save feedback.');
    }
  };

  return (
    <div className="subpage">
      <PageHeader eyebrow="DESIGN THINKING · PROTOTYPE & TEST" title="Human-centered testing lab" detail="Evaluate the emergency workflows with real users; this page records feedback, not fire events." />
      <div className="design-stages">{DESIGN_STAGES.map(([title, detail], index) => <article className={`design-stage stage-${index + 1}`} key={title}><span>0{index + 1}</span><div><strong>{title}</strong><p>{detail}</p></div></article>)}</div>
      <section className="panel scenario-panel">
        <div className="panel-header"><div><h2>Scenario exercise</h2><p>Local UI exercise only; it does not activate sensors, send alerts, or contact responders.</p></div><span className="demo-tag"><span /> SIMULATION</span></div>
        <div className="scenario-controls">
          <label className="experience-field"><span>Choose a scenario</span><select value={scenario} onChange={(event) => { setScenario(event.target.value); setScenarioStarted(false); }}>
            <option value="">Select an exercise</option><option value="Smoke reported in a corridor">Smoke reported in a corridor</option><option value="Fire alarm with blocked exit">Fire alarm with blocked exit</option><option value="Multilingual evacuation announcement">Multilingual evacuation announcement</option><option value="Assistance request from a mobility-impaired person">Assistance request from a mobility-impaired person</option>
          </select></label>
          <button className="btn btn-primary" disabled={!scenario} onClick={() => setScenarioStarted(true)}><Radio size={14} /> Start scenario</button>
        </div>
        {scenarioStarted && <div className="scenario-prompt"><CircleAlert size={19} /><div><strong>Scenario underway: {scenario}</strong><p>Try the relevant voice, evacuation, accessibility, or SOS controls, then rate your experience below. This is not a real incident.</p></div></div>}
      </section>
      <div className="feedback-layout">
        <section className="panel feedback-form-panel">
          <div className="panel-header"><div><h2>Share product feedback</h2><p>Submissions are persisted locally for the project demonstration.</p></div></div>
          <form className="feedback-form" onSubmit={(event) => void submit(event)}>
            <div className="feedback-form-row">
              <label className="experience-field"><span>Your perspective</span><select value={persona} onChange={(event) => setPersona(event.target.value)}><option>Student / resident</option><option>Factory worker</option><option>Security guard</option><option>Older adult</option><option>Person with a disability</option><option>Emergency responder</option><option>Other</option></select></label>
              <label className="experience-field"><span>Feedback category</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option>Usability</option><option>Accessibility</option><option>Evacuation guidance</option><option>Language support</option><option>False alarm handling</option><option>Emergency communication</option><option>Bug report</option><option>Suggestion</option></select></label>
            </div>
            <label className="experience-field"><span>Rating · {rating}/5</span><input type="range" min="1" max="5" value={rating} onChange={(event) => setRating(Number(event.target.value))} /></label>
            <label className="experience-field"><span>What worked or should change?</span><textarea required minLength={3} maxLength={2000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Describe a usability issue or improvement…" /></label>
            <button className="btn btn-primary" type="submit"><Send size={14} /> Submit feedback</button>
          </form>
          {error && <div className="experience-error" role="alert">{error}</div>}
          {notice && <div className="experience-success" role="status"><Check size={14} />{notice}</div>}
        </section>
        <section className="panel feedback-summary">
          <div className="panel-header"><div><h2>Feedback summary</h2><p>Aggregated from saved submissions</p></div></div>
          <div className="feedback-score"><strong>{summary?.count ?? 0}</strong><span>responses</span><strong>{summary?.average_rating === null || summary?.average_rating === undefined ? '—' : `${summary.average_rating.toFixed(1)}/5`}</strong><span>average rating</span></div>
          <div className="feedback-breakdown"><h3>Categories</h3>{Object.entries(summary?.categories ?? {}).map(([name, count]) => <div key={name}><span>{name}</span><strong>{count}</strong></div>)}{!summary?.count && <p className="microcopy">No feedback recorded yet.</p>}</div>
          <div className="feedback-breakdown"><h3>Tested scenarios</h3>{Object.entries(summary?.scenarios ?? {}).map(([name, count]) => <div key={name}><span>{name}</span><strong>{count}</strong></div>)}</div>
        </section>
      </div>
      <div className="info-callout experience-notice"><AlertTriangle size={16} /><span>Run scenario tests with a facilitator. Demo routing and simulated scenario controls do not certify a building, replace supervised drills, or notify emergency services.</span></div>
    </div>
  );
}
