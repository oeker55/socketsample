const socket = io();
const params = new URLSearchParams(window.location.search);

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

let sessionId = params.get('session') || '';
let sessionInfo = null;
let peerConnection = null;
let broadcasterId = null;
let remoteDescSet = false;
let pendingCandidates = [];
let controlActive = false;
let pendingControlReq = false;
let inputHandlersAttached = false;
let lastMoveTs = 0;

const els = {
  sessionId: document.getElementById('session-id'),
  customerLink: document.getElementById('customer-link'),
  copyCustomerLink: document.getElementById('copy-customer-link'),
  openCustomerDemo: document.getElementById('open-customer-demo'),
  requestControl: document.getElementById('request-control-btn'),
  releaseControl: document.getElementById('release-control-btn'),
  status: document.getElementById('support-status'),
  statusMsg: document.getElementById('status-msg'),
  waiting: document.getElementById('waiting-section'),
  videoSection: document.getElementById('video-section'),
  video: document.getElementById('remote-video'),
  wrapper: document.getElementById('video-wrapper'),
  overlay: document.getElementById('control-overlay'),
  fullscreen: document.getElementById('fullscreen-btn'),
};

function setStatus(message) {
  els.status.textContent = message;
  els.statusMsg.textContent = message;
}

async function ensureSession() {
  if (!sessionId) {
    const res = await fetch('/api/support/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: params.get('customerId') || '',
        customerName: params.get('customerName') || '',
      }),
    });
    sessionInfo = await res.json();
    sessionId = sessionInfo.sessionId;
    history.replaceState(null, '', `/support.html?session=${encodeURIComponent(sessionId)}`);
    return;
  }

  const res = await fetch(`/api/support/sessions/${encodeURIComponent(sessionId)}`);
  sessionInfo = await res.json();
}

function renderSession() {
  els.sessionId.textContent = sessionInfo.sessionId;
  els.customerLink.value = sessionInfo.customerUrl;
  els.openCustomerDemo.onclick = () => window.open(sessionInfo.customerUrl, '_blank', 'noopener');
  els.copyCustomerLink.onclick = async () => {
    await navigator.clipboard.writeText(sessionInfo.customerUrl);
    els.copyCustomerLink.innerHTML = '<svg class="icon"><use href="icons.svg#ico-check"/></svg>';
    setTimeout(() => {
      els.copyCustomerLink.innerHTML = '<svg class="icon"><use href="icons.svg#ico-copy"/></svg>';
    }, 1600);
  };
}

function joinAsSupport() {
  socket.on('connect', () => {
    socket.emit('join-room', sessionId, 'viewer');
    setStatus('Müşterinin onay vermesi bekleniyor...');
  });
}

function createPeerConnection() {
  if (peerConnection) {
    try { peerConnection.close(); } catch (e) {}
  }

  peerConnection = new RTCPeerConnection(ICE_SERVERS);
  remoteDescSet = false;
  pendingCandidates = [];

  peerConnection.onicecandidate = (e) => {
    if (e.candidate && broadcasterId) {
      socket.emit('ice-candidate', { fromId: socket.id, targetId: broadcasterId, candidate: e.candidate });
    }
  };

  peerConnection.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (!els.video.srcObject || els.video.srcObject.id !== stream.id) {
      els.video.srcObject = stream;
    }
    els.waiting.style.display = 'none';
    els.videoSection.style.display = 'block';
    els.requestControl.disabled = false;
    setStatus('Müşteri ekranı bağlı. Kontrol talep edebilirsiniz.');
    els.video.play().catch(() => {});
  };

  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) return;
    if (peerConnection.connectionState === 'connected') {
      setStatus('Ekran bağlantısı kuruldu.');
    } else if (peerConnection.connectionState === 'failed') {
      setStatus('Bağlantı başarısız oldu. Müşteriden oturumu yenilemesini isteyin.');
    }
  };
}

socket.on('offer', async ({ broadcasterId: bId, offer, viewerId }) => {
  if (viewerId !== socket.id) return;
  broadcasterId = bId;
  createPeerConnection();
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    remoteDescSet = true;
    for (const c of pendingCandidates) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(c));
    }
    pendingCandidates = [];
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('answer', { viewerId: socket.id, answer });
    setStatus('Ekran bağlantısı kuruluyor...');
  } catch (err) {
    console.error(err);
    setStatus('Ekran bağlantısı kurulamadı.');
  }
});

socket.on('ice-candidate', async ({ candidate, targetId }) => {
  if (targetId !== socket.id) return;
  if (!peerConnection || !remoteDescSet) {
    pendingCandidates.push(candidate);
    return;
  }
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.warn('ICE adayı eklenemedi:', err.message);
  }
});

socket.on('broadcaster-left', () => {
  deactivateControl();
  if (peerConnection) peerConnection.close();
  peerConnection = null;
  els.videoSection.style.display = 'none';
  els.waiting.style.display = 'flex';
  els.requestControl.disabled = true;
  setStatus('Müşteri oturumu kapattı.');
});

els.requestControl.addEventListener('click', () => {
  if (controlActive || pendingControlReq) return;
  socket.emit('control-request', { viewerName: 'Destek Temsilcisi' });
  pendingControlReq = true;
  els.requestControl.disabled = true;
  els.requestControl.innerHTML = '<svg class="icon"><use href="icons.svg#ico-loader"/></svg> Onay bekleniyor...';
  setStatus('Müşteriden kontrol onayı bekleniyor...');
});

els.releaseControl.addEventListener('click', () => {
  socket.emit('control-release');
  deactivateControl();
});

socket.on('control-granted', () => {
  controlActive = true;
  pendingControlReq = false;
  els.requestControl.style.display = 'none';
  els.releaseControl.style.display = 'inline-flex';
  els.overlay.style.display = 'block';
  els.wrapper.classList.add('control-mode');
  setupInputCapture();
  setStatus('Kontrol sizde.');
});

socket.on('control-denied', () => {
  pendingControlReq = false;
  els.requestControl.disabled = false;
  els.requestControl.innerHTML = '<svg class="icon"><use href="icons.svg#ico-gamepad"/></svg> Kontrol Talep Et';
  setStatus('Kontrol talebi onaylanmadı veya agent hazır değil.');
});

socket.on('control-revoked', deactivateControl);

function deactivateControl() {
  controlActive = false;
  pendingControlReq = false;
  teardownInputCapture();
  els.overlay.style.display = 'none';
  els.wrapper.classList.remove('control-mode');
  els.releaseControl.style.display = 'none';
  els.requestControl.style.display = 'inline-flex';
  els.requestControl.disabled = !els.video.srcObject;
  els.requestControl.innerHTML = '<svg class="icon"><use href="icons.svg#ico-gamepad"/></svg> Kontrol Talep Et';
}

function setupInputCapture() {
  if (inputHandlersAttached) return;
  els.overlay.addEventListener('mousemove', handleMouseMove);
  els.overlay.addEventListener('mousedown', handleMouseDown);
  els.overlay.addEventListener('mouseup', handleMouseUp);
  els.overlay.addEventListener('contextmenu', handleContextMenu);
  els.overlay.addEventListener('wheel', handleWheel, { passive: false });
  document.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keyup', handleKeyUp);
  inputHandlersAttached = true;
}

function teardownInputCapture() {
  if (!inputHandlersAttached) return;
  els.overlay.removeEventListener('mousemove', handleMouseMove);
  els.overlay.removeEventListener('mousedown', handleMouseDown);
  els.overlay.removeEventListener('mouseup', handleMouseUp);
  els.overlay.removeEventListener('contextmenu', handleContextMenu);
  els.overlay.removeEventListener('wheel', handleWheel);
  document.removeEventListener('keydown', handleKeyDown);
  document.removeEventListener('keyup', handleKeyUp);
  inputHandlersAttached = false;
}

function getRelativeCoords(e) {
  const rect = els.video.getBoundingClientRect();
  const vw = els.video.videoWidth || 1;
  const vh = els.video.videoHeight || 1;
  const ew = rect.width;
  const eh = rect.height;
  const videoAR = vw / vh;
  const elemAR = ew / eh;
  let displayW, displayH, offX, offY;

  if (videoAR > elemAR) {
    displayW = ew;
    displayH = ew / videoAR;
    offX = 0;
    offY = (eh - displayH) / 2;
  } else {
    displayH = eh;
    displayW = eh * videoAR;
    offX = (ew - displayW) / 2;
    offY = 0;
  }

  const localX = e.clientX - rect.left;
  const localY = e.clientY - rect.top;
  return {
    nx: Math.max(0, Math.min(1, (localX - offX) / displayW)),
    ny: Math.max(0, Math.min(1, (localY - offY) / displayH)),
  };
}

function emitRemoteInput(data, dropIfBusy = false) {
  const channel = dropIfBusy && socket.volatile ? socket.volatile : socket;
  channel.emit('remote-input', data);
}

function handleMouseMove(e) {
  if (!controlActive) return;
  e.preventDefault();
  const now = performance.now();
  if (now - lastMoveTs < 16) return;
  lastMoveTs = now;
  const { nx, ny } = getRelativeCoords(e);
  emitRemoteInput({ type: 'mousemove', nx, ny }, true);
}

function handleMouseDown(e) {
  if (!controlActive) return;
  e.preventDefault();
  const { nx, ny } = getRelativeCoords(e);
  const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
  emitRemoteInput({ type: 'mousedown', nx, ny, button });
}

function handleMouseUp(e) {
  if (!controlActive) return;
  e.preventDefault();
  const { nx, ny } = getRelativeCoords(e);
  const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
  emitRemoteInput({ type: 'mouseup', nx, ny, button });
}

function handleContextMenu(e) {
  if (controlActive) e.preventDefault();
}

function handleWheel(e) {
  if (!controlActive) return;
  e.preventDefault();
  emitRemoteInput({ type: 'scroll', deltaY: e.deltaY });
}

function handleKeyDown(e) {
  if (!controlActive) return;
  const tag = (document.activeElement || {}).tagName || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  emitRemoteInput({ type: 'keydown', keyCode: e.keyCode });
}

function handleKeyUp(e) {
  if (!controlActive) return;
  const tag = (document.activeElement || {}).tagName || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  emitRemoteInput({ type: 'keyup', keyCode: e.keyCode });
}

els.fullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    (els.wrapper.requestFullscreen || els.wrapper.webkitRequestFullscreen).call(els.wrapper);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
});

(async function init() {
  try {
    await ensureSession();
    renderSession();
    joinAsSupport();
  } catch (err) {
    console.error(err);
    setStatus('Destek oturumu oluşturulamadı.');
  }
})();
