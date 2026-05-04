// chat.js — Yayıncı ve izleyici sayfası tarafından ortak kullanılır
// socket: Socket.IO bağlantısı, isBroadcaster: bool

function initChat(socket, isBroadcaster) {
  const messagesEl = document.getElementById('chat-messages');
  const inputEl    = document.getElementById('chat-input');
  const nameEl     = document.getElementById('chat-name');
  const sendBtn    = document.getElementById('chat-send');
  const badgeEl    = document.getElementById('chat-badge');
  const imgBtn     = document.getElementById('chat-img-btn');

  // Kaydedilmiş adı yükle
  const savedName = localStorage.getItem('chat-name');
  if (savedName) nameEl.value = savedName;
  if (isBroadcaster) {
    nameEl.value = 'Yayıncı';
    nameEl.disabled = true;
  }

  function getName() {
    return nameEl.value.trim() || 'İsimsiz';
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function buildFileContent({ type, imageData, url, fileName, mimeType, fileSize }) {
    if (type === 'image' && typeof imageData === 'string' && imageData.startsWith('data:image/')) {
      return `<div class="chat-img-wrapper"><img class="chat-img" src="${imageData}" alt="görsel" loading="lazy" /></div>`;
    }
    if (type === 'file' && url) {
      const safeUrl  = encodeURI(url);
      const safeName = escapeHtml(fileName || 'dosya');
      const safeSize = fileSize ? ' · ' + escapeHtml(formatFileSize(fileSize)) : '';
      const mime = mimeType || '';

      if (mime.startsWith('image/')) {
        return `<div class="chat-img-wrapper"><img class="chat-img" src="${safeUrl}" alt="${safeName}" loading="lazy" /></div>`;
      }
      if (mime.startsWith('video/')) {
        return `<div class="chat-video-wrapper">
          <video class="chat-video" controls preload="metadata">
            <source src="${safeUrl}" type="${escapeHtml(mime)}">
          </video>
          <div class="chat-file-meta">🎬 ${safeName}${safeSize}</div>
        </div>`;
      }
      if (mime.startsWith('audio/')) {
        return `<div class="chat-audio-wrapper">
          <audio controls preload="metadata" style="width:100%;max-width:300px">
            <source src="${safeUrl}" type="${escapeHtml(mime)}">
          </audio>
          <div class="chat-file-meta">🎵 ${safeName}${safeSize}</div>
        </div>`;
      }
      return `<div class="chat-file-card">
        <a class="chat-file-link" href="${safeUrl}" download="${safeName}" target="_blank" rel="noopener noreferrer">
          <span class="chat-file-icon">📎</span>
          <span class="chat-file-name">${safeName}</span>
          <span class="chat-file-size">${safeSize ? formatFileSize(fileSize) : ''}</span>
        </a>
      </div>`;
    }
    return `<div class="chat-text">${escapeHtml('')}</div>`;
  }

  function appendMessage(msg) {
    const { name, text, type, imageData, url, fileName, mimeType, fileSize, isBroadcaster: fromBroadcaster, ts, self } = msg;
    const item = document.createElement('div');
    item.className = 'chat-msg' + (self ? ' chat-msg-self' : '') + (fromBroadcaster ? ' chat-msg-broadcaster' : '');

    const time = new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

    let contentHtml;
    if (type === 'image' || type === 'file') {
      contentHtml = buildFileContent({ type, imageData, url, fileName, mimeType, fileSize });
    } else {
      contentHtml = `<div class="chat-text">${escapeHtml(text || '')}</div>`;
    }

    item.innerHTML =
      `<span class="chat-author">${escapeHtml(name)}${fromBroadcaster ? ' <span class="broadcaster-tag">YAYINci</span>' : ''}</span>` +
      `<span class="chat-time">${time}</span>` +
      contentHtml;

    messagesEl.appendChild(item);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Bildirim rozeti (sayfa arka plandaysa)
    if (document.hidden) {
      const count = parseInt(badgeEl.textContent || '0') + 1;
      badgeEl.textContent = count;
      badgeEl.style.display = 'inline-block';
    }
  }

  // ——— Resim büyütme (lightbox) ———
  messagesEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('chat-img')) {
      const overlay = document.createElement('div');
      overlay.className = 'chat-lightbox';
      overlay.innerHTML = `<div class="chat-lightbox-inner"><img src="${e.target.src}" /><button class="chat-lightbox-close">✕</button></div>`;
      overlay.addEventListener('click', () => overlay.remove());
      document.body.appendChild(overlay);
    }
  });

  // ——— Resim sıkıştırma (canvas ile) ———
  function compressImage(file, callback) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1280;
        let w = img.width, h = img.height;
        if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
        if (h > MAX) { w = Math.round(w * MAX / h); h = MAX; }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        callback(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ——— Resim gönder (socket üzerinden base64) ———
  function sendImage(dataUrl) {
    const name = getName();
    localStorage.setItem('chat-name', name);
    const safeName = String(name).slice(0, 30);
    const msg = { type: 'image', name: safeName, imageData: dataUrl, ts: Date.now(), isBroadcaster };
    socket.emit('chat-image', msg);
    appendMessage({ ...msg, self: true });
  }

  // ——— Dosya yükle (sunucuya POST, sonra URL gönder) ———
  function uploadAndSendFile(file) {
    const name = getName();
    localStorage.setItem('chat-name', name);
    const safeName = String(name).slice(0, 30);

    // Yükleniyor göstergesi
    const placeholder = document.createElement('div');
    placeholder.className = 'chat-msg chat-msg-self chat-uploading';
    placeholder.innerHTML = `<span class="chat-author">${escapeHtml(safeName)}</span>
      <div class="chat-upload-progress">⏫ Yükleniyor: <strong>${escapeHtml(file.name)}</strong>
        <span class="chat-upload-pct">0%</span>
      </div>`;
    messagesEl.appendChild(placeholder);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round(e.loaded / e.total * 100);
        const pctEl = placeholder.querySelector('.chat-upload-pct');
        if (pctEl) pctEl.textContent = pct + '%';
      }
    };

    xhr.onload = () => {
      placeholder.remove();
      if (xhr.status !== 200) {
        alert('Dosya yükleme başarısız: ' + xhr.statusText);
        return;
      }
      let resp;
      try { resp = JSON.parse(xhr.responseText); } catch (e) { alert('Sunucu hatası'); return; }
      const msg = {
        type: 'file',
        name: safeName,
        url: resp.url,
        fileName: resp.originalName,
        mimeType: resp.mimeType,
        fileSize: resp.size,
        ts: Date.now(),
        isBroadcaster,
      };
      socket.emit('chat-file', msg);
      appendMessage({ ...msg, self: true });
    };

    xhr.onerror = () => { placeholder.remove(); alert('Yükleme sırasında hata oluştu.'); };
    xhr.send(formData);
  }

  // ——— Dosya seçici ———
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '*/*';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  if (imgBtn) {
    imgBtn.addEventListener('click', () => fileInput.click());
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    fileInput.value = '';
    if (file.type.startsWith('image/')) {
      compressImage(file, sendImage);
    } else {
      uploadAndSendFile(file);
    }
  });

  // ——— Pano'dan yapıştırma (Ctrl+V) ———
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) compressImage(blob, sendImage);
        return;
      }
    }
  });

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    const name = getName();
    localStorage.setItem('chat-name', name);
    const safeText = String(text).slice(0, 500);
    const safeName = String(name).slice(0, 30);
    const msg = { name: safeName, text: safeText, ts: Date.now(), isBroadcaster };
    // Socket.IO ile gönder
    socket.emit('chat-message', msg);
    // Kendi mesajımızı da göster
    appendMessage({ ...msg, self: true });
    inputEl.value = '';
    inputEl.focus();
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Sayfaya odaklanınca rozeti sıfırla
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      badgeEl.textContent = '';
      badgeEl.style.display = 'none';
    }
  });

  // Gelen mesajları göster
  socket.on('chat-message', (msg) => {
    appendMessage(msg);
  });

  socket.on('chat-image', (msg) => {
    appendMessage(msg);
  });

  socket.on('chat-file', (msg) => {
    appendMessage(msg);
  });
}
