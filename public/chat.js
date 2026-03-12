// chat.js — Yayıncı ve izleyici sayfası tarafından ortak kullanılır
// socket ve isBroadcaster değişkeninin dışarıda tanımlı olması gerekir

function initChat(socket, isBroadcaster) {
  const messagesEl = document.getElementById('chat-messages');
  const inputEl    = document.getElementById('chat-input');
  const nameEl     = document.getElementById('chat-name');
  const sendBtn    = document.getElementById('chat-send');
  const badgeEl    = document.getElementById('chat-badge');

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

  function appendMessage({ name, text, isBroadcaster: fromBroadcaster, ts, self }) {
    const item = document.createElement('div');
    item.className = 'chat-msg' + (self ? ' chat-msg-self' : '') + (fromBroadcaster ? ' chat-msg-broadcaster' : '');

    const time = new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    item.innerHTML =
      `<span class="chat-author">${escapeHtml(name)}${fromBroadcaster ? ' <span class="broadcaster-tag">YAYINci</span>' : ''}</span>` +
      `<span class="chat-time">${time}</span>` +
      `<div class="chat-text">${escapeHtml(text)}</div>`;

    messagesEl.appendChild(item);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Bildirim rozeti (sayfa arka plandaysa)
    if (document.hidden) {
      const count = parseInt(badgeEl.textContent || '0') + 1;
      badgeEl.textContent = count;
      badgeEl.style.display = 'inline-block';
    }
  }

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    const name = getName();
    localStorage.setItem('chat-name', name);
    socket.emit('chat-message', { text, name });
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
}
