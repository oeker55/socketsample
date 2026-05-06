const socket = io();
const params = new URLSearchParams(window.location.search);
const sessionId = params.get('session') || '';
const AGENT_LOCAL_URL = 'http://127.0.0.1:9876';

const ICE_SERVERS = {
  iceServers: window.APP_CONFIG?.iceServers || [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  iceTransportPolicy: window.APP_CONFIG?.iceTransportPolicy || 'all',
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
  iceCandidatePoolSize: 4,
};

let localStream = null;
let peerConnections = {};
let remoteDescSetMap = {};
let pendingCandidatesMap = {};
let approved = false;
let agentReady = false;
let pendingControlViewerId = null;

const els = {
  approval: document.getElementById('approval-card'),
  approve: document.getElementById('approve-btn'),
  deny: document.getElementById('deny-btn'),
  agentCard: document.getElementById('agent-card'),
  agentIcon: document.getElementById('agent-status-icon'),
  agentText: document.getElementById('agent-status-text'),
  installHelp: document.getElementById('agent-install-help'),
  downloadLink: document.getElementById('agent-download-link'),
  retryAgent: document.getElementById('retry-agent-btn'),
  sharing: document.getElementById('sharing-card'),
  localVideo: document.getElementById('local-video'),
  stop: document.getElementById('stop-support-btn'),
  status: document.getElementById('customer-status'),
};

function setStatus(message) {
  els.status.textContent = message;
}

function setAgentStatus(kind, message) {
  els.agentCard.style.display = 'block';
  els.agentText.textContent = message;
  if (kind === 'ready') {
    els.agentIcon.innerHTML = '<svg class="icon"><use href="icons.svg#ico-check"/></svg>';
    els.installHelp.style.display = 'none';
  } else if (kind === 'missing') {
    els.agentIcon.innerHTML = '<svg class="icon"><use href="icons.svg#ico-alert"/></svg>';
    els.installHelp.style.display = 'block';
  } else {
    els.agentIcon.innerHTML = '<svg class="icon"><use href="icons.svg#ico-loader"/></svg>';
  }
}

function getAgentDeepLink() {
  return `royalstream-agent://connect?server=${encodeURIComponent(window.location.origin)}&room=${encodeURIComponent(sessionId)}`;
}

function configureDownloadLink() {
  const ua = navigator.userAgent;
  if (/Macintosh|Mac OS X/i.test(ua)) {
    els.downloadLink.href = /Intel|x86_64/i.test(ua)
      ? '/download/agent-mac-intel-app.zip'
      : '/download/agent-mac-app.zip';
    els.downloadLink.innerHTML = '<svg class="icon"><use href="icons.svg#ico-download"/></svg> Mac Agent İndir';
  } else {
    els.downloadLink.href = '/download/agent-windows.exe';
    els.downloadLink.innerHTML = '<svg class="icon"><use href="icons.svg#ico-download"/></svg> Windows Agent İndir';
  }
}

async function connectLocalAgent() {
  const res = await fetch(AGENT_LOCAL_URL + '/status', { signal: AbortSignal.timeout(900) });
  if (!res.ok) return false;
  await fetch(AGENT_LOCAL_URL + '/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverUrl: window.location.origin, roomId: sessionId }),
    signal: AbortSignal.timeout(1200),
  });
  return true;
}

function launchInstalledAgent() {
  window.location.href = getAgentDeepLink();
}

async function waitForAgent(timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await connectLocalAgent()) return true;
    } catch (e) { /* agent henüz hazır değil */ }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return false;
}

async function ensureAgent() {
  setAgentStatus('loading', 'Kurulu destek ajanı aranıyor...');
  try {
    if (await connectLocalAgent()) {
      agentReady = true;
      setAgentStatus('ready', 'Destek ajanı bağlı ve hazır.');
      return true;
    }
  } catch (e) { /* çalışmıyor */ }

  setAgentStatus('loading', 'Kurulu ajan açılıyor...');
  launchInstalledAgent();
  if (await waitForAgent()) {
    agentReady = true;
    setAgentStatus('ready', 'Destek ajanı bağlı ve hazır.');
    return true;
  }

  agentReady = false;
  setAgentStatus('missing', 'Destek ajanı kurulu değil veya açılamadı.');
  return false;
}

async function startScreenShare() {
  if (!window.isSecureContext) {
    throw new Error('Ekran paylaşımı için HTTPS gerekir.');
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Bu tarayıcı ekran paylaşımını desteklemiyor.');
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 },
      cursor: 'always',
      displaySurface: 'monitor',
    },
    audio: false,
    monitorTypeSurfaces: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
  });

  localStream = stream;
  els.localVideo.srcObject = stream;
  els.approval.style.display = 'none';
  els.sharing.style.display = 'block';
  stream.getVideoTracks()[0].onended = stopSupport;

  socket.emit('join-room', sessionId, 'broadcaster');
  setStatus('Ekran paylaşımı başladı. Temsilci bekleniyor...');
  await sendMonitorInfo();
}

async function sendMonitorInfo() {
  const track = localStream?.getVideoTracks?.()[0];
  const settings = track?.getSettings?.();
  if (!settings?.width || !settings?.height) return;
  socket.emit('set-active-monitor', { width: settings.width, height: settings.height });
  try {
    await fetch(AGENT_LOCAL_URL + '/set-monitor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width: settings.width, height: settings.height }),
      signal: AbortSignal.timeout(1000),
    });
  } catch (e) { /* agent yoksa sessiz */ }
}

function createPeer(viewerId) {
  if (peerConnections[viewerId]) {
    try { peerConnections[viewerId].close(); } catch (e) {}
  }

  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections[viewerId] = pc;
  remoteDescSetMap[viewerId] = false;
  pendingCandidatesMap[viewerId] = [];

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', { fromId: socket.id, targetId: viewerId, candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setStatus('Destek temsilcisi ekranınıza bağlı.');
    }
  };

  return pc;
}

async function handleNewViewer(viewerId) {
  if (!approved || !localStream) return;
  const pc = createPeer(viewerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { broadcasterId: socket.id, viewerId, offer });
}

socket.on('viewer-joined', ({ viewerId }) => {
  handleNewViewer(viewerId).catch((err) => {
    console.error(err);
    setStatus('Temsilci bağlantısı kurulamadı.');
  });
});

socket.on('answer', async ({ viewerId, answer }) => {
  const pc = peerConnections[viewerId];
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
  remoteDescSetMap[viewerId] = true;
  for (const c of pendingCandidatesMap[viewerId] || []) {
    await pc.addIceCandidate(new RTCIceCandidate(c));
  }
  pendingCandidatesMap[viewerId] = [];
});

socket.on('ice-candidate', async ({ fromId, candidate }) => {
  const pc = peerConnections[fromId];
  if (!pc) return;
  if (!remoteDescSetMap[fromId]) {
    pendingCandidatesMap[fromId].push(candidate);
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.warn('ICE adayı eklenemedi:', err.message);
  }
});

socket.on('control-request', async ({ viewerId }) => {
  if (!approved) {
    socket.emit('control-response', { viewerId, granted: false });
    return;
  }

  pendingControlViewerId = viewerId;
  if (!agentReady) {
    await ensureAgent();
  }

  if (agentReady) {
    socket.emit('control-response', { viewerId, granted: true });
    pendingControlViewerId = null;
    await sendMonitorInfo();
    setStatus('Kontrol onaylandı. İstediğiniz an oturumu bitirebilirsiniz.');
  } else {
    socket.emit('control-response', { viewerId, granted: false });
    setStatus('Kontrol için agent kurulumu gerekiyor.');
  }
});

socket.on('control-released', () => {
  setStatus('Temsilci kontrolü bıraktı.');
});

socket.on('connect', () => {
  if (approved) socket.emit('join-room', sessionId, 'broadcaster');
});

async function approveSupport() {
  if (!sessionId) {
    setStatus('Geçersiz destek bağlantısı.');
    return;
  }

  approved = true;
  els.approve.disabled = true;
  setStatus('Ekran paylaşımı izni bekleniyor...');
  try {
    await startScreenShare();
    ensureAgent().then(async (ok) => {
      if (ok && pendingControlViewerId) {
        socket.emit('control-response', { viewerId: pendingControlViewerId, granted: true });
        pendingControlViewerId = null;
        await sendMonitorInfo();
      }
    });
  } catch (err) {
    approved = false;
    els.approve.disabled = false;
    setStatus(err.message || 'Ekran paylaşımı başlatılamadı.');
  }
}

function stopSupport() {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  Object.values(peerConnections).forEach((pc) => pc.close());
  peerConnections = {};
  socket.emit('broadcaster-left');
  approved = false;
  els.sharing.style.display = 'none';
  els.approval.style.display = 'block';
  els.approve.disabled = false;
  setStatus('Destek oturumu kapatıldı.');
}

els.approve.addEventListener('click', approveSupport);
els.deny.addEventListener('click', () => {
  setStatus('Destek bağlantısı reddedildi.');
  els.approve.disabled = true;
  els.deny.disabled = true;
});
els.retryAgent.addEventListener('click', () => {
  ensureAgent().then(async (ok) => {
    if (ok && pendingControlViewerId) {
      socket.emit('control-response', { viewerId: pendingControlViewerId, granted: true });
      pendingControlViewerId = null;
      await sendMonitorInfo();
    }
  });
});
els.stop.addEventListener('click', stopSupport);

configureDownloadLink();
if (!sessionId) setStatus('Geçersiz destek bağlantısı.');
