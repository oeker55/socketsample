// ——— Socket.IO Bağlantısı ———
const socket = io();

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
  showError('Geçersiz link — Oda ID bulunamadı.');
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
          setStatus('Bağlantı başarısız — yeniden deneniyor...');
          if (!reconnectTimer) {
            reconnectTimer = setTimeout(fullReconnect, 8000);
          }
        } else if (state === 'disconnected') {
          setStatus('Bağlantı zayıf, bekleniyor...');
        }
      };

      peerConnection.onicegatheringstatechange = () => {
        console.log('🧊 ICE toplama:', peerConnection.iceGatheringState);
      };

      peerConnection.oniceconnectionstatechange = () => {
        const iceState = peerConnection.iceConnectionState;
        console.log('🧊 ICE bağlantı:', iceState);
        if (iceState === 'checking') {
          setStatus('Bağlantı kuruluyor...');
        } else if (iceState === 'connected' || iceState === 'completed') {
          setStatus('Bağlandı');
          // Bağlantı tipi kontrolünü başlat
          checkConnectionType();
          if (connectionCheckInterval) clearInterval(connectionCheckInterval);
          connectionCheckInterval = setInterval(checkConnectionType, 5000);
        } else if (iceState === 'failed') {
          console.warn('🧊 ICE başarısız — TURN sunucuları erişilebilir olmayabilir');
          setStatus('Bağlantı kurulamadı — güvenlik duvarı veya ağ sorunu olabilir');
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
      showError('Bağlantı sırasında hata oluştu.');
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
    setStatus('Yayın sona erdi.');
    deactivateControl();
    // Bağlantı tipi göstergesini temizle
    if (connectionCheckInterval) { clearInterval(connectionCheckInterval); connectionCheckInterval = null; }
    const connBar = document.getElementById('connection-type-bar');
    if (connBar) connBar.style.display = 'none';
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
    setStatus('Yayına yeniden bağlanılıyor...');
    socket.emit('join-room', roomId, 'viewer');
  }

  // Odaya katıl ve yayıncıya bildir
  socket.on('connect', () => {
    socket.emit('join-room', roomId, 'viewer');
    setStatus('Yayıncı bağlanmayı bekliyor...');
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

// ——— Bağlantı Tipi Algılama ———
let connectionCheckInterval = null;

async function checkConnectionType() {
  if (!peerConnection || peerConnection.connectionState === 'closed') return;
  try {
    const stats = await peerConnection.getStats();
    let activePair = null;
    stats.forEach(report => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        activePair = report;
      }
    });
    if (!activePair) return;

    let localCandidate = null;
    let remoteCandidate = null;
    stats.forEach(report => {
      if (report.id === activePair.localCandidateId) localCandidate = report;
      if (report.id === activePair.remoteCandidateId) remoteCandidate = report;
    });

    const localType = localCandidate?.candidateType || '?';
    const remoteType = remoteCandidate?.candidateType || '?';
    const isRelay = localType === 'relay' || remoteType === 'relay';
    const protocol = localCandidate?.protocol || '';

    const bar = document.getElementById('connection-type-bar');
    const icon = document.getElementById('connection-type-icon');
    const text = document.getElementById('connection-type-text');
    if (!bar) return;

    bar.style.display = 'flex';
    if (isRelay) {
      bar.className = 'connection-type-bar conn-relay';
      icon.innerHTML = '<svg class="icon"><use href="icons.svg#ico-zap"/></svg>';
      text.innerHTML = 'TURN Relay (Ücretli)' +
        '<span class="connection-type-details"> — Veri TURN sunucusu üzerinden aktarılıyor (' + protocol.toUpperCase() + ')</span>';
    } else {
      bar.className = 'connection-type-bar conn-direct';
      icon.innerHTML = '<svg class="icon"><use href="icons.svg#ico-shield"/></svg>';
      const typeLabel = localType === 'host' ? 'Doğrudan (P2P)' : 'STUN';
      text.innerHTML = typeLabel + ' (Ücretsiz)' +
        '<span class="connection-type-details"> — ' +
        (localType === 'host' ? 'Doğrudan bağlantı kuruldu' : 'STUN ile NAT geçişi yapıldı') +
        ' (' + protocol.toUpperCase() + ')</span>';
    }
  } catch (e) {
    console.warn('Bağlantı tipi kontrol hatası:', e);
  }
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
  fullscreenBtn.innerHTML = isFs
    ? '<svg class="icon"><use href="icons.svg#ico-minimize"/></svg> Tam Ekrandan Çık'
    : '<svg class="icon"><use href="icons.svg#ico-fullscreen"/></svg> Tam Ekran';

  // Tam ekrandan çıkınca chat panelini kapat
  if (!isFs) {
    const panel = document.getElementById('fs-chat-panel');
    if (panel) panel.style.display = 'none';
    fsChatOpen = false;
  }
}

// ——— Tam Ekran İçi Sohbet ———
let fsChatOpen = false;
let fsChatUnread = 0;

const fsChatToggle = document.getElementById('fs-chat-toggle');
const fsChatPanel = document.getElementById('fs-chat-panel');
const fsChatClose = document.getElementById('fs-chat-close');
const fsChatInput = document.getElementById('fs-chat-input');
const fsChatSend = document.getElementById('fs-chat-send');
const fsChatMessages = document.getElementById('fs-chat-messages');
const fsChatBadge = document.getElementById('fs-chat-badge');

// Toggle aç/kapa
fsChatToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  fsChatOpen = !fsChatOpen;
  fsChatPanel.style.display = fsChatOpen ? 'flex' : 'none';
  if (fsChatOpen) {
    syncFsChat();
    fsChatUnread = 0;
    fsChatBadge.style.display = 'none';
    fsChatInput.focus();
  }
});

// Kapat butonu
fsChatClose.addEventListener('click', (e) => {
  e.stopPropagation();
  fsChatOpen = false;
  fsChatPanel.style.display = 'none';
});

// Panel tıklanınca kontrol overlay'ına geçmesin
fsChatPanel.addEventListener('mousedown', (e) => e.stopPropagation());
fsChatPanel.addEventListener('mousemove', (e) => e.stopPropagation());
fsChatPanel.addEventListener('click', (e) => e.stopPropagation());
fsChatPanel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: false });
fsChatPanel.addEventListener('keydown', (e) => e.stopPropagation());
fsChatPanel.addEventListener('keyup', (e) => e.stopPropagation());
fsChatToggle.addEventListener('mousedown', (e) => e.stopPropagation());
fsChatToggle.addEventListener('mousemove', (e) => e.stopPropagation());

// Ana chat'ten mesajları kopyala — senkronize et
function syncFsChat() {
  const mainMessages = document.getElementById('chat-messages');
  if (!mainMessages || !fsChatMessages) return;
  fsChatMessages.innerHTML = mainMessages.innerHTML;
  fsChatMessages.scrollTop = fsChatMessages.scrollHeight;
}

// Ana chat'e yeni mesaj geldiğinde fs-chat'i de güncelle
const _origAppend = document.getElementById('chat-messages');
if (_origAppend) {
  const observer = new MutationObserver(() => {
    if (fsChatOpen) {
      syncFsChat();
    } else if (document.fullscreenElement) {
      fsChatUnread++;
      fsChatBadge.textContent = fsChatUnread;
      fsChatBadge.style.display = 'flex';
    }
  });
  observer.observe(_origAppend, { childList: true });
}

// Mesaj gönder (fs-chat üzerinden)
function sendFsChatMessage() {
  const text = fsChatInput.value.trim();
  if (!text) return;
  // Ana chat input'a yaz ve gönder tetikle
  const mainInput = document.getElementById('chat-input');
  const mainSend = document.getElementById('chat-send');
  if (mainInput && mainSend) {
    mainInput.value = text;
    mainSend.click();
  }
  fsChatInput.value = '';
  fsChatInput.focus();
}

fsChatSend.addEventListener('click', (e) => {
  e.stopPropagation();
  sendFsChatMessage();
});

fsChatInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendFsChatMessage();
  }
});

fsChatInput.addEventListener('keyup', (e) => e.stopPropagation());

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
  btn.innerHTML = '<svg class="icon"><use href="icons.svg#ico-loader"/></svg> İstek gönderildi...';
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
  document.getElementById('control-status').innerHTML = '<svg class="icon" style="color:#36d399"><use href="icons.svg#ico-check"/></svg> Kontrol sizde';
  document.getElementById('control-status').style.display = 'inline-flex';

  const wrapper = document.getElementById('video-wrapper');
  wrapper.classList.add('control-mode');

  // Şeffaf overlay'ı aç — fare olaylarını yakalar
  document.getElementById('control-overlay').style.display = 'block';

  let badge = document.getElementById('control-mode-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'control-mode-badge';
    badge.className = 'control-mode-badge';
    badge.innerHTML = '<svg class="icon"><use href="icons.svg#ico-gamepad"/></svg> KONTROL';
    wrapper.appendChild(badge);
  }
  badge.style.display = 'block';

  setupInputCapture();
});

// Kontrol reddedildi
socket.on('control-denied', () => {
  pendingControlReq = false;
  const btn = document.getElementById('request-control-btn');
  btn.innerHTML = '<svg class="icon"><use href="icons.svg#ico-gamepad"/></svg> Kontrol İste';
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

  document.getElementById('request-control-btn').style.display = 'inline-flex';
  document.getElementById('request-control-btn').innerHTML = '<svg class="icon"><use href="icons.svg#ico-gamepad"/></svg> Kontrol İste';
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
function emitRemoteInput(data, dropIfBusy = false) {
  const channel = dropIfBusy && socket.volatile ? socket.volatile : socket;
  channel.emit('remote-input', data);
}

function handleMouseMove(e) {
  if (!controlActive) return;
  e.preventDefault();
  const now = performance.now();
  if (now - lastMoveTs < 16) return; // ~60fps throttle
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
  if (!controlActive) return;
  e.preventDefault();
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
