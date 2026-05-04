// ——— Yerel Ajan Algılama ———
const AGENT_LOCAL_URL = 'http://127.0.0.1:9876';
let agentAvailable = false;

// Ajan paneli tıklama — yardım bölümünü aç/kapa
document.addEventListener('DOMContentLoaded', () => {
  const bar = document.getElementById('agent-status-bar');
  if (bar) {
    bar.addEventListener('click', () => {
      const help = document.getElementById('agent-help');
      if (help) help.style.display = help.style.display === 'none' ? 'block' : 'none';
    });
  }
});

async function checkLocalAgent() {
  try {
    const res = await fetch(AGENT_LOCAL_URL + '/status', { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      agentAvailable = true;
      const data = await res.json();
      console.log('🤖 Yerel ajan algılandı:', data);
      updateAgentStatus(true, data.connected);
      return data;
    }
  } catch (e) { /* ajan çalışmıyor */ }
  agentAvailable = false;
  updateAgentStatus(false, false);
  return null;
}

async function connectAgentToRoom(roomId) {
  if (!agentAvailable) return;
  try {
    await fetch(AGENT_LOCAL_URL + '/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl: window.location.origin, roomId })
    });
    console.log('🤖 Ajan odaya bağlandı:', roomId);
    updateAgentStatus(true, true);
  } catch (e) {
    console.warn('🤖 Ajan bağlantı hatası:', e);
  }
}

async function findMonitorIndex(width, height) {
  let monitors = [];

  // 1. Ajandan monitör listesini al
  if (agentAvailable) {
    try {
      const res = await fetch(AGENT_LOCAL_URL + '/status', { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const status = await res.json();
        monitors = status.monitors || [];
      }
    } catch (e) { /* ajan başarısız */ }
  }

  // 2. Ajan yoksa sunucunun /api/monitors endpoint'inden al
  if (monitors.length === 0) {
    try {
      const res = await fetch('/api/monitors', { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const data = await res.json();
        monitors = data.monitors || [];
      }
    } catch (e) { /* sunucu başarısız */ }
  }

  if (monitors.length === 0) return undefined;
  console.log('📺 findMonitorIndex:', { width, height, monitors });

  // A. Tam eşleşme
  let idx = monitors.findIndex(m => m.w === width && m.h === height);

  // B. %5 toleransla eşleşme
  if (idx === -1) {
    idx = monitors.findIndex(m => {
      const wR = Math.abs(m.w - width) / Math.max(m.w, width);
      const hR = Math.abs(m.h - height) / Math.max(m.h, height);
      return wR < 0.05 && hR < 0.05;
    });
  }

  // C. DPI ölçek faktörleriyle eşleşme (Chrome CSS piksel raporlayabilir)
  if (idx === -1) {
    const scales = [1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
    for (const s of scales) {
      const sw = Math.round(width * s);
      const sh = Math.round(height * s);
      idx = monitors.findIndex(m => Math.abs(m.w - sw) <= 2 && Math.abs(m.h - sh) <= 2);
      if (idx !== -1) {
        console.log('📺 DPI ölçek eşleşmesi: x' + s, sw + 'x' + sh);
        break;
      }
    }
  }

  // D. Ters DPI — fiziksel piksel küçültülmüş olabilir
  if (idx === -1) {
    const scales = [1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
    for (const s of scales) {
      idx = monitors.findIndex(m => {
        const mw = Math.round(m.w / s);
        const mh = Math.round(m.h / s);
        return Math.abs(mw - width) <= 2 && Math.abs(mh - height) <= 2;
      });
      if (idx !== -1) {
        console.log('📺 Ters DPI eşleşmesi: /' + s);
        break;
      }
    }
  }

  // E. Benzersiz en-boy oranı eşleşmesi (birden fazla monitör farklı orana sahipse)
  if (idx === -1) {
    const targetRatio = width / height;
    const ratioMatches = monitors
      .map((m, i) => ({ i, ratio: m.w / m.h, diff: Math.abs((m.w / m.h) - targetRatio) }))
      .filter(r => r.diff < 0.02);
    if (ratioMatches.length === 1) {
      idx = ratioMatches[0].i;
      console.log('📺 Benzersiz en-boy oranı eşleşmesi');
    }
  }

  console.log('📺 findMonitorIndex sonuç:', idx);
  return idx >= 0 ? idx : undefined;
}

async function sendMonitorInfo(width, height) {
  // Kullanıcı monitör seçtiyse onu kullan
  const monSel = document.getElementById('monitor-select');
  const selIdx = monSel ? parseInt(monSel.value) : -1;
  const monitorIndex = selIdx >= 0 ? selIdx : await findMonitorIndex(width, height);
  console.log('📺 Monitör bilgisi:', { width, height, monitorIndex, manual: selIdx >= 0 });
  socket.emit('set-active-monitor', { width, height, monitorIndex });
  // Ajana da doğrudan bildir
  if (agentAvailable) {
    try {
      await fetch(AGENT_LOCAL_URL + '/set-monitor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ width, height, monitorIndex })
      });
    } catch (e) { /* sessiz */ }
  }
}

let showAgentUI = false;

function updateAgentStatus(detected, connected) {
  // Eski status div (kontrol isteği sırasında gösterilir)
  const el = document.getElementById('agent-status');
  if (el) {
    if (!detected || !showAgentUI) {
      el.style.display = 'none';
    } else {
      el.style.display = 'block';
      if (connected) {
        el.textContent = '🤖 Uzaktan kontrol ajanı bağlı';
        el.className = 'agent-status agent-connected';
      } else {
        el.textContent = '🤖 Ajan algılandı, bağlanıyor...';
        el.className = 'agent-status agent-detected';
      }
    }
  }

  // Yeni kalıcı ajan paneli
  const bar = document.getElementById('agent-status-bar');
  const icon = document.getElementById('agent-status-icon');
  const text = document.getElementById('agent-status-text');
  const help = document.getElementById('agent-help');
  if (!bar) return;

  if (detected && connected) {
    bar.className = 'agent-status-bar agent-ready';
    icon.innerHTML = '<svg class="icon"><use href="icons.svg#ico-check"/></svg>';
    text.textContent = 'Uzaktan kontrol ajanı bağlı ve hazır';
    if (help) help.style.display = 'none';
  } else if (detected) {
    bar.className = 'agent-status-bar agent-detecting';
    icon.innerHTML = '<svg class="icon"><use href="icons.svg#ico-loader"/></svg>';
    text.textContent = 'Ajan algılandı, bağlanıyor...';
    if (help) help.style.display = 'none';
  } else {
    bar.className = 'agent-status-bar agent-not-detected';
    icon.innerHTML = '<svg class="icon"><use href="icons.svg#ico-alert"/></svg>';
    text.textContent = 'Uzaktan kontrol ajanı algılanmadı';
    if (help) help.style.display = 'block';
  }
}

// Ajan kontrolü sessizce yapılır
async function silentAgentCheck() {
  try {
    const res = await fetch(AGENT_LOCAL_URL + '/status', { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      agentAvailable = true;
      const data = await res.json();
      updateAgentStatus(true, data.connected);
      return;
    }
  } catch (e) { /* ajan çalışmıyor */ }
  agentAvailable = false;
  updateAgentStatus(false, false);
}

// Periyodik kontrol
setInterval(silentAgentCheck, 5000);
silentAgentCheck();

// ——— Socket.IO Bağlantısı ———
const socket = io();
const myId = crypto.randomUUID();

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

const VIDEO_QUALITY = {
  screen: {
    contentHint: 'detail',
    maxBitrate: 25000000,
    minBitrate: 2500000,
    startBitrate: 12000000,
    maxFramerate: 30,
    degradationPreference: 'maintain-resolution',
    codecPreference: ['VP9', 'H264', 'VP8', 'AV1'],
  },
  camera: {
    contentHint: 'motion',
    maxBitrate: 6000000,
    minBitrate: 750000,
    startBitrate: 3000000,
    maxFramerate: 30,
    degradationPreference: 'balanced',
    codecPreference: ['H264', 'VP9', 'VP8', 'AV1'],
  },
};

const CAMERA_CAPTURE_OPTIONS = {
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 },
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

function createScreenCaptureOptions(forceMonitor = false) {
  const video = {
    width: { ideal: 3840 },
    height: { ideal: 2160 },
    frameRate: { ideal: 30, max: 60 },
    cursor: 'always',
    resizeMode: 'none',
  };
  if (forceMonitor) video.displaySurface = 'monitor';

  return {
    video,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    monitorTypeSurfaces: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include',
  };
}

// TURN erişilebilirlik testi (broadcaster tarafı)
(async function checkTurnServers() {
  const turnServers = (ICE_SERVERS.iceServers || []).filter(s => {
    const u = Array.isArray(s.urls) ? s.urls[0] : s.urls;
    return u && u.startsWith('turn');
  });
  if (turnServers.length === 0) {
    console.warn('⚠️ TURN sunucusu yok');
    return;
  }
  try {
    const testPC = new RTCPeerConnection({ iceServers: turnServers });
    testPC.createDataChannel('test');
    const offer = await testPC.createOffer();
    await testPC.setLocalDescription(offer);
    const hasTurnCandidate = await new Promise((resolve) => {
      let found = false;
      testPC.onicecandidate = (e) => {
        if (e.candidate && e.candidate.candidate.includes('relay')) {
          found = true;
          resolve(true);
        }
        if (!e.candidate && !found) resolve(false);
      };
      setTimeout(() => resolve(found), 5000);
    });
    testPC.close();
    console.log(hasTurnCandidate ? '✅ TURN erişilebilir' : '⚠️ TURN erişilemez — aynı ağda sorun olabilir');
  } catch (e) {
    console.warn('⚠️ TURN testi hatası:', e.message);
  }
})();

// ——— Bağlantı Tipi Algılama (Yayıncı) ———
let broadcasterConnInterval = null;

async function checkBroadcasterConnectionTypes() {
  const pcEntries = Object.entries(peerConnections);
  if (pcEntries.length === 0) {
    const card = document.getElementById('connection-type-card');
    if (card) card.style.display = 'none';
    return;
  }
  let hasRelay = false;
  let hasDirect = false;
  for (const [vid, pc] of pcEntries) {
    if (pc.connectionState === 'closed' || pc.iceConnectionState === 'new') continue;
    try {
      const stats = await pc.getStats();
      let activePair = null;
      stats.forEach(r => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded') activePair = r;
      });
      if (!activePair) continue;
      let localCand = null, remoteCand = null;
      stats.forEach(r => {
        if (r.id === activePair.localCandidateId) localCand = r;
        if (r.id === activePair.remoteCandidateId) remoteCand = r;
      });
      if (localCand?.candidateType === 'relay' || remoteCand?.candidateType === 'relay') {
        hasRelay = true;
      } else {
        hasDirect = true;
      }
    } catch (e) { /* sessiz */ }
  }
  const card = document.getElementById('connection-type-card');
  const val = document.getElementById('connection-type-value');
  if (!card || !val) return;
  card.style.display = 'flex';
  if (hasRelay && hasDirect) {
    val.innerHTML = '<svg class="icon icon-sm" style="color:#e0a040"><use href="icons.svg#ico-alert"/></svg> Karışık';
    val.style.color = '#e0a040';
    val.title = 'Bazı izleyiciler TURN (ücretli), bazıları doğrudan bağlı';
  } else if (hasRelay) {
    val.innerHTML = '<svg class="icon icon-sm" style="color:#f4516c"><use href="icons.svg#ico-zap"/></svg> TURN';
    val.style.color = '#f4516c';
    val.title = 'Tüm bağlantılar TURN sunucusu üzerinden (ücretli)';
  } else if (hasDirect) {
    val.innerHTML = '<svg class="icon icon-sm" style="color:#36d399"><use href="icons.svg#ico-shield"/></svg> Doğrudan';
    val.style.color = '#36d399';
    val.title = 'Tüm bağlantılar doğrudan/STUN (ücretsiz)';
  }
}

let localStream = null;
let peerConnections = {}; // viewerId -> RTCPeerConnection
let pendingCandidatesMap = {}; // viewerId -> [] (answer gelmeden önce ICE tamponu)
let remoteDescSetMap = {}; // viewerId -> bool
let viewerCount = 0;
let currentRoomId = null;

function ensureMediaDevices(featureName) {
  if (!window.isSecureContext) {
    throw new Error(`${featureName} için HTTPS gerekir. IP adresiyle HTTP üzerinden açıldığında tarayıcı bu özelliği kapatır.`);
  }

  if (!navigator.mediaDevices) {
    throw new Error('Tarayıcı medya aygıtlarına erişim vermedi. Sayfayı HTTPS üzerinden açın veya desteklenen bir masaustu tarayıcı kullanın.');
  }

  return navigator.mediaDevices;
}

function generateRoomId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function getVideoProfileName(track, fallback = 'camera') {
  const settings = track?.getSettings?.() || {};
  if (settings.displaySurface || /screen|display|window|monitor|ekran/i.test(track?.label || '')) {
    return 'screen';
  }
  return fallback;
}

async function tuneVideoTrack(track, profileName) {
  if (!track) return;
  const profile = VIDEO_QUALITY[profileName] || VIDEO_QUALITY.camera;
  try {
    track.contentHint = profile.contentHint;
  } catch (e) {
    console.warn('Video contentHint ayarlanamadi:', e.message);
  }

  if (profileName !== 'screen' || !track.applyConstraints) return;
  try {
    await track.applyConstraints({
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: 30, max: 60 },
      resizeMode: 'none',
    });
  } catch (e) {
    console.warn('Ekran paylasimi ek kalite kisitlari uygulanamadi:', e.message);
  }
}

async function prepareStreamQuality(stream, fallbackProfile) {
  const videoTrack = stream?.getVideoTracks?.()[0];
  if (!videoTrack) return fallbackProfile || 'camera';
  const profileName = getVideoProfileName(videoTrack, fallbackProfile);
  await tuneVideoTrack(videoTrack, profileName);
  const settings = videoTrack.getSettings?.() || {};
  console.log('Video kalite profili:', profileName, settings.width + 'x' + settings.height, settings.frameRate || '?', 'fps');
  return profileName;
}

async function applyVideoSenderQuality(sender, profileName) {
  if (!sender || sender.track?.kind !== 'video') return;
  const profile = VIDEO_QUALITY[profileName] || VIDEO_QUALITY.camera;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    const encoding = params.encodings[0];
    encoding.maxBitrate = profile.maxBitrate;
    encoding.maxFramerate = profile.maxFramerate;
    encoding.scaleResolutionDownBy = 1;
    encoding.active = true;
    if ('priority' in encoding) encoding.priority = 'high';
    if ('networkPriority' in encoding) encoding.networkPriority = 'high';
    if ('degradationPreference' in params) {
      params.degradationPreference = profile.degradationPreference;
    }
    await sender.setParameters(params);
  } catch (e) {
    console.warn('Video gonderim kalitesi ayarlanamadi:', e.message);
  }
}

function preferVideoCodecs(sdp, preferredCodecs) {
  if (!sdp || !preferredCodecs?.length) return sdp;
  const lines = sdp.split('\r\n');
  const mLineIndex = lines.findIndex((line) => line.startsWith('m=video '));
  if (mLineIndex === -1) return sdp;

  const payloadCodec = new Map();
  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+)\s+([^/]+)/i);
    if (match) payloadCodec.set(match[1], match[2].toUpperCase());
  }

  const mLineParts = lines[mLineIndex].split(' ');
  const header = mLineParts.slice(0, 3);
  const payloads = mLineParts.slice(3);
  const preferred = [];
  const rest = [];

  for (const payload of payloads) {
    const codec = payloadCodec.get(payload);
    const rank = preferredCodecs.findIndex((name) => name.toUpperCase() === codec);
    if (rank >= 0) {
      preferred.push({ payload, rank });
    } else {
      rest.push(payload);
    }
  }

  preferred.sort((a, b) => a.rank - b.rank);
  lines[mLineIndex] = header.concat(preferred.map((p) => p.payload), rest).join(' ');
  return lines.join('\r\n');
}

function setVideoBitrateInSdp(sdp, profile) {
  if (!sdp || !profile?.maxBitrate) return sdp;
  const kbps = Math.round(profile.maxBitrate / 1000);
  const minKbps = Math.round((profile.minBitrate || 0) / 1000);
  const startKbps = Math.round((profile.startBitrate || profile.maxBitrate) / 1000);
  const lines = sdp.split('\r\n');
  const mLineIndex = lines.findIndex((line) => line.startsWith('m=video '));
  if (mLineIndex === -1) return sdp;
  const payloadCodec = new Map();
  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+)\s+([^/]+)/i);
    if (match) payloadCodec.set(match[1], match[2].toUpperCase());
  }
  const bitrateCodecs = new Set(['VP8', 'VP9', 'H264', 'AV1']);

  let insertAt = mLineIndex + 1;
  while (insertAt < lines.length && (lines[insertAt].startsWith('i=') || lines[insertAt].startsWith('c='))) {
    insertAt++;
  }
  while (insertAt < lines.length && (lines[insertAt].startsWith('b=AS:') || lines[insertAt].startsWith('b=TIAS:'))) {
    lines.splice(insertAt, 1);
  }
  lines.splice(insertAt, 0, `b=AS:${kbps}`, `b=TIAS:${profile.maxBitrate}`);

  return lines.map((line) => {
    if (!line.startsWith('a=fmtp:')) return line;
    if (line.includes('x-google-max-bitrate')) return line;
    const match = line.match(/^a=fmtp:(\d+)/);
    if (!match || !bitrateCodecs.has(payloadCodec.get(match[1]))) return line;
    return `${line};x-google-min-bitrate=${minKbps};x-google-start-bitrate=${startKbps};x-google-max-bitrate=${kbps}`;
  }).join('\r\n');
}

function enhanceOfferForQuality(offer, profileName) {
  const profile = VIDEO_QUALITY[profileName] || VIDEO_QUALITY.camera;
  let sdp = preferVideoCodecs(offer.sdp, profile.codecPreference);
  sdp = setVideoBitrateInSdp(sdp, profile);
  return { type: offer.type, sdp };
}

// ——— Socket.IO Olaylarını Kur ———
function setupSocketEvents() {
  // İzleyiciden answer geldi
  socket.on('answer', async (data) => {
    const { viewerId, answer } = data;
    const pc = peerConnections[viewerId];
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      remoteDescSetMap[viewerId] = true;
      for (const c of (pendingCandidatesMap[viewerId] || [])) {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      }
      pendingCandidatesMap[viewerId] = [];
    } catch (err) {
      console.error('Answer işleme hatası:', err);
    }
  });

  // ICE adayı geldi
  socket.on('ice-candidate', async (data) => {
    const { fromId, candidate, targetId } = data;
    const pc = peerConnections[fromId];
    if (!pc) return;
    if (!remoteDescSetMap[fromId]) {
      if (!pendingCandidatesMap[fromId]) pendingCandidatesMap[fromId] = [];
      pendingCandidatesMap[fromId].push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('ICE aday hatası:', err);
    }
  });

  // İzleyici katıldı
  socket.on('viewer-joined', async (data) => {
    const { viewerId } = data;
    await handleNewViewer(viewerId);
  });

  // İzleyici ayrıldı
  socket.on('viewer-left', (data) => {
    const { viewerId } = data;
    if (peerConnections[viewerId]) {
      peerConnections[viewerId].close();
      delete peerConnections[viewerId];
      delete pendingCandidatesMap[viewerId];
      delete remoteDescSetMap[viewerId];
      viewerCount = Math.max(0, viewerCount - 1);
      document.getElementById('viewer-count').textContent = viewerCount;
    }
    // Kontrol oturumunu temizle
    if (viewerId === controlViewerId) {
      controlViewerId = null;
      document.getElementById('control-active-bar').style.display = 'none';
    }
    if (viewerId === pendingRequestViewerId) {
      pendingRequestViewerId = null;
      document.getElementById('control-notification').style.display = 'none';
    }
  });
}

setupSocketEvents();

// ——— Yeni izleyici için peer connection oluştur ———
async function handleNewViewer(viewerId) {
  // Var olan bağlantıyı temizle (yeniden bağlanma durumu)
  if (peerConnections[viewerId]) {
    peerConnections[viewerId].close();
    delete peerConnections[viewerId];
    delete pendingCandidatesMap[viewerId];
    delete remoteDescSetMap[viewerId];
    viewerCount = Math.max(0, viewerCount - 1);
  }

  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections[viewerId] = pc;
  pendingCandidatesMap[viewerId] = [];
  remoteDescSetMap[viewerId] = false;

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  const videoTrack = localStream.getVideoTracks()[0];
  const videoProfileName = getVideoProfileName(videoTrack);

  // Video kalitesi - yüksek bitrate ayarla
  try {
    const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (videoSender) {
      const params = videoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = VIDEO_QUALITY[videoProfileName].maxBitrate;
      params.encodings[0].maxFramerate = VIDEO_QUALITY[videoProfileName].maxFramerate;
      params.encodings[0].scaleResolutionDownBy = 1;
      if ('degradationPreference' in params) {
        params.degradationPreference = VIDEO_QUALITY[videoProfileName].degradationPreference;
      }
      await videoSender.setParameters(params);
    }
  } catch (e) {
    console.warn('Bitrate ayarlama hatası:', e);
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', { fromId: socket.id, targetId: viewerId, candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('Bağlantı durumu (' + viewerId + '):', pc.connectionState);
  };

  // ICE bağlantısı başarısız olursa yeniden dene
  pc.oniceconnectionstatechange = async () => {
    if (pc.iceConnectionState === 'failed') {
      try {
        console.log('ICE restart başlatılıyor:', viewerId);
        const rawOffer = await pc.createOffer({ iceRestart: true });
        const newOffer = enhanceOfferForQuality(rawOffer, videoProfileName);
        await pc.setLocalDescription(newOffer);
        socket.emit('offer', { broadcasterId: socket.id, viewerId, offer: newOffer });
      } catch (err) {
        console.error('ICE restart hatası:', err);
      }
    }
  };

  try {
    const rawOffer = await pc.createOffer();
    const offer = enhanceOfferForQuality(rawOffer, videoProfileName);
    await pc.setLocalDescription(offer);
    socket.emit('offer', { broadcasterId: socket.id, viewerId, offer });
  } catch (err) {
    console.error('Offer oluşturma hatası:', err);
  }

  viewerCount++;
  document.getElementById('viewer-count').textContent = viewerCount;

  // Bağlantı tipi kontrolünü başlat
  if (!broadcasterConnInterval) {
    broadcasterConnInterval = setInterval(checkBroadcasterConnectionTypes, 5000);
  }
  setTimeout(checkBroadcasterConnectionTypes, 3000);
}

// ——— Stream başlatıcı yardımcı ———
async function startStream(stream) {
  await prepareStreamQuality(stream);
  localStream = stream;
  document.getElementById('local-video').srcObject = stream;
  document.getElementById('setup-section').style.display = 'none';
  document.getElementById('stream-section').style.display = 'block';

  const roomId = generateRoomId();
  currentRoomId = roomId;
  socket.emit('join-room', roomId, 'broadcaster');

  const link = `${window.location.origin}/viewer.html?room=${roomId}`;
  document.getElementById('share-link').value = link;
  // Chat'i yayıncı olarak başlat
  initChat(socket, true);

  // Ajan durumunu kontrol et ve paneli güncelle
  checkLocalAgent();

  // Ekran paylaşımı kullanıcı kendisi durdurursa
  stream.getVideoTracks()[0].onended = () => {
    document.getElementById('stop-btn').click();
  };
}

// ——— Aktif bağlantılardaki track'i değiştir ———
async function switchSource(newStream) {
  const newVideoTrack = newStream.getVideoTracks()[0];
  const newAudioTrack = newStream.getAudioTracks()[0];
  const videoProfileName = await prepareStreamQuality(newStream);

  for (const pc of Object.values(peerConnections)) {
    const senders = pc.getSenders();
    const videoSender = senders.find((s) => s.track && s.track.kind === 'video');
    const audioSender = senders.find((s) => s.track && s.track.kind === 'audio');
    if (videoSender && newVideoTrack) {
      await videoSender.replaceTrack(newVideoTrack);
      await applyVideoSenderQuality(videoSender, videoProfileName);
    }
    if (audioSender && newAudioTrack) await audioSender.replaceTrack(newAudioTrack);
  }

  // Eski track'lerin onended handler'ını temizle (kaynak değiştirirken yayını kesmesin)
  if (localStream) {
    localStream.getVideoTracks().forEach(t => { t.onended = null; });
    localStream.getTracks().forEach((t) => t.stop());
  }
  localStream = newStream;
  document.getElementById('local-video').srcObject = newStream;

  // Kontrol aktifse yeni monitör bilgisini sunucuya ve ajana bildir
  if (controlViewerId) {
    const s = newVideoTrack?.getSettings();
    if (s) {
      await sendMonitorInfo(s.width, s.height);
    }
  }

  newStream.getVideoTracks()[0].onended = () => {
    document.getElementById('stop-btn').click();
  };
}

// ——— Kamera ile Başla ———
document.getElementById('start-camera-btn').addEventListener('click', async () => {
  try {
    const mediaDevices = ensureMediaDevices('Kamera/mikrofon erişimi');
    const stream = await mediaDevices.getUserMedia(CAMERA_CAPTURE_OPTIONS);
    await startStream(stream);
  } catch (err) {
    alert('❌ Kamera/mikrofon erişimi sağlanamadı:\n' + err.message);
  }
});

// ——— Ekran ile Başla ———
document.getElementById('start-screen-btn').addEventListener('click', async () => {
  try {
    const mediaDevices = ensureMediaDevices('Ekran paylaşımı');
    if (!mediaDevices.getDisplayMedia) {
      throw new Error('Bu tarayıcı ekran paylaşımını desteklemiyor. Chrome, Edge veya HTTPS üzerinden çalışan masaustu bir tarayıcı kullanın.');
    }
    const stream = await mediaDevices.getDisplayMedia(createScreenCaptureOptions());
    await startStream(stream);
  } catch (err) {
    if (err.name !== 'AbortError' && err.name !== 'NotAllowedError') {
      alert('❌ Ekran paylaşımı başlatmadı:\n' + err.message);
    }
  }
});

// ——— Kameraya Geç ———
document.getElementById('switch-camera-btn').addEventListener('click', async () => {
  try {
    const mediaDevices = ensureMediaDevices('Kamera/mikrofon erişimi');
    const stream = await mediaDevices.getUserMedia(CAMERA_CAPTURE_OPTIONS);
    await switchSource(stream);
  } catch (err) {
    alert('❌ Kamera erişimi sağlanamadı:\n' + err.message);
  }
});

// ——— Ekrana Geç ———
document.getElementById('switch-screen-btn').addEventListener('click', async () => {
  try {
    const mediaDevices = ensureMediaDevices('Ekran paylaşımı');
    if (!mediaDevices.getDisplayMedia) {
      throw new Error('Bu tarayıcı ekran paylaşımını desteklemiyor. Chrome, Edge veya HTTPS üzerinden çalışan masaustu bir tarayıcı kullanın.');
    }
    const stream = await mediaDevices.getDisplayMedia(createScreenCaptureOptions());
    await switchSource(stream);
  } catch (err) {
    if (err.name !== 'AbortError' && err.name !== 'NotAllowedError') {
      alert('❌ Ekran paylaşımı başlatmadı:\n' + err.message);
    }
  }
});

// ——— Linki Kopyala ———
document.getElementById('copy-btn').addEventListener('click', () => {
  const linkInput = document.getElementById('share-link');
  navigator.clipboard.writeText(linkInput.value).then(() => {
    const btn = document.getElementById('copy-btn');
    btn.innerHTML = '<svg class="icon"><use href="icons.svg#ico-check"/></svg> Kopyalandı!';
    setTimeout(() => { btn.innerHTML = '<svg class="icon"><use href="icons.svg#ico-copy"/></svg> Kopyala'; }, 2500);
  });
});

// ——— Yayını Durdur ———
document.getElementById('stop-btn').addEventListener('click', () => {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  Object.values(peerConnections).forEach((pc) => pc.close());
  peerConnections = {};
  pendingCandidatesMap = {};
  remoteDescSetMap = {};
  viewerCount = 0;
  document.getElementById('viewer-count').textContent = 0;

  // Kontrol oturumunu temizle
  if (controlViewerId) {
    socket.emit('control-revoke');
    controlViewerId = null;
    document.getElementById('control-active-bar').style.display = 'none';
  }
  pendingRequestViewerId = null;
  document.getElementById('control-notification').style.display = 'none';

  // Bağlantı tipi kontrolünü durdur
  if (broadcasterConnInterval) {
    clearInterval(broadcasterConnInterval);
    broadcasterConnInterval = null;
  }
  const connCard = document.getElementById('connection-type-card');
  if (connCard) connCard.style.display = 'none';

  // Yayıncı ayrıldığını bildir
  if (socket.connected) {
    socket.emit('broadcaster-left');
  }

  document.getElementById('stream-section').style.display = 'none';
  document.getElementById('setup-section').style.display = 'block';
});

// ——— Uzaktan Kontrol (Yayıncı tarafı) ———
let controlViewerId = null;
let pendingRequestViewerId = null;

// İzleyiciden kontrol isteği geldi
socket.on('control-request', async ({ viewerId, viewerName }) => {
  if (controlViewerId) return; // zaten biri kontrol ediyor
  pendingRequestViewerId = viewerId;
  document.getElementById('control-requester-name').textContent =
    (viewerName || 'Bir izleyici') + ' kontrol istiyor';
  document.getElementById('control-notification').style.display = 'block';

  // Ajan algılıysa monitör seçici göster
  showAgentUI = true;
  const agentData = await checkLocalAgent();
  let monitorList = null;
  if (agentAvailable && agentData && agentData.monitors && agentData.monitors.length > 1) {
    monitorList = agentData.monitors;
  }
  // Ajan yoksa sunucudan monitör listesini al
  if (!monitorList) {
    try {
      const res = await fetch('/api/monitors', { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const data = await res.json();
        if (data.monitors && data.monitors.length > 1) {
          monitorList = data.monitors;
        }
      }
    } catch (e) { /* sessiz */ }
  }
  if (monitorList && monitorList.length > 1) {
    const sel = document.getElementById('monitor-select');
    if (sel) {
      sel.innerHTML = '<option value="-1">Otomatik algıla</option>';
      monitorList.forEach((m, i) => {
        const label = 'Monitör ' + (i + 1) + ': ' + m.w + 'x' + m.h + (m.primary ? ' (Ana)' : '');
        sel.innerHTML += '<option value="' + i + '">' + label + '</option>';
      });
      document.getElementById('monitor-select-row').style.display = 'flex';
    }
  }
});

// Kabul
document.getElementById('control-accept-btn').addEventListener('click', async () => {
  if (!pendingRequestViewerId) return;

  // Uzaktan kontrol için tüm ekranın paylaşılması gerekir
  const videoTrack = localStream?.getVideoTracks()[0];
  const settings = videoTrack?.getSettings();
  const isFullScreen = settings?.displaySurface === 'monitor';

  if (!isFullScreen) {
    try {
      const mediaDevices = ensureMediaDevices('Ekran paylaşımı');
      const stream = await mediaDevices.getDisplayMedia(createScreenCaptureOptions(true));
      await switchSource(stream);
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'NotAllowedError') {
        alert('⚠️ Uzaktan kontrol için tüm ekranın paylaşılması gerekir.\nLütfen "Tüm Ekran" seçeneğini seçin.');
        return;
      }
      console.warn('Tam ekran paylaşımına geçilemedi:', err.message);
    }
  }

  // Yerel ajanı kontrol isteği kabul edildiğinde bağla
  showAgentUI = true;
  await checkLocalAgent();
  if (agentAvailable && currentRoomId) {
    await connectAgentToRoom(currentRoomId);
  }

  controlViewerId = pendingRequestViewerId;
  socket.emit('control-response', { viewerId: pendingRequestViewerId, granted: true });

  // Paylaşılan monitörün çözünürlüğünü sunucuya bildir
  const activeTrack = localStream?.getVideoTracks()[0];
  if (activeTrack) {
    const s = activeTrack.getSettings();
    await sendMonitorInfo(s.width, s.height);
  }

  pendingRequestViewerId = null;
  document.getElementById('control-notification').style.display = 'none';
  document.getElementById('monitor-select-row').style.display = 'none';
  document.getElementById('control-active-bar').style.display = 'flex';
});

// Reddet
document.getElementById('control-deny-btn').addEventListener('click', () => {
  if (!pendingRequestViewerId) return;
  socket.emit('control-response', { viewerId: pendingRequestViewerId, granted: false });
  pendingRequestViewerId = null;
  showAgentUI = false;
  document.getElementById('control-notification').style.display = 'none';
  document.getElementById('monitor-select-row').style.display = 'none';
  updateAgentStatus(false, false);
});

// Kontrolü geri al
document.getElementById('control-revoke-btn').addEventListener('click', () => {
  socket.emit('control-revoke');
  controlViewerId = null;
  showAgentUI = false;
  document.getElementById('control-active-bar').style.display = 'none';
  updateAgentStatus(false, false);
});

// İzleyici kontrolü bıraktı
socket.on('control-released', () => {
  controlViewerId = null;
  showAgentUI = false;
  document.getElementById('control-active-bar').style.display = 'none';
  updateAgentStatus(false, false);
});
