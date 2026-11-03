const form = document.getElementById('login');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: form.password.value }) });
  if (r.ok) location.href = '/';
  else err.textContent = (await r.json().catch(() => ({}))).error || 'Sign in failed';
});
