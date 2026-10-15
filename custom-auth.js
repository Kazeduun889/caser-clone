/**
 * Caser Custom Authentication & User Profile System
 * Replaces Steam OpenID with local/custom gaming login & registration
 */
(function() {
  'use strict';
  // Auto-initialize demo/player session so cases and features are immediately accessible
  try {
    if (!localStorage.getItem('auth_token') || !localStorage.getItem('caser_user')) {
      const defaultUser = {
        id: 'player_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
        nickname: 'Player',
        image: DEFAULT_AVATARS[0],
        balance: 2043.31,
        tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=12345678',
        role: 'user',
        tags: []
      };
      localStorage.setItem('caser_user', JSON.stringify(defaultUser));
      localStorage.setItem('auth_token', 'token_' + defaultUser.id);
      localStorage.setItem('refresh_token', 'refresh_' + defaultUser.id);
      localStorage.setItem('cookieConsent', 'accepted');
      localStorage.setItem('user', JSON.stringify({
        state: {
          user: defaultUser,
          token: 'token_' + defaultUser.id,
          refreshToken: 'refresh_' + defaultUser.id,
          isAuthenticated: true,
          isLoading: false
        },
        version: 0
      }));
      document.cookie = 'auth_flag=1; path=/; max-age=31536000; SameSite=Lax';
      document.cookie = 'caser_user_id=' + defaultUser.id + '; path=/; max-age=31536000; SameSite=Lax';
    }
  } catch (e) {}


  const DEFAULT_AVATARS = [
    'https://avatars.steamstatic.com/6ee7f3e3312c196dbdb6bdd754a4e021abc16885_full.jpg',
    'https://avatars.steamstatic.com/b62474de115ac86b1f76c65ee7821bc3a33aebcd_full.jpg',
    'https://avatars.steamstatic.com/f4c7e12795942db02bf89508924f93f92ee40895_full.jpg',
    'https://avatars.steamstatic.com/a91903aaf5442d0b774b9a85239914555d3d1614_full.jpg',
    'https://avatars.steamstatic.com/fd5be41c9a765b8ccc16726ee7686d391031be40_full.jpg'
  ];

  let selectedAvatarIndex = 0;
  let activeTab = 'quick';

  function toBase64Url(str) {
    try {
      return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (e) {
      return str;
    }
  }

  function getStoredUser() {
    try {
      const raw = localStorage.getItem('caser_user');
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  }

  function saveAndLoginUser(user) {
    try {
      const token = 'token_' + user.id;
      const refreshToken = 'refresh_' + user.id;
      user.token = token;

      localStorage.setItem('caser_user', JSON.stringify(user));
      localStorage.setItem('auth_token', token);
      localStorage.setItem('refresh_token', refreshToken);
      
      // Zustand persist format
      const zustandState = {
        state: {
          user: user,
          token: token,
          refreshToken: refreshToken,
          isAuthenticated: true,
          isLoading: false
        },
        version: 0
      };
      localStorage.setItem('user', JSON.stringify(zustandState));

      // Cookie for SSR flag
      document.cookie = 'auth_flag=1; path=/; max-age=31536000; SameSite=Lax';
      document.cookie = 'caser_user_id=' + user.id + '; path=/; max-age=31536000; SameSite=Lax';

      // Inform server
      fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user)
      }).catch(() => {});

      // Trigger redirect with ?auth= parameter so Next.js native useAuthStore automatically hooks it!
      const targetUrl = window.location.pathname + '?auth=' + toBase64Url(token);
      window.location.href = targetUrl;
    } catch (e) {
      console.warn('Could not save user:', e);
      window.location.reload();
    }
  }

  function clearUser() {
    try {
      localStorage.removeItem('caser_user');
      localStorage.removeItem('auth_token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('user');
      document.cookie = 'auth_flag=; path=/; max-age=0';
      document.cookie = 'caser_user_id=; path=/; max-age=0';
      fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      window.location.assign('/');
    } catch (e) {
      window.location.assign('/');
    }
  }

  // Build & inject Modal DOM
  function injectAuthModal() {
    if (document.getElementById('caser-auth-modal-root')) return;

    const overlay = document.createElement('div');
    overlay.id = 'caser-auth-modal-root';
    overlay.className = 'caser-auth-overlay';
    overlay.innerHTML = `
      <div class="caser-auth-modal">
        <div class="caser-auth-header">
          <div class="caser-auth-title">
            <svg class="caser-auth-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
              <circle cx="12" cy="7" r="4"></circle>
            </svg>
            <span>Вход в аккаунт</span>
          </div>
          <button type="button" class="caser-auth-close" id="caser-auth-close-btn">&times;</button>
        </div>

        <div class="caser-auth-tabs">
          <button type="button" class="caser-auth-tab active" data-tab="quick">⚡ Быстрый вход</button>
          <button type="button" class="caser-auth-tab" data-tab="login">Вход</button>
          <button type="button" class="caser-auth-tab" data-tab="register">Регистрация</button>
        </div>

        <div class="caser-auth-body">
          <!-- QUICK TAB -->
          <div id="caser-tab-quick" class="caser-tab-content">
            <div class="caser-quick-login-banner">
              <div class="caser-quick-login-title">🎮 Гостевой доступ без Steam</div>
              <div class="caser-quick-login-desc">
                Мгновенный вход в 1 клик со стартовым балансом <strong>10 000 ₽</strong> для открытия кейсов и апгрейдов.
              </div>
            </div>
            <div style="margin-top: 16px;">
              <button type="button" class="caser-btn-primary" id="caser-quick-login-btn">
                <span>⚡ Войти как Игрок (10 000 ₽)</span>
              </button>
            </div>
          </div>

          <!-- LOGIN TAB -->
          <div id="caser-tab-login" class="caser-tab-content" style="display: none;">
            <div class="caser-auth-form-group">
              <label class="caser-auth-label">Логин / Никнейм</label>
              <input type="text" id="caser-login-username" class="caser-auth-input" placeholder="Например: DragonSlayer" value="DragonSlayer" />
            </div>
            <div class="caser-auth-form-group" style="margin-top: 12px;">
              <label class="caser-auth-label">Пароль</label>
              <input type="password" id="caser-login-password" class="caser-auth-input" placeholder="Любой пароль" value="123456" />
            </div>
            <div style="margin-top: 18px;">
              <button type="button" class="caser-btn-primary" id="caser-do-login-btn">
                <span>Войти</span>
              </button>
            </div>
          </div>

          <!-- REGISTER TAB -->
          <div id="caser-tab-register" class="caser-tab-content" style="display: none;">
            <div class="caser-auth-form-group">
              <label class="caser-auth-label">Придумайте никнейм</label>
              <input type="text" id="caser-reg-username" class="caser-auth-input" placeholder="Ваш игровой ник" />
            </div>
            <div class="caser-auth-form-group" style="margin-top: 10px;">
              <label class="caser-auth-label">Выберите аватар</label>
              <div class="caser-auth-avatars" id="caser-avatar-picker"></div>
            </div>
            <div class="caser-auth-form-group" style="margin-top: 10px;">
              <label class="caser-auth-label">Стартовый баланс (₽)</label>
              <input type="number" id="caser-reg-balance" class="caser-auth-input" value="10000" min="1000" max="100000" />
            </div>
            <div style="margin-top: 18px;">
              <button type="button" class="caser-btn-primary" id="caser-do-register-btn">
                <span>Создать аккаунт</span>
              </button>
            </div>
          </div>

          <div class="caser-auth-footer-text">
            Авторизация заменяет Steam OpenID для локального режима и тестирования полного функционала.
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Render avatar choices
    const picker = overlay.querySelector('#caser-avatar-picker');
    DEFAULT_AVATARS.forEach((url, idx) => {
      const opt = document.createElement('div');
      opt.className = 'caser-avatar-option' + (idx === 0 ? ' selected' : '');
      opt.innerHTML = `<img src="${url}" alt="Avatar ${idx + 1}" />`;
      opt.onclick = () => {
        selectedAvatarIndex = idx;
        picker.querySelectorAll('.caser-avatar-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
      };
      picker.appendChild(opt);
    });

    // Close logic
    const closeBtn = overlay.querySelector('#caser-auth-close-btn');
    closeBtn.onclick = hideAuthModal;
    overlay.onclick = (e) => {
      if (e.target === overlay) hideAuthModal();
    };

    // Tab switching
    const tabBtns = overlay.querySelectorAll('.caser-auth-tab');
    tabBtns.forEach(btn => {
      btn.onclick = () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTab = btn.getAttribute('data-tab');

        overlay.querySelectorAll('.caser-tab-content').forEach(c => c.style.display = 'none');
        overlay.querySelector('#caser-tab-' + activeTab).style.display = 'block';
      };
    });

    // Quick login button
    overlay.querySelector('#caser-quick-login-btn').onclick = () => {
      const user = {
        id: 'user_' + Math.floor(100000 + Math.random() * 900000),
        nickname: 'Player_' + Math.floor(1000 + Math.random() * 9000),
        image: DEFAULT_AVATARS[Math.floor(Math.random() * DEFAULT_AVATARS.length)],
        balance: 10000.00,
        tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=12345678',
        role: 'user',
        tags: []
      };
      saveAndLoginUser(user);
    };

    // Form login
    overlay.querySelector('#caser-do-login-btn').onclick = () => {
      const nick = (overlay.querySelector('#caser-login-username').value || '').trim() || 'DragonSlayer';
      const user = {
        id: 'user_' + Math.abs(hashString(nick)),
        nickname: nick,
        image: DEFAULT_AVATARS[0],
        balance: 15000.00,
        tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=12345678',
        role: 'user',
        tags: []
      };
      saveAndLoginUser(user);
    };

    // Form register
    overlay.querySelector('#caser-do-register-btn').onclick = () => {
      const nick = (overlay.querySelector('#caser-reg-username').value || '').trim() || ('ProGamer_' + Math.floor(Math.random() * 1000));
      const balance = parseFloat(overlay.querySelector('#caser-reg-balance').value) || 10000;
      const user = {
        id: 'user_' + Date.now().toString(36),
        nickname: nick,
        image: DEFAULT_AVATARS[selectedAvatarIndex],
        balance: balance,
        tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=12345678',
        role: 'user',
        tags: []
      };
      saveAndLoginUser(user);
    };
  }

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  function showAuthModal() {
    injectAuthModal();
    const modal = document.getElementById('caser-auth-modal-root');
    if (modal) {
      modal.classList.add('active');
    }
  }

  function hideAuthModal() {
    const modal = document.getElementById('caser-auth-modal-root');
    if (modal) {
      modal.classList.remove('active');
    }
  }

  // Intercept the global auth modal event
  window.addEventListener('caser:open-auth-modal', function(e) {
    e.preventDefault();
    e.stopPropagation();
    showAuthModal();
  });

  // Topup balance prompt
  function promptTopUp() {
    const user = getStoredUser();
    if (!user) {
      showAuthModal();
      return;
    }
    const addStr = prompt('Введите сумму пополнения (₽):', '5000');
    if (!addStr) return;
    const add = parseFloat(addStr);
    if (isNaN(add) || add <= 0) return;

    user.balance = (parseFloat(user.balance) || 0) + add;
    localStorage.setItem('caser_user', JSON.stringify(user));

    // Notify the server; the balance arrives back over the WebSocket,
    // so there is no need to reload the page.
    fetch('/api/users/balance/topup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: add })
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.balance === 'number') {
          user.balance = data.balance;
          localStorage.setItem('caser_user', JSON.stringify(user));
        }
        updateHeaderUI();
      })
      .catch(() => {});
  }

  // Update Header UI based on login status
  function updateHeaderUI() {
    const user = getStoredUser();

    // Find desktop & mobile login buttons
    const loginBtns = document.querySelectorAll(
      '[data-testid="header-login-button-desktop"], [data-testid="header-login-button-mobile"], button:has(img[src*="steamIcon"])'
    );

    if (user) {
      // User is logged in! Replace "ВОЙТИ" button with User Pill
      loginBtns.forEach(btn => {
        const parent = btn.parentElement;
        if (!parent || parent.querySelector('.caser-user-pill-container')) return;

        btn.style.display = 'none';

        const pill = document.createElement('div');
        pill.className = 'caser-user-pill-container';
        pill.innerHTML = `
          <div class="caser-user-balance-badge" title="Ваш баланс">
            <span class="caser-user-balance-value">${parseFloat(user.balance).toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽</span>
          </div>
          <button type="button" class="caser-user-topup-btn" title="Пополнить баланс">+</button>
          <button type="button" class="caser-user-avatar-btn" title="${user.nickname}">
            <img src="${user.image || DEFAULT_AVATARS[0]}" alt="${user.nickname}" />
          </button>
          <div class="caser-user-dropdown">
            <div class="caser-dropdown-header">
              <div class="caser-dropdown-name">${user.nickname}</div>
              <div class="caser-dropdown-sub">ID: ${user.id}</div>
            </div>
            <a href="/ru/inventory" class="caser-dropdown-item">🎒 Мой инвентарь</a>
            <button type="button" class="caser-dropdown-item caser-topup-menu-btn">💳 Пополнить (+5 000 ₽)</button>
            <button type="button" class="caser-dropdown-item caser-bonus-menu-btn">🎁 Ежедневный бонус (+1 000 ₽)</button>
            <button type="button" class="caser-dropdown-item danger caser-logout-btn">🚪 Выйти из аккаунта</button>
          </div>
        `;

        // Dropdown toggle
        const avatarBtn = pill.querySelector('.caser-user-avatar-btn');
        const dropdown = pill.querySelector('.caser-user-dropdown');
        avatarBtn.onclick = (e) => {
          e.stopPropagation();
          dropdown.classList.toggle('show');
        };

        // Topup button
        pill.querySelector('.caser-user-topup-btn').onclick = promptTopUp;
        pill.querySelector('.caser-topup-menu-btn').onclick = promptTopUp;

        // Daily bonus
        pill.querySelector('.caser-bonus-menu-btn').onclick = () => {
          user.balance = (parseFloat(user.balance) || 0) + 1000;
          localStorage.setItem('caser_user', JSON.stringify(user));
          fetch('/api/users/balance/topup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 1000 })
          }).catch(() => {});
          updateHeaderUI();
        };

        // Logout
        pill.querySelector('.caser-logout-btn').onclick = () => {
          if (confirm('Вы уверены, что хотите выйти?')) {
            clearUser();
          }
        };

        parent.appendChild(pill);
      });

      // Close dropdown on click outside
      document.addEventListener('click', () => {
        document.querySelectorAll('.caser-user-dropdown').forEach(d => d.classList.remove('show'));
      });

    } else {
      // User is NOT logged in: remove any user pills & attach modal trigger to login buttons
      document.querySelectorAll('.caser-user-pill-container').forEach(el => el.remove());

      loginBtns.forEach(btn => {
        btn.style.display = '';
        
        // Change text/icon if needed to not say Steam
        const span = btn.querySelector('span');
        if (span && span.textContent.toLowerCase().includes('steam')) {
          span.textContent = 'ВОЙТИ';
        }
        
        // Remove Steam icon and replace with user icon if present
        const steamImg = btn.querySelector('img[src*="steamIcon"]');
        if (steamImg) {
          steamImg.src = '/cdn/fa/icons/upgrade/inventary.svg';
          steamImg.alt = 'Вход';
        }

        // Attach modal trigger
        if (!btn.__hasCaserAuthClick) {
          btn.__hasCaserAuthClick = true;
          btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            showAuthModal();
          }, true);
        }
      });
    }
  }

  // Observe DOM changes (Next.js client-side navigations)
  function setupObserver() {
    const observer = new MutationObserver(() => {
      updateHeaderUI();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Keeps the custom balance pill in sync with the server.
  // The server pushes `users.update_balance` after every balance change
  // (case open, sale, upgrade, top-up), so no reload is ever needed.
  function setupBalanceSync() {
    let socket = null;
    let retry = 0;

    const apply = (value) => {
      const amount = typeof value === 'number' ? value : parseFloat(value);
      if (!Number.isFinite(amount)) return;
      const user = getStoredUser();
      if (!user) return;
      user.balance = Number(amount.toFixed(2));
      localStorage.setItem('caser_user', JSON.stringify(user));
      document.querySelectorAll('.caser-user-balance-value').forEach((el) => {
        el.textContent = user.balance.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' ₽';
      });
    };

    const connect = () => {
      try {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(proto + '//' + location.host + '/api/ws');
        socket.onopen = () => { retry = 0; };
        socket.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (!msg || !msg.event) return;
            if (msg.event === 'users.update_balance') apply(msg.data);
          } catch (e) { /* ignore malformed frames */ }
        };
        socket.onclose = () => {
          retry = Math.min(retry + 1, 6);
          setTimeout(connect, 1000 * retry);
        };
        socket.onerror = () => { try { socket.close(); } catch (e) {} };
      } catch (e) { /* no websocket available */ }
    };

    connect();
  }

  // Init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      injectAuthModal();
      updateHeaderUI();
      setupObserver();
      setupBalanceSync();
    });
  } else {
    injectAuthModal();
    updateHeaderUI();
    setupObserver();
    setupBalanceSync();
  }

  // Export helper for debugging
  window.caserAuth = {
    show: showAuthModal,
    hide: hideAuthModal,
    getUser: getStoredUser,
    loginAsDemo: () => {
      const user = {
        id: 'user_10001',
        nickname: 'CaserPro',
        image: DEFAULT_AVATARS[0],
        balance: 10000.00,
        tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=12345678',
        role: 'user',
        tags: []
      };
      saveAndLoginUser(user);
    },
    logout: () => {
      clearUser();
    }
  };
})();
