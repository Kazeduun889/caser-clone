/**
 * Caser Custom Authentication & User Profile System
 * Replaces Steam OpenID with local/custom gaming login & registration
 */
(function() {
  'use strict';

  /**
   * Keeps the session consistent across everything the app reads.
   *
   * There are two stores: `caser_user` (ours) and `user` (the app's zustand
   * persist key). They were written at different moments and could disagree -
   * one holding an old id while the other held the current one. The app then
   * rendered against a user id the server knew nothing about, so the profile
   * cards never requested their stats.
   *
   * The cookie wins, because that is what the server actually reads. Both keys
   * are rewritten from it, so the app and the API always agree.
   */
  function reconcileSession() {
    try {
      const cookie = document.cookie.match(/(?:^|;\s*)caser_user_id=([^;]+)/);
      const cookieId = cookie ? decodeURIComponent(cookie[1]) : null;

      let ours = null;
      try { ours = JSON.parse(localStorage.getItem('caser_user') || 'null'); } catch (e) { ours = null; }

      let theirs = null;
      try { theirs = JSON.parse(localStorage.getItem('user') || 'null'); } catch (e) { theirs = null; }

      const id = cookieId || (ours && ours.id) || (theirs && theirs.state && theirs.state.user && theirs.state.user.id);
      if (!id) return null;

      const base = (theirs && theirs.state && theirs.state.user) || (ours && ours.id === id ? ours : null) || {
        id: id, nickname: 'CaserPlayer', image: null, role: 'user'
      };
      const user = Object.assign({}, base, { id: id, balance: (ours && ours.id === id) ? ours.balance : base.balance });
      if (ours && ours.isCreator !== undefined) user.isCreator = ours.isCreator;

      localStorage.setItem('caser_user', JSON.stringify(user));
      localStorage.setItem('auth_token', 'token_' + id);
      localStorage.setItem('refresh_token', 'refresh_' + id);
      localStorage.setItem('user', JSON.stringify({
        state: {
          user: user,
          token: 'token_' + id,
          refreshToken: 'refresh_' + id,
          isAuthenticated: true,
          isLoading: false
        },
        version: 0
      }));
      document.cookie = 'auth_flag=1; path=/; max-age=31536000';
      return user;
    } catch (e) {
      return null;
    }
  }

  reconcileSession();

  /**
   * Sends the player's own id on every API request.
   *
   * The server resolves the account from the caser_user_id cookie. A browser
   * that refuses to keep cookies - private mode, a strict privacy setting - is
   * then minted a brand new account on every reload, and the player watches
   * their balance and inventory reset. The id is already in localStorage, so it
   * travels as a Bearer token, which resolveUser accepts as a second candidate.
   */
  (function attachIdentityHeader() {
    var token = null;
    function read() {
      try { token = localStorage.getItem('auth_token'); } catch (e) { token = null; }
      return token;
    }
    read();

    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (!/^\/api\//.test(url)) return origFetch.apply(this, arguments);
        init = init || {};
        var t = token || read();
        if (!t) return origFetch.call(this, input, init);
        if (init.headers && typeof init.headers.append === 'function') {
          init.headers.append('Authorization', 'Bearer ' + t);
        } else if (init.headers && typeof init.headers === 'object') {
          init.headers.Authorization = 'Bearer ' + t;
        } else {
          init.headers = { Authorization: 'Bearer ' + t };
        }
        return origFetch.call(this, input, init);
      };
    }

    var XHR = window.XMLHttpRequest;
    if (XHR) {
      var open = XHR.prototype.open;
      var setHeader = XHR.prototype.setRequestHeader;
      var send = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this.__caserApi = /^\/api\//.test(String(url));
        this.__caserAuth = false;
        return open.apply(this, arguments);
      };
      XHR.prototype.setRequestHeader = function (name, value) {
        if (this.__caserApi && /^authorization$/i.test(name)) this.__caserAuth = true;
        return setHeader.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        if (this.__caserApi && !this.__caserAuth) {
          var t = token || read();
          if (t) { try { setHeader.call(this, 'Authorization', 'Bearer ' + t); } catch (e) {} }
        }
        return send.apply(this, arguments);
      };
    }
  })();

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
            ${user.isCreator ? '<span class="caser-creator-tick" title="Автор"><svg viewBox="0 0 24 24" fill="none" stroke="#0a1a12" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' : ''}
          </button>
          <div class="caser-user-dropdown">
            <div class="caser-dropdown-header">
              <div class="caser-dropdown-name">${user.nickname}${user.isCreator ? ' <span class="caser-creator-tag">✓ Автор</span>' : ''}</div>
              <div class="caser-dropdown-sub">ID: ${user.id}</div>
            </div>
            <a href="/profile" class="caser-dropdown-item">👤 Профиль и промокод</a>
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
      // React owns the page subtree and discards nodes it did not render on
      // every re-render, so the strip has to be re-attached when it goes.
      ensureProfileStrip();
      ensureInventoryTabs();
      ensureSellAllPlacement();
      ensureGiveawayBanner();
      setupRewardsPage();
      ensureFooterContacts();
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

    /**
     * Applies a creator-tick change live. When the operator grants or revokes
     * the badge the header updates in place, so the page never needs a reload.
     */
    const applyCreator = (data) => {
      const on = !!(data && data.isCreator);
      const user = getStoredUser();
      if (user) {
        user.isCreator = on;
        localStorage.setItem('caser_user', JSON.stringify(user));
      }

      document.querySelectorAll('.caser-user-avatar-btn').forEach((btn) => {
        let tick = btn.querySelector('.caser-creator-tick');
        if (on && !tick) {
          tick = document.createElement('span');
          tick.className = 'caser-creator-tick';
          tick.title = 'Автор';
          tick.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#0a1a12" ' +
            'stroke-width="4" stroke-linecap="round" stroke-linejoin="round">' +
            '<polyline points="20 6 9 17 4 12"></polyline></svg>';
          btn.appendChild(tick);
        } else if (!on && tick) {
          tick.remove();
        }
      });

      document.querySelectorAll('.caser-dropdown-name').forEach((el) => {
        const tag = el.querySelector('.caser-creator-tag');
        if (on && !tag) {
          const span = document.createElement('span');
          span.className = 'caser-creator-tag';
          span.textContent = '✓ Автор';
          el.appendChild(span);
        } else if (!on && tag) {
          tag.remove();
        }
      });
    };

    // Pick up a tick that was granted in another tab or before this page load.
    (function refreshCreatorFlag() {
      fetch('/api/users/me', { headers: { 'X-Requested-With': 'fetch' } })
        .then((r) => (r.ok ? r.json() : null))
        .then((me) => {
          if (me && me.id) {
            const user = getStoredUser();
            if (user) {
              user.isCreator = !!me.isCreator;
              localStorage.setItem('caser_user', JSON.stringify(user));
            }
            applyCreator({ isCreator: !!me.isCreator });
          }
        })
        .catch(() => { /* offline - keep whatever is cached */ });
    })();

    const connect = () => {
      try {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(proto + '//' + location.host + '/api/ws');
        socket.onopen = () => { retry = 0; };
        socket.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (!msg || !msg.event) return;
            if (msg.event === 'users.update_balance') {
              apply(msg.data);
              var stripBal = document.querySelector('.caser-profile-strip [data-f="balance"]');
              if (stripBal) {
                var v = typeof msg.data === 'number' ? msg.data : parseFloat(msg.data);
                if (isFinite(v)) stripBal.textContent = v.toLocaleString('ru-RU', { minimumFractionDigits: 2 });
              }
            }
            if (msg.event === 'users.update_creator') applyCreator(msg.data);
            // Balance moves on a case open, a sale or a win: refresh the tiles.
            if (msg.event === 'inventory.new_items' || msg.event === 'inventory.item_status_changed') {
              var strip = document.querySelector('.caser-profile-strip');
              if (strip && strip.dataset.ready) observeStrip(strip);
            }
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

  /**
   * Profile cards: avatar, best drop, withdrawn, CS rating and the promo field.
   *
   * These belong to the original's authenticated profile screen, which is not
   * present in this build - useUserStatsQuery is defined but never rendered,
   * and there is no /profile route in the static export. So this is the one
   * block on the page that has no upstream markup to copy, and it is built from
   * the site's own design language: the custom shades (black-250, black-450,
   * white-150), the 0.2rem radius, Oswald for numerals, and --brand-accent /
   * --brand-nav-active straight from the site stylesheets.
   */
  // Route helpers.
  //
  // /profile and /inventory are served from the same markup, so the two have to
  // be told apart: the profile gets the stats strip and the tabs, while the
  // inventory stays the plain item grid it is on the original site.
  function isProfileRoute() { return /\/profile/.test(location.pathname); }
  function isInventoryRoute() { return /\/inventory/.test(location.pathname); }

  function setupProfileCards() {
    ensureProfileStrip();
  }

  /** Creates the strip once, and puts it back if React removed it. */
  function ensureProfileStrip() {
    if (!isProfileRoute()) {
      // SPA navigation keeps the old document around: the strip has to be
      // taken off the inventory, or the inventory inherits the profile look.
      var stale = document.querySelector('.caser-profile-strip');
      if (stale) stale.remove();
      return;
    }
    if (document.querySelector('.caser-profile-strip')) return;

    var strip = document.createElement('div');
    strip.className = 'caser-profile-strip';
    // Colours come from the site's own utility classes, which are present in
    // the shipped stylesheet and resolve through the runtime theme tokens:
    //   bg-black-250 / border-white-150  -> tile surface and hairline
    //   text-white-450                  -> the muted captions
    //   bg-brand-button-primary + text-brand-button-primary-text
    //     + border-brand-button-primary-border
    //     + shadow-[var(--brand-button-primary-shadow)]  -> the green button
    // Hard-coding hex here is what made the top-up button look like a different
    // shade of green: the site paints it with a flat #13432C, not a gradient.
    strip.innerHTML = [
      // --- player -------------------------------------------------------
      '<div class="caser-card caser-card-player bg-black-250 border-[0.1rem] border-solid border-white-150 rounded-[0.2rem]">',
      '  <div class="caser-player-top">',
      '    <div class="caser-avatar"><img alt=""><span class="caser-tick" hidden>',
      '      <svg viewBox="0 0 24 24" fill="none" stroke="#0a1a12" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
      '    </span></div>',
      '    <div class="caser-ident">',
      '      <div class="caser-nick"><span data-f="nick">—</span>',
      '        <span class="caser-author" hidden>Автор</span>',
      '        <button class="caser-icon-btn caser-pencil" data-act="rename" title="Сменить никнейм">',
      '          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>',
      '        </button>',
      '      </div>',
      '      <div class="caser-uid text-white-450">ID:<span data-f="uid">—</span></div>',
      '    </div>',
      '    <div class="caser-player-actions">',
      '      <button class="caser-icon-btn" data-act="settings" title="Настройки">',
      ico(GEAR, 'caser-btn-ico') + '</button>',
      '      <button class="caser-icon-btn" data-act="logout" title="Выйти">',
      ico(EXIT, 'caser-btn-ico') + '</button>',
      '    </div>',
      '  </div>',
      // The lower half sits on its own darker plate, split by a hairline.
      '  <div class="caser-plate">',
      '    <div class="caser-player-bal">',
      '      <div><span class="caser-lbl caser-lbl-sm">История баланса</span>',
      '        <span class="caser-bal"><span data-f="balance">0.00</span>' + ico(COIN, 'caser-coin') + '</span>',
      '      </div>',
      '      <button class="caser-btn-primary" data-act="topup">ПОПОЛНИТЬ' + ico(PLUS_GREEN, 'caser-btn-ico') + '</button>',
      '    </div>',
      '    <div class="caser-counters">',
      '      <span>' + ico(ICO_CASE, 'caser-ctr-ico') + '<b data-f="cases">0</b></span>',
      '      <span>' + ico(ICO_UPGRADE, 'caser-ctr-ico') + '<b data-f="upgrades">0</b></span>',
      '      <span>' + ico(ICO_MYSTERY, 'caser-ctr-ico') + '<b data-f="won">0</b></span>',
      '    </div>',
      '  </div>',
      '</div>',

      // --- best drop ---------------------------------------------------
      '<div class="caser-card caser-card-best bg-black-250 border-[0.1rem] border-solid border-white-150 rounded-[0.2rem]">',
      '  <div class="caser-lbl">Лучший дроп</div>',
      '  <div class="caser-best-body">',
      '    <div class="caser-best-meta">',
      '      <div class="caser-lbl">ИМЯ:</div>',
      '      <div class="caser-best-name" data-f="bestName">—</div>',
      '      <div class="caser-best-price"><span data-f="bestPrice">0.00</span>' + ico(COIN, 'caser-coin') + '</div>',
      '    </div>',
      '    <div class="caser-best-img"><img alt="" data-f="bestImage" hidden></div>',
      '  </div>',
      '</div>',

      // --- withdrawn ---------------------------------------------------
      '<div class="caser-card caser-card-wd bg-black-250 border-[0.1rem] border-solid border-white-150 rounded-[0.2rem]">',
      '  <img class="caser-watermark" src="' + STEAM_WATERMARK + '" alt="">',
      '  <div class="caser-lbl">Выведено</div>',
      '  <div class="caser-wd"><span data-f="withdrawn">0.00</span>' + ico(COIN, 'caser-coin') + '</div>',
      '  <div class="caser-wd-sub text-white-650"><span data-f="wdCount">0</span> предмета</div>',
      // separated from the figure above by its own hairline
      '  <div class="caser-promo-block">',
      '    <form class="caser-promo-form" autocomplete="off">',
      '      <input type="text" name="promo" placeholder="Персональный купон" spellcheck="false">',
      // deliberately neutral: the apply button is not a primary green action
      '      <button type="submit" class="caser-btn-ghost">ПРИМЕНИТЬ</button>',
      '    </form>',
      '    <div class="caser-promo-msg"></div>',
      '  </div>',
      '</div>'
    ].join('');

    // Put it at the top of the main column, directly above the inventory page.
    //
    // The old anchor was the "Продать все" button, falling back to
    // [data-testid="live-drop-list"] when the toolbar had not rendered yet.
    // That fallback is the narrow left rail, so on a narrow window the whole
    // strip was inserted into the sidebar and rendered squeezed at 28rem -
    // which is what clicking a player in the drop feed showed.
    var page = document.querySelector('[data-testid="inventory-page"]');
    var host = page && page.parentElement;
    if (host && host.parentNode) host.insertBefore(strip, page);
    else {
      var root = document.querySelector('div.animate-page-in') || document.body;
      root.insertBefore(strip, root.firstChild);
    }

    strip.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var what = act.dataset.act;
      if (what === 'promo') openPromoModal();
      else if (what === 'rename') openNicknameEditor(strip);
      else if (what === 'topup') openPromoModal();
      else if (what === 'settings') openSettings(strip);
      else if (what === 'logout') logout();
    });

    // Live nickname edits from the server's own broadcast.
    listenForProfileUpdates(strip);

    // Inline promo field. Uses the same endpoint as the modal so both paths
    // share one code path and one set of validation messages.
    var form = strip.querySelector('.caser-promo-form');
    var msg = strip.querySelector('.caser-promo-msg');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var code = form.promo.value.trim();
        if (!code) {
          msg.textContent = 'Введите промокод';
          msg.className = 'caser-promo-msg err';
          return;
        }
        msg.textContent = 'Проверяем...';
        msg.className = 'caser-promo-msg';
        redeemPromo(code).then(function (amount) {
          msg.textContent = 'Код активирован: +' + fmtMoney(amount);
          msg.className = 'caser-promo-msg ok';
          form.promo.value = '';
          var live = document.querySelector('.caser-profile-strip');
          if (live) observeStrip(live);
        }).catch(function (err) {
          msg.textContent = err.message;
          msg.className = 'caser-promo-msg err';
        });
      });
    }

    if (profileCache) applyProfile(strip, profileCache);
    observeStrip(strip);
  }

  function fmtMoney(v) {
    return Number(v || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2 });
  }

  /** Whole-number formatting with thin thousands separators, as the rating tile shows. */
  function fmtCount(v) {
    return Math.round(Number(v) || 0).toLocaleString('ru-RU');
  }

  /**
   * The settings sheet: gear glyph beside the title, close on the right, then
   * the account's own fields. Laid out as in the reference screenshot.
   */
  function openSettings(strip) {
    var existing = document.querySelector('.caser-sheet');
    if (existing) { existing.classList.add('open'); return; }

    var wrap = document.createElement('div');
    wrap.className = 'caser-sheet';
    wrap.innerHTML =
      '<div class="caser-sheet-panel">'
      + '<div class="caser-sheet-head">'
      + '<span class="caser-sheet-title">'
      + '<img class="caser-btn-ico" src="' + GEAR + '" alt="">'
      + '<span>НАСТРОЙКИ</span></span>'
      + '<button class="caser-icon-btn" data-c="cancel" aria-label="Закрыть">'
      + '<img class="caser-btn-ico" src="' + CLOSE_ICO + '" alt=""></button>'
      + '</div>'
      + '<label class="caser-field"><span>Никнейм</span>'
      + '<input type="text" data-f="s-nick" maxlength="24" spellcheck="false"></label>'
      + '<label class="caser-field"><span>Трейд-ссылка</span>'
      + '<input type="text" data-f="s-link" spellcheck="false"></label>'
      + '<div class="caser-promo-msg"></div>'
      + '<div class="caser-promo-row">'
      + '<button class="caser-btn-primary" data-c="cancel">Закрыть</button></div>'
      + '</div>';
    document.body.appendChild(wrap);

    wrap.querySelector('[data-f="s-nick"]').value = (strip.querySelector('[data-f="nick"]') || {}).textContent || '';
    wrap.querySelector('[data-f="s-link"]').value = (strip.querySelector('[data-f="trade"]') || {}).textContent || '';

    wrap.addEventListener('click', function (e) {
      if (e.target === wrap || e.target.closest('[data-c="cancel"]')) wrap.classList.remove('open');
    });
    wrap.addEventListener('submit', function (e) { e.preventDefault(); });
  }

  /**
   * Nickname editor, opened from the pencil.
   *
   * Inline rather than a modal so the card does not jump, and optimistic so the
   * name lands the moment the server accepts it. Validation lives on the server
   * (PASSWORD-free NICKNAME_RE); this only stops an obviously empty submit.
   */
  function openNicknameEditor(strip) {
    var existing = document.querySelector('.caser-nick-input');
    if (existing) { existing.focus(); existing.select(); return; }

    var holder = strip.querySelector('.caser-ident');
    var nickEl = strip.querySelector('[data-f="nick"]');
    if (!holder || !nickEl) return;

    var form = document.createElement('form');
    form.className = 'caser-nick-form';
    form.innerHTML =
      '<input class="caser-nick-input" maxlength="24" spellcheck="false" autocomplete="off">' +
      '<div class="caser-nick-hint"></div>';
    form.querySelector('input').value = nickEl.textContent === '—' ? '' : nickEl.textContent;

    var hint = form.querySelector('.caser-nick-hint');
    var input = form.querySelector('input');
    var done = false;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      commit();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    input.addEventListener('blur', function () {
      // Let a click on the confirm button land before the editor tears down.
      setTimeout(function () { if (!done) close(); }, 160);
    });

    function close() {
      done = true;
      if (form.parentNode) form.parentNode.removeChild(form);
      nickEl.style.display = '';
      var btn = strip.querySelector('[data-act="rename"]');
      if (btn) btn.style.display = '';
    }

    function commit() {
      var value = input.value.trim();
      if (value.length < 2) { fail('Минимум 2 символа'); return; }
      hint.className = 'caser-nick-hint';
      hint.textContent = 'Сохраняем...';
      fetch('/api/users/me/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: value })
      }).then(function (r) {
        return r.json().then(function (b) {
          if (!r.ok || !b.success) throw new Error((b && b.message) || 'Не удалось сохранить');
          return b.data;
        });
      }).then(function (profile) {
        applyNickname(profile.nickname);
        close();
      }).catch(function (err) { fail(err.message); });
    }

    function fail(msg) {
      hint.className = 'caser-nick-hint err';
      hint.textContent = msg;
    }

    nickEl.style.display = 'none';
    var pencil = strip.querySelector('[data-act="rename"]');
    if (pencil) pencil.style.display = 'none';
    nickEl.parentNode.insertBefore(form, nickEl);
    input.focus();
    input.select();
  }

  /** Writes the nickname everywhere it is already rendered, plus the cache. */
  function applyNickname(name) {
    if (!name) return;
    if (profileCache) profileCache.user.nickname = name;

    document.querySelectorAll('.caser-profile-strip [data-f="nick"]').forEach(function (el) {
      el.textContent = name;
    });
    document.querySelectorAll('.caser-nick-editor-text').forEach(function (el) {
      el.textContent = name;
    });

    // Keep the stored session in step, otherwise the next reconcileSession()
    // would push the old name back over the new one.
    try {
      var user = getStoredUser();
      if (user) {
        user.nickname = name;
        localStorage.setItem('caser_user', JSON.stringify(user));
      }
    } catch (e) { /* storage disabled */ }
  }

  /** Subscribes to the server's profile broadcast for this account. */
  function listenForProfileUpdates(strip) {
    if (strip.dataset.listening) return;
    strip.dataset.listening = '1';
    // Reuse the page-wide socket if one is already open.
    if (window.__caserWs && window.__caserWs.readyState === 1) {
      hookWsProfile(window.__caserWs);
    }
  }

  var hookedSockets = [];
  function hookWsProfile(ws) {
    if (hookedSockets.indexOf(ws) !== -1) return;
    hookedSockets.push(ws);
    ws.addEventListener('message', function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || msg.event !== 'users.update_profile') return;
      applyNickname(msg.data && msg.data.nickname);
    });
  }

  function logout() {
    fetch('/api/auth/logout', { method: 'POST' }).catch(function () { });
    if (window.caserAuth && window.caserAuth.hide) window.caserAuth.hide();
  }

  /** Shared by the inline field and the modal. Throws with the server message. */
  function redeemPromo(code) {
    return fetch('/api/promo/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    }).then(function (r) {
      return r.json().then(function (b) {
        if (!r.ok || !b.success) throw new Error((b && b.message) || 'Не удалось активировать код');
        return b.data.amount;
      });
    });
  }

  /** Last payload, so a strip React re-created is filled without refetching. */
  var profileCache = null;

  // The site's own artwork, served from the same CDN path it uses. Nothing here
  // is drawn by hand: coin, gear, exit, case, upgrade, bolt, the plus inside the
  // top-up button and the balance watermark all ship with the original.
  var A = '/cdn/fa';
  var COIN = A + '/icons/general/coin.svg';
  var GEAR = A + '/icons/general/settingIcon.svg';
  var EXIT = A + '/icons/general/exitIcon.svg';
  var PLUS_GREEN = A + '/icons/general/plusGreenIcon.svg';
  var ICO_CASE = A + '/icons/general/caseIcon.svg';
  var ICO_UPGRADE = A + '/icons/upgrade/upgrade.svg';
  var ICO_MYSTERY = A + '/icons/upgrade/mysteryMode.webp';
  var WD_WATERMARK = A + '/icons/upgrade/balance-card-watermark.svg';
  var STEAM_WATERMARK = A + '/icons/general/steamWhiteIcon.svg';
  var RATING_BG = A + '/images/profile/ratingBg.webp';
  var CLOSE_ICO = A + '/icons/general/closeIcon.svg';

  /** Inline <img> for one of the site's icons. */
  function ico(src, cls, alt) {
    return '<img class="' + cls + '" src="' + src + '" alt="' + (alt || '') + '">';
  }

  /**
   * The pencil is the one glyph with no equivalent on the original - caser.one
   * ships no edit icon anywhere in its bundle, so there is nothing to copy and
   * this has to be drawn. Everything around it is site artwork.
   */
  var PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';

  function applyProfile(strip, payload) {
    var u = payload.user, s = payload.stats;
    var q = function (k) { return strip.querySelector('[data-f="' + k + '"]'); };

    q('nick').textContent = u.nickname || 'Игрок';
    q('uid').textContent = u.id;
    q('balance').textContent = fmtMoney(u.balance);
    // Casey's rating tile is gone for good - the line used to reference a
    // removed element and crashed here, which froze every stat below it.
    q('cases').textContent = fmtCount(s.casesOpened);
    q('upgrades').textContent = fmtCount(s.upgradesMade);
    q('won').textContent = fmtCount(s.upgradesWon);
    q('withdrawn').textContent = fmtMoney(s.withdrawn);
    q('wdCount').textContent = s.withdrawnItems;

    if (s.bestDrop > 0) {
      q('bestName').textContent = s.bestDropName || '—';
      q('bestPrice').textContent = fmtMoney(s.bestDrop);
      var bimg = q('bestImage');
      bimg.src = s.bestDropImage || '';
      bimg.hidden = false;
      var frame = strip.querySelector('.caser-best-img');
      if (frame) frame.style.setProperty('--drop-color', s.bestDropColor || '#B0C3D9');
    }

    var img = strip.querySelector('.caser-avatar img');
    img.src = u.image || '';
    img.onerror = function () { img.style.visibility = 'hidden'; };

    var creator = !!u.isCreator;
    strip.querySelector('.caser-tick').hidden = !creator;
    strip.querySelector('.caser-author').hidden = !creator;
    strip.dataset.ready = '1';
  }

  /**
   * Fills the strip, retrying until it lands.
   *
   * At DOMContentLoaded the app has not hydrated and has not written the
   * session cookie yet, so the first request can come back for an account that
   * is about to be replaced. Retrying a few times is more reliable than trying
   * to order ourselves against React's boot.
   */
  function observeStrip(strip, attempt) {
    attempt = attempt || 0;
    return fetch('/api/users/profile', { headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.success) {
          if (attempt < 6) return new Promise(function (res) { setTimeout(res, 700); }).then(function () {
            return observeStrip(strip, attempt + 1);
          });
          return;
        }
        profileCache = d.data;
        applyProfile(strip, d.data);
      })
      .catch(function () {
        if (attempt < 6) return new Promise(function (res) { setTimeout(res, 700); }).then(function () {
          return observeStrip(strip, attempt + 1);
        });
      });
  }

  // Promo modal, built once and reused.
  var promoModal = null;
  function openPromoModal() {
    if (!promoModal) {
      promoModal = document.createElement('div');
      promoModal.className = 'caser-promo-bg';
      promoModal.innerHTML =
        '<div class="caser-promo">' +
        '<div class="caser-lbl">Промокод</div>' +
        '<input type="text" placeholder="ВВЕДИТЕ КОД" autocomplete="off" spellcheck="false">' +
        '<div class="caser-promo-msg"></div>' +
        '<div class="caser-promo-row">' +
        '<button class="caser-ghost" data-c="cancel">Отмена</button>' +
        '<button class="caser-topup" data-c="go">Применить</button>' +
        '</div></div>';
      document.body.appendChild(promoModal);

      var input = promoModal.querySelector('input');
      var msg = promoModal.querySelector('.caser-promo-msg');
      promoModal.addEventListener('click', function (e) {
        if (e.target === promoModal || e.target.dataset.c === 'cancel') {
          promoModal.classList.remove('open');
          return;
        }
        if (e.target.dataset.c !== 'go') return;
        var code = input.value.trim();
        if (!code) { msg.textContent = 'Введите код'; msg.className = 'caser-promo-msg err'; return; }
        msg.textContent = 'Проверяем...'; msg.className = 'caser-promo-msg';
        fetch('/api/promo/redeem', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code })
        }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, b: j }; }); })
          .then(function (res) {
            if (!res.ok || !res.b.success) throw new Error((res.b && res.b.message) || 'Не удалось');
            msg.textContent = 'Код активирован: +' + res.b.data.amount.toLocaleString('ru-RU', { minimumFractionDigits: 2 });
            msg.className = 'caser-promo-msg ok';
            input.value = '';
            var strip = document.querySelector('.caser-profile-strip');
            if (strip) observeStrip(strip);
            setTimeout(function () { promoModal.classList.remove('open'); }, 1400);
          })
          .catch(function (err) {
            msg.textContent = err.message;
            msg.className = 'caser-promo-msg err';
          });
      });
    }
    promoModal.classList.add('open');
    var f = promoModal.querySelector('input');
    f.value = '';
    promoModal.querySelector('.caser-promo-msg').textContent = '';
    f.focus();
  }

  /**
 * The ПРЕДМЕТЫ / ИСТОРИЯ / АПГРЕЙДЫ switch above the inventory grid.
 *
 * caser.one shows this row on the profile screen but the component is missing
 * from this build, so the page had only the sell/sort controls on the right and
 * nothing on the left. It is injected as the first child of the existing
 * toolbar, which already lays its children out with justify-between, so the
 * sell and sort groups stay exactly where they were.
 *
 * ПРЕДМЕТЫ is the live tab. The other two are not built yet and say so rather
 * than silently doing nothing.
 */
  var TABS = [
    { id: 'items', label: 'ПРЕДМЕТЫ', ready: true },
    { id: 'history', label: 'ИСТОРИЯ', ready: false },
    { id: 'upgrades', label: 'АПГРЕЙДЫ', ready: false }
  ];

  /**
   * Puts "Продать все" beside the sort select in the toolbar, where the
   * filtering controls live, instead of wherever the grid left it. The site
   * renders a desktop or a mobile variant of the button depending on the
   * viewport, so whichever one is on screen is the one that moves. The button
   * only appears on the ПРЕДМЕТЫ tab - selectInventoryTab hides it elsewhere.
   * Re-running is a no-op, which matters because React moves nodes around.
   */
  function placeSellAllNextToSort(page) {
    var sort = page.querySelector('[data-testid="profile-sort-select"]');
    if (!sort || !sort.parentNode) return;
    var candidates = [
      document.querySelector('[data-testid="inventory-sell-all-button-desktop"]'),
      document.querySelector('[data-testid="inventory-sell-all-button-mobile"]')
    ].filter(Boolean);
    if (!candidates.length) return;
    var sell = candidates.filter(function (b) { return b.offsetWidth || b.offsetHeight; })[0] || candidates[0];
    // insertBefore(sell, sort) leaves the button immediately BEFORE the sort
    // select, so the "already in place" check has to look at the NEXT sibling.
    // Testing previousElementSibling was never true, so every pass moved the
    // button again, and each move re-fired the MutationObserver - an endless
    // insert loop that locked the main thread on the inventory page.
    if (sell.nextElementSibling === sort) return; // already in place
    sort.parentNode.insertBefore(sell, sort);
  }

  /** Re-checks the placement on pages that have the toolbar. */
  function ensureSellAllPlacement() {
    if (!isProfileRoute() && !isInventoryRoute()) return;
    var page = document.querySelector('[data-testid="inventory-page"]');
    if (page) placeSellAllNextToSort(page);
  }

  function ensureInventoryTabs() {
    // Only the profile gets the ПРЕДМЕТЫ/ИСТОРИЯ/АПГРЕЙДЫ tabs - on the
    // inventory they would cover the item grid the original page shows.
    if (!isProfileRoute()) {
      var staleGroup = document.querySelector('.caser-tabs');
      if (staleGroup) staleGroup.remove();
      var staleNotice = document.querySelector('[data-testid="inventory-wip"]');
      if (staleNotice) staleNotice.remove();
      return;
    }
    if (document.querySelector('.caser-tabs')) return;

    var page = document.querySelector('[data-testid="inventory-page"]');
    if (!page) return;
    var toolbar = page.querySelector(':scope > div.flex.items-center.justify-between');
    if (!toolbar) return;

    var group = document.createElement('div');
    group.className = 'caser-tabs';
    group.setAttribute('data-testid', 'inventory-tabs');
    group.innerHTML = TABS.map(function (t) {
      return '<button type="button" class="caser-tab" data-tab="' + t.id + '"'
        + ' data-ready="' + (t.ready ? '1' : '0') + '">' + t.label + '</button>';
    }).join('');

    toolbar.insertBefore(group, toolbar.firstChild);

    placeSellAllNextToSort(page);

    var notice = document.createElement('div');
    notice.className = 'caser-wip';
    notice.setAttribute('data-testid', 'inventory-wip');
    notice.hidden = true;
    notice.innerHTML =
      '<span class="caser-wip-title">В РАЗРАБОТКЕ</span>'
      + '<span class="caser-wip-sub">Открой свой первый кейс</span>';
    page.appendChild(notice);

    group.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-tab]');
      if (!btn) return;
      selectInventoryTab(btn.getAttribute('data-tab'), group, notice, page);
    });

    // Land on ПРЕДМЕТЫ so the sell and sort controls start visible.
    selectInventoryTab('items', group, notice, page);
  }

  function selectInventoryTab(id, group, notice, page) {
    group.querySelectorAll('[data-tab]').forEach(function (b) {
      var on = b.getAttribute('data-tab') === id;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    var tab = TABS.filter(function (t) { return t.id === id; })[0];
    var grid = page.querySelector('[data-testid="inventory-items-list"]') ||
      page.querySelector('[data-testid="upgrade-empty-inventory"]');

    // Selling and sorting only make sense on the items tab.
    var selling = tab && tab.ready;
    ['inventory-sell-all-button-desktop', 'inventory-sell-all-button-mobile'].forEach(function (tid) {
      var btn = document.querySelector('[data-testid="' + tid + '"]');
      if (btn) btn.hidden = !selling;
    });
    var sort = page.querySelector('[data-testid="profile-sort-select"]');
    if (sort) sort.hidden = !selling;

    if (selling) {
      notice.hidden = true;
      if (grid) grid.hidden = false;
      return;
    }

    // Not built yet: say so instead of showing stale items.
    if (grid) grid.hidden = true;
    notice.querySelector('.caser-wip-title').textContent = 'В РАЗРАБОТКЕ';
    notice.hidden = false;
  }

  /**
 * The giveaway banner.
 *
 * Uses the site's own weekly-drop artwork (bg.webp, users.svg) so it reads as
 * part of the page rather than an overlay. Full width, as asked. Only the
 * active giveaway is shown; finished ones are hidden.
 */
  var GIVEAWAY_BG = A + '/images/weeklyDrop/bg.webp';
  var GIVEAWAY_USERS = A + '/icons/weeklyDrop/users.svg';

  function ensureGiveawayBanner() {
    // The banner belongs to the giveaways screen only. On every other page it
    // sat under the fixed header and pushed the content down.
    if (!/\/rewards/.test(location.pathname)) {
      var stale = document.querySelector('.caser-giveaway');
      if (stale) {
        if (stale._timer) clearInterval(stale._timer);
        if (stale._watch) clearInterval(stale._watch);
        stale.remove();
      }
      return null;
    }
    var existing = document.querySelector('.caser-giveaway');
    if (existing) return existing;

    var banner = document.createElement('div');
    banner.className = 'caser-giveaway';
    banner.setAttribute('data-testid', 'giveaway-banner');
    banner.innerHTML =
      '<img class="caser-giveaway-bg" src="' + GIVEAWAY_BG + '" alt="">'
      + '<div class="caser-giveaway-inner">'
      +   '<div class="caser-giveaway-prize">'
      +     '<img class="caser-giveaway-img" alt="">'
      +     '<div class="caser-giveaway-meta">'
      +       '<div class="caser-giveaway-kicker">РОЗЫГРЫШ</div>'
      +       '<div class="caser-giveaway-title" data-f="title">—</div>'
      +       '<div class="caser-giveaway-sub" data-f="prizeName">—</div>'
      +     '</div>'
      +   '</div>'
      +   '<div class="caser-giveaway-side">'
      +     '<div class="caser-giveaway-timer" data-f="timer">--:--:--</div>'
      +     '<div class="caser-giveaway-count">'
      +       '<img class="caser-btn-ico" src="' + GIVEAWAY_USERS + '" alt="">'
      +       '<b data-f="entries">0</b><span>участников</span></div>'
      +     '<button class="caser-btn-primary" data-act="enter">УЧАСТВОВАТЬ</button>'
      +     '<div class="caser-giveaway-msg" data-f="msg"></div>'
      +   '</div>'
      + '</div>';

    // Sit it directly under the header so it spans the page. The header root is
    // the anchor rather than a class selector: the app root's class contains
    // min-h-[100svh], and an unescaped bracket is not a valid selector.
    var header = document.querySelector('[data-testid="header-root"]');
    var app = header ? header.parentElement : null;
    if (app && header) app.insertBefore(banner, header.nextSibling);
    else if (app) app.insertBefore(banner, app.firstChild);
    else document.body.insertBefore(banner, document.body.firstChild);

    // getElementById('header-root') finds nothing - it is a data-testid - so the
    // banner used to be prepended to the app root and slide up behind the fixed
    // header. Insert after the header and give it the header's height as an
    // offset, because a position:fixed header takes no space in the flow.
    var headerH = header ? Math.round(header.getBoundingClientRect().height) : 50;
    banner.style.marginTop = headerH + 'px';

    banner.addEventListener('click', function (e) {
      if (e.target.closest('[data-act="enter"]')) enterGiveaway(banner);
    });

    loadGiveawayBanner(banner);
    return banner;
  }

  function enterGiveaway(banner) {
    var msg = banner.querySelector('[data-f="msg"]');
    msg.textContent = 'Отмечаем...';
    fetch('/api/giveaways/' + banner.dataset.id + '/enter', { method: 'POST' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.j.success) throw new Error((res.j && res.j.message) || 'Не удалось');
        msg.textContent = 'Вы в игре!';
        var n = banner.querySelector('[data-f="entries"]');
        if (n) n.textContent = res.j.data.entries;
        banner.querySelector('[data-act="enter"]').disabled = true;
      })
      .catch(function (err) { msg.textContent = err.message; });
  }

  function loadGiveawayBanner(banner) {
    fetch('/api/giveaways?limit=5')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.success) return;
        var live = (j.items || []).filter(function (g) { return g.live; })[0];
        if (!live) { banner.hidden = true; return; }

        banner.dataset.id = live.id;
        banner.querySelector('[data-f="title"]').textContent = live.title;
        banner.querySelector('[data-f="prizeName"]').textContent = live.prizeName || '';
        banner.querySelector('[data-f="entries"]').textContent = live.entries;
        var img = banner.querySelector('.caser-giveaway-img');
        if (live.prizeImage) { img.src = live.prizeImage; img.hidden = false; }
        // The server reports whether this account already holds an entry, so a
        // return to the page does not ask for a second press.
        var btn = banner.querySelector('[data-act="enter"]');
        btn.disabled = !!live.entered;
        banner.querySelector('[data-f="msg"]').textContent = live.entered ? 'Вы участвуете' : '';
        banner.hidden = false;
        startGiveawayTimer(banner, live.secondsLeft);
      })
      .catch(function () { banner.hidden = true; });
  }

  function startGiveawayTimer(banner, seconds) {
    if (banner._timer) clearInterval(banner._timer);
    var left = Math.max(0, Number(seconds) || 0);
    var el = banner.querySelector('[data-f="timer"]');
    var tick = function () {
      var h = Math.floor(left / 3600);
      var m = Math.floor((left % 3600) / 60);
      var s = left % 60;
      el.textContent = [h, m, s].map(function (x) { return String(x).padStart(2, '0'); }).join(':');
      if (left <= 0) {
        clearInterval(banner._timer);
        banner.hidden = true;
        return;
      }
      left--;
    };
    tick();
    banner._timer = setInterval(tick, 1000);

    // A round can also be settled early by the operator, so the countdown
    // never reaches zero on its own and the banner would keep advertising a
    // prize that is already gone. Re-check on a slower beat and step aside.
    if (banner._watch) clearInterval(banner._watch);
    banner._watch = setInterval(function () {
      fetch('/api/giveaways?limit=5')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j || !j.success) return;
          var live = (j.items || []).filter(function (g) { return g.live; })[0];
          if (!live || live.id !== banner.dataset.id) {
            if (banner._timer) clearInterval(banner._timer);
            if (banner._watch) clearInterval(banner._watch);
            banner.hidden = true;
          }
        })
        .catch(function () { /* keep the banner up on a network hiccup */ });
    }, 30000);
  }

  /**
   * The rewards page.
   *
   * Three things the operator asked for: the weekly-drop panel is not ready
   * yet, the info cards under the top drop duplicate it, and the injected
   * giveaway banner was painted behind the site's sticky promo sidebar, which
   * left a large blank band above the tabs.
   */
  function setupRewardsPage() {
    if (!/\/rewards/.test(location.pathname)) {
      document.body.removeAttribute('data-caser-page');
      return;
    }
    document.body.setAttribute('data-caser-page', 'rewards');

    // The banner has to outrank the site's sticky promo sidebar (z-3), or the
    // sidebar paints over it and the giveaway looks empty.
    var banner = document.querySelector('.caser-giveaway');
    if (banner) banner.style.zIndex = '5';

    // "Еженедельный набор" - the whole panel, mobile and desktop.
    var weekly = document.querySelector('[data-testid="weekly-drop-content"]');
    if (weekly && weekly.parentElement) weekly.parentElement.style.display = 'none';

    // The three info cards under the top drop ("СРЕДА В ...", "Что я получу",
    // "Условия получения").
    var info = Array.prototype.slice.call(document.querySelectorAll('h3')).filter(function (h) {
      return /^(СРЕДА В|Что я получу|Условия получения)/i.test(h.textContent.trim());
    });
    if (info.length) {
      var grid = info[0];
      for (var i = 0; i < 4 && grid; i++) {
        if (grid.className && grid.className.toString().indexOf('grid-cols-3') >= 0) break;
        grid = grid.parentElement;
      }
      if (grid) grid.style.display = 'none';
    }

    // A finished round leaves the giveaways slot completely empty - the bundle
    // renders no heading and no list at all - and the page then showed a blank
    // column the height of three cards. Say what is going on instead.
    //
    // Only the Розыгрыши tab gets it. The note used to be dropped into whatever
    // tab was showing, so on Награды it landed above the top drop rail - the
    // layout the operator screenshotted as "fine for a second, then ugly".
    // The inactive tab carries opacity-50, the active one does not.
    var gaTab = document.querySelector('[data-testid="weekly-drop-tab-giveaways"]');
    var gaActive = !!gaTab && !/opacity-50/.test(String(gaTab.className));
    var note = document.querySelector('[data-testid="giveaways-empty"]');
    if (note && !gaActive) note.remove();

    if (gaActive) {
      var page = document.querySelector('.animate-page-in');
      var shell = page && page.firstElementChild;
      // child 0 is the Награды/Розыгрыши tab row, child 1 is that tab's content.
      var slot = shell && shell.children[1];
      if (slot) {
        // The card testids are giveaway-card-<cadence>, so the list's own child
        // count is what tells cards apart from nothing.
        var listEl = slot.querySelector('[data-testid="giveaway-list"]');
        var hasCards = !!listEl && listEl.children.length > 0;
        if (!hasCards && !note) {
          note = document.createElement('div');
          note.className = 'caser-giveaways-empty';
          note.setAttribute('data-testid', 'giveaways-empty');
          note.innerHTML = '<span class="caser-giveaways-empty-title">Сейчас активных розыгрышей нет</span>'
            + '<span class="caser-giveaways-empty-sub">Следующий откроется совсем скоро — следите за обновлениями.</span>';
          slot.appendChild(note);
        } else if (hasCards && note) {
          note.remove();
        }
      }
    }
  }

  /**
   * Footer contacts.
   *
   * The server already rewrites these two addresses in the HTML it sends, but
   * the page is a static export: the RSC payload carries the original footer
   * and React re-creates it on hydration, putting caser.one's own addresses
   * back on screen. Rewriting them here is what actually sticks.
   */
  var FOOTER_SUPPORT = 'vscybon@gmail.com';
  var FOOTER_PARTNERSHIP = 'нет';

  function ensureFooterContacts() {
    var support = document.querySelector('[data-testid="footer-support-email-link"]');
    if (support) {
      if (support.textContent !== FOOTER_SUPPORT) support.textContent = FOOTER_SUPPORT;
      var href = 'mailto:' + FOOTER_SUPPORT;
      if (support.getAttribute('href') !== href) support.setAttribute('href', href);
    }
    var partner = document.querySelector('[data-testid="footer-partnership-email-link"]');
    if (partner) {
      if (partner.textContent !== FOOTER_PARTNERSHIP) partner.textContent = FOOTER_PARTNERSHIP;
      if (partner.hasAttribute('href')) partner.removeAttribute('href');
    }
  }

  // Init after React has hydrated.
  //
  // Injecting before hydration makes React report a mismatch (#418): the server
  // markup has no room for our nodes, so it re-renders the subtree. Waiting for
  // an idle moment costs nothing - the observer below re-attaches anything React
  // discards on a later render anyway.
  function boot() {
    // ?noboot is a diagnostic escape hatch: it loads the page with none of our
    // nodes injected, so a React hydration complaint can be attributed either
    // to this script or to the page itself.
    if (/[?&]noboot\b/.test(location.search)) return;
    injectAuthModal();
    updateHeaderUI();
    setupObserver();
    setupBalanceSync();
    setupProfileCards();
    ensureInventoryTabs();
    ensureSellAllPlacement();
    ensureGiveawayBanner();
    setupRewardsPage();
    ensureFooterContacts();
  }
  function bootWhenIdle() {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(boot, { timeout: 1500 });
    } else {
      setTimeout(boot, 120);
    }
  }
  // The cases page hydrates later than the others (its chunks load more), so
  // wait for the load event there rather than a fixed tick - that is what keeps
  // React #418 from firing on /cases while staying instant elsewhere.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootWhenIdle);
  } else if (document.readyState === 'complete') {
    bootWhenIdle();
  } else {
    window.addEventListener('load', bootWhenIdle, { once: true });
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
