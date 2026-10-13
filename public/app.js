/* ============================================================
   SinkConferentions — клиентская логика главной
   ============================================================ */

const $ = (s) => document.querySelector(s);

// ---------- Сессия ----------
let currentUser = (() => {
  try { return JSON.parse(localStorage.getItem('sink_session')); }
  catch { return null; }
})();

// ---------- Обновление навбара ----------
function updateNavbar() {
  const nav = $('#navRight');
  const authBtn = $('#navAuthBtn');

  if (currentUser) {
    // Показываем аватар вместо «Войти»
    if (authBtn) authBtn.style.display = 'none';

    const chip = document.createElement('div');
    chip.className = 'user-chip';
    chip.innerHTML = `
      <div class="avatar">${currentUser.avatar || currentUser.name[0].toUpperCase()}</div>
      <span>${currentUser.name}</span>
    `;
    chip.onclick = () => location.href = 'profile.html';

    if (!nav.querySelector('.user-chip')) nav.appendChild(chip);
  }
}

updateNavbar();

// ---------- Кнопка «Создать аккаунт» ----------
$('#accountBtn').onclick = () => location.href = 'auth.html';

// ---------- Утилита: тост ----------
function toast(msg, type = 'info') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (type !== 'info' ? ' ' + type : '');
  clearTimeout(window._tt);
  window._tt = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------- Модалка имени ----------
function openNameModal(cb) {
  const modal = $('#nameModal');
  modal.classList.add('show');
  $('#displayNameInput').focus();
  modal._cb = cb;
}
function closeNameModal() {
  $('#nameModal').classList.remove('show');
}

$('#confirmNameBtn').onclick = () => {
  const name = $('#displayNameInput').value.trim() || 'Гость';
  localStorage.setItem('displayName', name);
  const cb = $('#nameModal')._cb;
  closeNameModal();
  cb && cb(name);
};

$('#displayNameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#confirmNameBtn').click();
});

// ---------- Генерация ID комнаты ----------
function generateRoomId() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ---------- Кнопка «Новая конференция» ----------
$('#createBtn').onclick = () => {
  const name = currentUser?.name || localStorage.getItem('displayName');
  if (name) {
    createRoom(name);
  } else {
    openNameModal((n) => createRoom(n));
  }
};

function createRoom(name) {
  const roomId = generateRoomId();
  sessionStorage.setItem('displayName', name);
  location.href = `/room.html?room=${roomId}`;
}

// ---------- Вход по ID / ссылке ----------
$('#joinBtn').onclick = () => {
  const raw = $('#roomInput').value.trim();
  if (!raw) return toast('Введите ID комнаты', 'error');

  let roomId = raw;
  try {
    if (raw.includes('http') || raw.includes('?room=')) {
      const url = new URL(raw, location.origin);
      roomId = url.searchParams.get('room') || raw;
    }
  } catch {}

  roomId = roomId.toUpperCase();

  const name = currentUser?.name || localStorage.getItem('displayName');
  if (name) {
    location.href = `/room.html?room=${roomId}`;
  } else {
    openNameModal((n) => {
      localStorage.setItem('displayName', n);
      location.href = `/room.html?room=${roomId}`;
    });
  }
};

$('#roomInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#joinBtn').click();
});

// ---------- Автозаполнение из ссылки ----------
const params = new URLSearchParams(location.search);
const invite = params.get('room');
if (invite) $('#roomInput').value = invite.toUpperCase();

// ---------- Экспорт утилит ----------
window.SinkApp = { toast, currentUser };