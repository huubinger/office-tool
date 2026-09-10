(() => {
  'use strict';
  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.add('hidden');
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        errorBox.textContent = data.error || 'Anmeldung fehlgeschlagen.';
        errorBox.classList.remove('hidden');
        return;
      }
      window.location.href = '/';
    } catch (err) {
      errorBox.textContent = 'Verbindung zum Server fehlgeschlagen.';
      errorBox.classList.remove('hidden');
    }
  });
})();
