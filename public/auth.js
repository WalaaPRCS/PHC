(() => {
  let complete = window.__phcReadyResolve;
  if (!window.phcReady) window.phcReady = new Promise((resolve) => { complete = resolve; });
  const keyResource = {
    prcsDemoClinicsV1: 'clinics', prcsDemoStaffV1: 'staff', prcsDemoProjectsV1: 'projects',
    prcsDemoAllocationsV1: 'allocations', prcsDemoPatientRecordsV1: 'patients',
    prcsDemoImmunizationsV1: 'immunizations', prcsDemoVisitsV1: 'visits',
    prcsDemoQueueV1: 'queue', prcsDemoPharmacyStockV1: 'pharmacy_stock',
    prcsDemoDispenseRecordsV1: 'dispenses', prcsDemoDrugCatalogV1: 'drug_catalog',
    prcsDemoLabOrdersV1: 'lab_orders',
  };
  const clientWriteRoles = {
    clinics: ['system_admin'], staff: ['system_admin', 'clinic_admin'], projects: ['system_admin'],
    allocations: ['system_admin'], patients: ['system_admin', 'clinic_admin', 'clinician', 'reception', 'pharmacist', 'lab_technician'],
    immunizations: ['system_admin', 'clinic_admin', 'clinician'], visits: ['system_admin', 'clinic_admin', 'clinician'],
    queue: ['system_admin', 'clinic_admin', 'reception'], pharmacy_stock: ['system_admin'],
    dispenses: ['system_admin', 'clinic_admin', 'pharmacist'], drug_catalog: ['system_admin'],
    lab_orders: ['system_admin', 'clinic_admin', 'clinician', 'lab_technician'],
  };
  let writeChain = Promise.resolve();
  let applyingServerState = false;
  let activeUser = null;

  async function api(path, options = {}) {
    const response = await fetch(`/api/v1${path}`, {
      credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status, payload });
    return payload;
  }
  window.phcApi = api;

  function setSyncStatus(state, message) {
    const badge = document.getElementById('connectionState');
    if (badge) {
      badge.dataset.state = state;
      badge.textContent = message;
      badge.title = message;
    }
  }

  function showLoginError(message) {
    const box = document.getElementById('loginError');
    if (box) { box.textContent = message; box.hidden = false; }
  }

  async function loadState() {
    const state = await api('/state');
    window.__phcIds = {};
    applyingServerState = true;
    try {
      for (const key of Object.keys(keyResource)) {
        const value = Array.isArray(state[key]) ? state[key] : [];
        const safeValue = key === 'prcsDemoPatientRecordsV1' ? value.map((patient) => ({ ...patient, nationalId: '', nationalTail: patient.nationalTail || '' })) : value;
        localStorage.setItem(key, JSON.stringify(safeValue));
        window.__phcIds[key] = safeValue.map((item) => String(item.id || item.fileNo || item.code || item.employeeCode || '')).filter(Boolean);
      }
    } finally { applyingServerState = false; }
  }

  async function authenticated(user) {
    activeUser = user;
    window.phcUser = user;
    await loadState();
    const roleSelect = document.getElementById('roleSelect');
    if (roleSelect) roleSelect.value = user.role === 'lab_technician' ? 'lab' : user.role === 'system_admin' ? 'manager' : 'specialist';
    document.querySelectorAll('[data-view="clinics"],[data-view="staff"],[data-view="users"],[data-view="projects"]').forEach((item) => {
      item.hidden = user.role !== 'system_admin';
    });
    const name = document.getElementById('userName');
    const initial = document.getElementById('userInitial');
    if (name) name.textContent = user.displayName;
    if (initial) initial.textContent = (user.displayName || 'م').trim().charAt(0);
    const gate = document.getElementById('loginGate');
    if (gate) gate.hidden = true;
    document.body.classList.remove('phc-auth-loading');
    setSyncStatus('ok', 'قاعدة البيانات متصلة');
    complete(user);
  }

  function persistKey(key, rawValue) {
    const resource = keyResource[key];
    if (!resource || applyingServerState || !activeUser) return;
    if (!clientWriteRoles[resource]?.includes(activeUser.role)) return;
    let records;
    try { records = JSON.parse(rawValue); } catch { return; }
    if (!Array.isArray(records)) return;
    const next = writeChain.then(async () => {
      setSyncStatus('pending', 'جاري حفظ التغييرات…');
      const priorIds = new Set((window.__phcIds?.[key] || []).map(String));
      const nextIds = new Set(records.map((item) => String(item.id || item.fileNo || item.code || item.employeeCode || '')).filter(Boolean));
      // Patient history is append/update only; deleting a directory row must never erase a medical record.
      const deletedIds = resource === 'patients' || resource === 'visits' ? [] : [...priorIds].filter((id) => !nextIds.has(id));
      // Pharmacist inventory balances are changed only by the server's atomic dispense transaction.
      if (resource === 'pharmacy_stock' && activeUser.role !== 'system_admin') return;
      await api(`/records/${resource}`, { method: 'PUT', body: JSON.stringify({ records, deletedIds }) });
      window.__phcIds ||= {};
      window.__phcIds[key] = [...nextIds];
      setSyncStatus('ok', 'حُفظت التغييرات في قاعدة البيانات');
    }).catch((error) => {
      setSyncStatus('error', 'تعذر الاتصال بقاعدة البيانات');
      const toast = document.getElementById('toast');
      if (toast) { toast.textContent = 'تعذر حفظ التغييرات في قاعدة البيانات. تحقق من الاتصال ثم أعد المحاولة.'; toast.classList.add('show'); }
      console.error('PHC save failed', resource, error.message);
    });
    writeChain = next.catch(() => {});
  }

  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    originalSetItem.call(this, key, value);
    if (this === window.localStorage) persistKey(String(key), String(value));
  };

  async function initialize() {
    const form = document.getElementById('loginForm');
    const username = document.getElementById('loginUsername');
    const password = document.getElementById('loginPassword');
    const button = document.getElementById('loginButton');
    const logout = document.getElementById('logoutButton');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = button;
      submit.disabled = true;
      document.getElementById('loginError').hidden = true;
      try {
        const result = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: username.value, password: password.value }) });
        password.value = '';
        await authenticated(result.user);
      } catch (error) {
        showLoginError(error.status === 429 ? 'محاولات كثيرة. انتظر عشر دقائق ثم أعد المحاولة.' : 'اسم المستخدم أو كلمة المرور غير صحيحة، أو تعذر الاتصال بالخادم.');
      } finally { submit.disabled = false; }
    });
    logout?.addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
      window.location.reload();
    });
    try {
      const { user } = await api('/auth/session');
      await authenticated(user);
    } catch {
      document.body.classList.remove('phc-auth-loading');
      document.getElementById('loginGate').hidden = false;
      username?.focus();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
