(function () {
  async function createSession(options) {
    const res = await fetch('/api/support/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options || {}),
    });
    if (!res.ok) throw new Error('Destek oturumu oluşturulamadı');
    return res.json();
  }

  async function open(options) {
    const session = await createSession(options);
    window.open(session.supportUrl, '_blank', 'noopener');
    return session;
  }

  window.RoyalSupport = {
    createSession,
    open,
  };
})();
