// ——— Socket.IO Bağlantısı ———
const socket = io();

const ICE_SERVERS = {
  iceServers: window.APP_CONFIG?.iceServers || [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// TURN sunucu erişilebilirlik testi
(async function checkTurnServers() {
  const turnServers = (ICE_SERVERS.iceServers || []).filter(s => {
    const u = Array.isArray(s.urls) ? s.urls[0] : s.urls;
    return u && u.startsWith('turn');
  });
  if (turnServers.length === 0) {
    console.warn('⚠️ TURN sunucusu yapılandırılmamış — aynı ağdaki cihazlar bağlanamayabilir');
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
    if (hasTurnCandidate) {
      console.log('✅ TURN sunucusu erişilebilir (relay mevcut)');
    } else {
      console.warn('⚠️ TURN sunucusuna bağlanılamadı — aynı ağda sorun yaşanabilir');
    }
  } catch (e) {
    console.warn('⚠️ TURN testi başarısız:', e.message);
  }
})();

let peerConnection = null;
let broadcasterId = null;
let remoteDescSet = false;
let pendingCandidates = [];
let reconnectTimer = null;

const params = new URLSearchParams(window.location.search);
const roomId = params.get('room');

function setStatus(msg) {
  document.getElementById('status-msg').textContent = msg;
}

function showError(msg) {
  document.getElementById('loading-spinner').style.display = 'none';
  setStatus(msg);
}

// ——— Oda ID kontrolü ———
if (!roomId) {
  showError('❌ Geçersiz link! Oda ID\'si bulunamadı.');
} else {
  // Yayıncıdan Offer geldi
  socket.on('offer', async (data) => {
    const { broadcasterId: bId, offer, viewerId } = data;
    // Sadece bana gönderilen offer'ı işle
    if (viewerId !== socket.id) return;

    broadcasterId = bId;
    remoteDescSet = false;
    pendingCandidates = [];
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    // Var olan PC'yi ICE restart için yeniden kullan, yoksa yeni oluştur
    const needNewPC = !peerConnection || peerConnection.connectionState === 'closed';

    if (needNewPC) {
      if (peerConnection) try { peerConnection.close(); } catch(e) {}

      peerConnection = new RTCPeerConnection(ICE_SERVERS);

      // ICE adayları yayıncıya gönder
      peerConnection.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('ice-candidate', { fromId: socket.id, targetId: broadcasterId, candidate: e.candidate });
        }
      };

      // Stream geldiğinde videoyu göster
      let trackDebounce = null;
      peerConnection.ontrack = (e) => {
        console.log('📺 Track geldi:', e.track.kind, e.track.readyState);
        const videoEl = document.getElementById('remote-video');

        // Stream'i sadece bir kez ayarla
        if (!videoEl.srcObject || videoEl.srcObject.id !== (e.streams[0] && e.streams[0].id)) {
          videoEl.srcObject = e.streams[0] || new MediaStream([e.track]);
        } else if (e.streams[0]) {
          // Aynı stream, track zaten ekleniyor
        } else {
          videoEl.srcObject.addTrack(e.track);
        }

        document.getElementById('waiting-section').style.display = 'none';
        document.getElementById('video-section').style.display = 'block';

        // play() çağrısını debounce et — tüm track’ler gelsin
        if (trackDebounce) clearTimeout(trackDebounce);
        trackDebounce = setTimeout(() => {
          videoEl.muted = true;
          videoEl.play()
            .then(() => {
              console.log('📺 Video oynatılıyor (sessiz)');
              document.getElementById('unmute-overlay').style.display = 'flex';
            })
            .catch((err) => {
              console.warn('📺 Sessiz oynatma başarısız:', err);
              document.getElementById('unmute-overlay').style.display = 'flex';
            });
        }, 200);
      };

      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        console.log('🔗 Bağlantı durumu:', state);
        if (state === 'connected') {
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        } else if (state === 'failed') {
          setStatus('📡 Bağlantı başarısız — yeniden deneniyor...');
          if (!reconnectTimer) {
            reconnectTimer = setTimeout(fullReconnect, 8000);
          }
        } else if (state === 'disconnected') {
          setStatus('📡 Bağlantı zayıf, bekleniyor...');
        }
      };

      peerConnection.onicegatheringstatechange = () => {
        console.log('🧊 ICE toplama:', peerConnection.iceGatheringState);
      };

      peerConnection.oniceconnectionstatechange = () => {
        const iceState = peerConnection.iceConnectionState;
        console.log('🧊 ICE bağlantı:', iceState);
        if (iceState === 'checking') {
          setStatus('📡 Bağlantı kuruluyor...');
        } else if (iceState === 'connected' || iceState === 'completed') {
          setStatus('✅ Bağlandı');
        } else if (iceState === 'failed') {
          console.warn('🧊 ICE başarısız — TURN sunucuları erişilebilir olmayabilir');
          setStatus('❌ Bağlantı kurulamadı — güvenlik duvarı veya ağ sorunu olabilir');
        }
      };
    }

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
    } catch (err) {
      console.error('Offer işleme hatası:', err);
      showError('❌ Bağlantı sırasında hata oluştu.');
    }
  });

  // ICE Adayı geldi
  socket.on('ice-candidate', async (data) => {
    const { fromId, candidate, targetId } = data;
    // Sadece bana gönderilenleri işle
    if (targetId !== socket.id) return;
    if (!peerConnection || !remoteDescSet) {
      pendingCandidates.push(candidate);
      return;
    }
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('ICE aday hatası:', err);
    }
  });

  // Yayıncı yayını bitirdi
  socket.on('broadcaster-left', () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    document.getElementById('video-section').style.display = 'none';
    document.getElementById('waiting-section').style.display = 'block';
    document.getElementById('loading-spinner').style.display = 'none';
    setStatus('📴 Yayın sona erdi.');
    deactivateControl();
  });

  // Otomatik yeniden bağlanma
  function fullReconnect() {
    reconnectTimer = null;
    if (peerConnection) {
      try { peerConnection.close(); } catch(e) {}
      peerConnection = null;
    }
    remoteDescSet = false;
    pendingCandidates = [];
    document.getElementById('loading-spinner').style.display = 'block';
    setStatus('⏳ Yayına yeniden bağlanılıyor...');
    socket.emit('join-room', roomId, 'viewer');
  }

  // Odaya katıl ve yayıncıya bildir
  socket.on('connect', () => {
    socket.emit('join-room', roomId, 'viewer');
    setStatus('⏳ Yayıncı bağlanmayı bekliyor...');
    // Chat'i izleyici olarak başlat
    initChat(socket, false);
  });

  // Sayfa kapatılırken yayıncıya bildir
  window.addEventListener('beforeunload', () => {
    if (socket.connected) {
      socket.emit('viewer-left', { viewerId: socket.id });
    }
  });
}

// ——— Tam Ekran ———
const fullscreenBtn = document.getElementById('fullscreen-btn');
const videoWrapper = document.getElementById('video-wrapper');

fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    (videoWrapper.requestFullscreen || videoWrapper.webkitRequestFullscreen).call(videoWrapper);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
});

document.addEventListener('fullscreenchange', updateFsIcon);
document.addEventListener('webkitfullscreenchange', updateFsIcon);

function updateFsIcon() {
  const isFs = !!document.fullscreenElement;
  fullscreenBtn.textContent = isFs ? '⛶ Tam Ekrandan Çık' : '⛶ Tam Ekran';
}

// ——— Ses Aç butonu ———
document.getElementById('unmute-btn').addEventListener('click', () => {
  const videoEl = document.getElementById('remote-video');
  videoEl.muted = false;
  videoEl.play().then(() => {
    document.getElementById('unmute-overlay').style.display = 'none';
  }).catch(() => {
    // Sessiz bırak en azından video görünsün
    videoEl.muted = true;
    videoEl.play();
  });
});

// ——— Uzaktan Kontrol (İzleyici tarafı) ———
let controlActive = false;
let pendingControlReq = false;
let inputHandlersAttached = false;

// Kontrol iste
document.getElementById('request-control-btn').addEventListener('click', () => {
  if (controlActive || pendingControlReq) return;
  const nameEl = document.getElementById('chat-name');
  const viewerName = (nameEl && nameEl.value.trim()) || 'İsimsiz';
  socket.emit('control-request', { viewerName });
  pendingControlReq = true;
  const btn = document.getElementById('request-control-btn');
  btn.textContent = '⏳ İstek gönderildi...';
  btn.disabled = true;
});

// Kontrolü bırak
document.getElementById('release-control-btn').addEventListener('click', () => {
  socket.emit('control-release');
  deactivateControl();
});

// Kontrol verildi
socket.on('control-granted', () => {
  controlActive = true;
  pendingControlReq = false;
  document.getElementById('request-control-btn').style.display = 'none';
  document.getElementById('release-control-btn').style.display = 'inline-block';
  document.getElementById('control-status').textContent = '🟢 Kontrol sizde';
  document.getElementById('control-status').style.display = 'inline';

  const wrapper = document.getElementById('video-wrapper');
  wrapper.classList.add('control-mode');

  // Şeffaf overlay'ı aç — fare olaylarını yakalar
  document.getElementById('control-overlay').style.display = 'block';

  let badge = document.getElementById('control-mode-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'control-mode-badge';
    badge.className = 'control-mode-badge';
    badge.textContent = '🎮 KONTROL';
    wrapper.appendChild(badge);
  }
  badge.style.display = 'block';

  setupInputCapture();
});

// Kontrol reddedildi
socket.on('control-denied', () => {
  pendingControlReq = false;
  const btn = document.getElementById('request-control-btn');
  btn.textContent = '🎮 Kontrol İste';
  btn.disabled = false;
});

// Kontrol geri alındı
socket.on('control-revoked', () => {
  deactivateControl();
});

function deactivateControl() {
  controlActive = false;
  pendingControlReq = false;
  teardownInputCapture();

  document.getElementById('request-control-btn').style.display = 'inline-block';
  document.getElementById('request-control-btn').textContent = '🎮 Kontrol İste';
  document.getElementById('request-control-btn').disabled = false;
  document.getElementById('release-control-btn').style.display = 'none';
  document.getElementById('control-status').style.display = 'none';

  const wrapper = document.getElementById('video-wrapper');
  wrapper.classList.remove('control-mode');
  document.getElementById('control-overlay').style.display = 'none';
  const badge = document.getElementById('control-mode-badge');
  if (badge) badge.style.display = 'none';
}

// ——— Giriş Yakalama ———
function setupInputCapture() {
  if (inputHandlersAttached) return;
  const overlay = document.getElementById('control-overlay');
  overlay.addEventListener('mousemove', handleMouseMove);
  overlay.addEventListener('mousedown', handleMouseDown);
  overlay.addEventListener('mouseup', handleMouseUp);
  overlay.addEventListener('contextmenu', handleContextMenu);
  overlay.addEventListener('wheel', handleWheel, { passive: false });
  document.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keyup', handleKeyUp);
  inputHandlersAttached = true;
}

function teardownInputCapture() {
  if (!inputHandlersAttached) return;
  const overlay = document.getElementById('control-overlay');
  overlay.removeEventListener('mousemove', handleMouseMove);
  overlay.removeEventListener('mousedown', handleMouseDown);
  overlay.removeEventListener('mouseup', handleMouseUp);
  overlay.removeEventListener('contextmenu', handleContextMenu);
  overlay.removeEventListener('wheel', handleWheel);
  document.removeEventListener('keydown', handleKeyDown);
  document.removeEventListener('keyup', handleKeyUp);
  inputHandlersAttached = false;
}

function getRelativeCoords(e) {
  const videoEl = document.getElementById('remote-video');
  const rect = videoEl.getBoundingClientRect();
  const vw = videoEl.videoWidth || 1;
  const vh = videoEl.videoHeight || 1;
  const ew = rect.width;
  const eh = rect.height;

  // object-fit: contain hesaplaması
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
  const nx = (localX - offX) / displayW;
  const ny = (localY - offY) / displayH;

  return {
    nx: Math.max(0, Math.min(1, nx)),
    ny: Math.max(0, Math.min(1, ny))
  };
}

let lastMoveTs = 0;
function handleMouseMove(e) {
  if (!controlActive) return;
  const now = Date.now();
  if (now - lastMoveTs < 33) return; // ~30fps throttle
  lastMoveTs = now;
  const { nx, ny } = getRelativeCoords(e);
  socket.emit('remote-input', { type: 'mousemove', nx, ny });
}

function handleMouseDown(e) {
  if (!controlActive) return;
  e.preventDefault();
  const { nx, ny } = getRelativeCoords(e);
  const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
  socket.emit('remote-input', { type: 'mousedown', nx, ny, button });
}

function handleMouseUp(e) {
  if (!controlActive) return;
  e.preventDefault();
  const { nx, ny } = getRelativeCoords(e);
  const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
  socket.emit('remote-input', { type: 'mouseup', nx, ny, button });
}

function handleContextMenu(e) {
  if (!controlActive) return;
  e.preventDefault();
}

function handleWheel(e) {
  if (!controlActive) return;
  e.preventDefault();
  socket.emit('remote-input', { type: 'scroll', deltaY: e.deltaY });
}

function handleKeyDown(e) {
  if (!controlActive) return;
  const tag = (document.activeElement || {}).tagName || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  socket.emit('remote-input', { type: 'keydown', keyCode: e.keyCode });
}

function handleKeyUp(e) {
  if (!controlActive) return;
  const tag = (document.activeElement || {}).tagName || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  socket.emit('remote-input', { type: 'keyup', keyCode: e.keyCode });
}
