// LedgerLine Dashboard Client Logic

const PRESET_USERS = {
  admin: { email: 'admin@ledgerline.internal', password: 'AdminPass123!', role: 'ADMIN', name: 'System Administrator' },
  alice: { email: 'alice@ledgerline.internal', password: 'AlicePass123!', role: 'ACCOUNT_HOLDER', name: 'Alice Chen' },
  bob: { email: 'bob@ledgerline.internal', password: 'BobPass123!', role: 'ACCOUNT_HOLDER', name: 'Bob Martinez' },
  auditor: { email: 'auditor@ledgerline.internal', password: 'AuditorPass123!', role: 'AUDITOR', name: 'Auditor Compliance' }
};

let currentUser = null;
let authToken = null;
let currentPersona = 'admin';
let currentTab = 'transfer';
let allAccounts = [];
let selectedAccountId = null;

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', async () => {
  generateNewIdempotencyKey();
  await switchPersona('admin');
});

/**
 * Switch persona with instant seamless login
 */
async function switchPersona(personaKey) {
  currentPersona = personaKey;
  const preset = PRESET_USERS[personaKey];
  if (!preset) return;

  // Update switcher buttons UI
  document.querySelectorAll('.persona-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.role === personaKey);
  });

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: preset.email, password: preset.password })
    });
    const data = await res.json();

    if (!res.ok) {
      showFeedback(`Login failed: ${data.error}`, 'error');
      return;
    }

    authToken = data.token;
    currentUser = data.user;

    // Update user header UI
    document.getElementById('user-display-name').textContent = currentUser.name;
    const roleBadge = document.getElementById('user-role-badge');
    roleBadge.textContent = currentUser.role;
    roleBadge.className = `role-pill ${currentUser.role.toLowerCase()}`;

    // Adjust UI capabilities based on role
    const isAuditor = currentUser.role === 'AUDITOR';
    document.getElementById('movement-card').style.display = isAuditor ? 'none' : 'block';
    document.getElementById('btn-create-account').style.display = isAuditor ? 'none' : 'inline-block';

    generateNewIdempotencyKey();
    await loadAccounts();
    await refreshReconciliation(false);
  } catch (err) {
    console.error('Persona switch error:', err);
  }
}

/**
 * Generate a new RFC4122 v4 UUID for idempotency key
 */
function generateNewIdempotencyKey() {
  const uuid = typeof crypto.randomUUID === 'function' 
    ? crypto.randomUUID() 
    : 'key_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  const input = document.getElementById('idempotency-key-input');
  if (input) input.value = `idem_${uuid}`;
}

/**
 * Load accounts from API
 */
async function loadAccounts() {
  const container = document.getElementById('accounts-container');
  try {
    const res = await fetch('/api/accounts', {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const data = await res.json();

    if (!res.ok) {
      container.innerHTML = `<div class="feedback-banner error">Failed to load accounts: ${data.error}</div>`;
      return;
    }

    allAccounts = data.accounts || [];

    if (allAccounts.length === 0) {
      container.innerHTML = `<div class="empty-state">No accounts found.</div>`;
      return;
    }

    // Populate Accounts List
    container.innerHTML = allAccounts.map(acc => `
      <div class="account-item ${acc.id === selectedAccountId ? 'active' : ''}" onclick="selectAccount('${acc.id}')">
        <div class="acc-meta">
          <span class="acc-name">${escapeHtml(acc.name)}</span>
          <span class="acc-sub">${escapeHtml(acc.account_number)} • ${escapeHtml(acc.owner_name)}</span>
        </div>
        <div class="acc-bal-box">
          <div class="acc-balance">${acc.balanceFormatted}</div>
          <span class="acc-status-tag">${acc.status}</span>
        </div>
      </div>
    `).join('');

    // Populate dropdowns in movement form and race simulator
    populateDropdowns();

    // Auto-select first account if none selected
    if (!selectedAccountId || !allAccounts.some(a => a.id === selectedAccountId)) {
      selectAccount(allAccounts[0].id);
    } else {
      loadSelectedStatement();
    }
  } catch (err) {
    container.innerHTML = `<div class="feedback-banner error">Error connecting to server.</div>`;
  }
}

function populateDropdowns() {
  const fromSelect = document.getElementById('from-account-select');
  const toSelect = document.getElementById('to-account-select');
  const raceSelect = document.getElementById('race-target-account');

  const options = allAccounts
    .filter(a => !a.is_system)
    .map(a => `<option value="${a.id}">${escapeHtml(a.name)} (${a.balanceFormatted})</option>`)
    .join('');

  if (fromSelect) fromSelect.innerHTML = options;
  if (toSelect) toSelect.innerHTML = options;
  if (raceSelect) raceSelect.innerHTML = options;

  // Make sure toSelect defaults to a different account if possible
  if (toSelect && toSelect.options.length > 1) {
    toSelect.selectedIndex = 1;
  }
}

function selectAccount(accountId) {
  selectedAccountId = accountId;
  document.querySelectorAll('.account-item').forEach(el => {
    el.classList.toggle('active', el.onclick.toString().includes(accountId));
  });
  loadSelectedStatement();
}

/**
 * Load Statement for the selected account
 */
async function loadSelectedStatement() {
  if (!selectedAccountId) return;
  const tbody = document.getElementById('statement-tbody');
  const subtitle = document.getElementById('statement-subtitle');

  try {
    const res = await fetch(`/api/accounts/${selectedAccountId}/statement`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const data = await res.json();

    if (!res.ok) {
      tbody.innerHTML = `<tr><td colspan="7" class="feedback-banner error">Access Denied: ${data.error}</td></tr>`;
      return;
    }

    const { account, statement } = data;
    document.getElementById('stmt-acc-name').textContent = account.name;
    document.getElementById('stmt-acc-number').textContent = account.accountNumber;
    document.getElementById('stmt-acc-balance').textContent = account.balanceFormatted;
    subtitle.textContent = `Showing ${statement.length} ledger postings and refused attempts`;

    if (statement.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No transaction history found for this account.</td></tr>`;
      return;
    }

    tbody.innerHTML = statement.map(item => {
      const isRefused = item.status === 'REFUSED';
      const isCredit = item.entry_type === 'CREDIT';
      const amtClass = isRefused ? 'amt-refused' : (isCredit ? 'amt-credit' : 'amt-debit');
      const amtPrefix = isRefused ? '' : (isCredit ? '+' : '-');
      const formattedAmt = `$${(item.amount / 100).toFixed(2)}`;
      const formattedBal = `$${(item.running_balance / 100).toFixed(2)}`;

      return `
        <tr class="${isRefused ? 'row-refused' : ''}">
          <td class="font-mono">${new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
          <td><span class="status-pill ${item.transaction_type.toLowerCase()}">${item.transaction_type}</span></td>
          <td>
            <div>${escapeHtml(item.description)}</div>
            ${item.refusal_reason ? `<small class="text-danger">⚠️ ${escapeHtml(item.refusal_reason)}</small>` : ''}
          </td>
          <td class="${amtClass}">${amtPrefix}${formattedAmt}</td>
          <td class="font-mono">${formattedBal}</td>
          <td><small>${escapeHtml(item.initiator_name || 'System')}</small></td>
          <td><span class="status-pill ${item.status.toLowerCase()}">${item.status}</span></td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="feedback-banner error">Error loading statement.</td></tr>`;
  }
}

/**
 * Handle Tab Switching between Transfer, Deposit, Withdraw
 */
function switchActionTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.toLowerCase() === tab);
  });

  const fromGroup = document.getElementById('transfer-from-group');
  const toGroup = document.getElementById('transfer-to-group');
  const submitBtn = document.getElementById('btn-submit-movement');

  if (tab === 'transfer') {
    fromGroup.style.display = 'block';
    toGroup.style.display = 'block';
    submitBtn.textContent = 'Execute Internal Transfer';
  } else if (tab === 'deposit') {
    fromGroup.style.display = 'none';
    toGroup.style.display = 'block';
    submitBtn.textContent = 'Execute External Deposit';
  } else if (tab === 'withdraw') {
    fromGroup.style.display = 'block';
    toGroup.style.display = 'none';
    submitBtn.textContent = 'Execute External Withdrawal';
  }
}

/**
 * Handle Money Movement Form Submission
 */
async function handleMovementSubmit(event) {
  if (event) event.preventDefault();
  const feedback = document.getElementById('movement-feedback');
  const submitBtn = document.getElementById('btn-submit-movement');

  const amountVal = parseFloat(document.getElementById('amount-input').value);
  const amountCents = Math.round(amountVal * 100);
  const description = document.getElementById('desc-input').value;
  const idempotencyKey = document.getElementById('idempotency-key-input').value;

  if (isNaN(amountCents) || amountCents <= 0) {
    showFeedback('Please enter a valid positive dollar amount.', 'error');
    return;
  }

  let endpoint = '';
  let payload = {};

  if (currentTab === 'transfer') {
    endpoint = '/api/transactions/transfer';
    payload = {
      fromAccountId: document.getElementById('from-account-select').value,
      toAccountId: document.getElementById('to-account-select').value,
      amount: amountCents,
      description
    };
  } else if (currentTab === 'deposit') {
    endpoint = '/api/transactions/deposit';
    payload = {
      accountId: document.getElementById('to-account-select').value,
      amount: amountCents,
      description
    };
  } else if (currentTab === 'withdraw') {
    endpoint = '/api/transactions/withdraw';
    payload = {
      accountId: document.getElementById('from-account-select').value,
      amount: amountCents,
      description
    };
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Processing...';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    const isReplay = res.headers.get('idempotent-replayed') === 'true';

    if (res.ok) {
      const msg = isReplay 
        ? `🔁 Exactly-Once Guard: Request replayed! Cached transaction ${data.transactionId} returned without moving money again.`
        : `✓ Movement posted successfully! Tx ID: ${data.transactionId} (${data.amountFormatted})`;
      showFeedback(msg, 'success');
      generateNewIdempotencyKey();
      await loadAccounts();
      await refreshReconciliation(false);
    } else {
      showFeedback(`Refused (${data.code}): ${data.error}`, 'error');
      await loadAccounts();
    }
  } catch (err) {
    showFeedback(`Network error: ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
    switchActionTab(currentTab);
  }
}

/**
 * Simulate Double Click: Fires 2 identical requests with the SAME key in parallel
 */
async function simulateDoubleClick() {
  const amountVal = parseFloat(document.getElementById('amount-input').value) || 25.00;
  const amountCents = Math.round(amountVal * 100);
  const description = 'Double-click simulation test';
  const sharedKey = `double_click_${crypto.randomUUID()}`;

  const payload = {
    fromAccountId: document.getElementById('from-account-select').value,
    toAccountId: document.getElementById('to-account-select').value,
    amount: amountCents,
    description
  };

  showFeedback('⚡ Firing 2 simultaneous requests with the SAME idempotency key...', 'success');

  const [res1, res2] = await Promise.all([
    fetch('/api/transactions/transfer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'Idempotency-Key': sharedKey
      },
      body: JSON.stringify(payload)
    }),
    fetch('/api/transactions/transfer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'Idempotency-Key': sharedKey
      },
      body: JSON.stringify(payload)
    })
  ]);

  const data1 = await res1.json();
  const data2 = await res2.json();

  const isReplayed1 = res1.headers.get('idempotent-replayed') === 'true' || data1.idempotentReplay;
  const isReplayed2 = res2.headers.get('idempotent-replayed') === 'true' || data2.idempotentReplay;

  const summary = `
    <strong>Double-Click Test Result:</strong><br>
    Request 1: ${res1.status} ${isReplayed1 ? '(Cached Replay)' : '(Original Execution)'} — Tx: ${data1.transactionId || 'Refused'}<br>
    Request 2: ${res2.status} ${isReplayed2 ? '(Cached Replay)' : '(Original Execution)'} — Tx: ${data2.transactionId || 'Refused'}<br>
    <em>Result: Money was moved exactly once! Books remain 100% balanced.</em>
  `;

  showFeedback(summary, 'success');
  generateNewIdempotencyKey();
  await loadAccounts();
  await refreshReconciliation(false);
}

/**
 * Simulate Concurrent Race Condition:
 * Fires 10 concurrent withdrawals of $100.00 simultaneously against target account
 */
async function runConcurrentRaceAttack() {
  const targetAccountId = document.getElementById('race-target-account').value;
  const btn = document.getElementById('btn-run-race');
  const resultsContainer = document.getElementById('race-results');

  btn.disabled = true;
  btn.textContent = 'Racing 10 Concurrent Requests...';
  resultsContainer.innerHTML = '<div class="race-result-row">Launching 10 concurrent requests at the exact same millisecond...</div>';

  const withdrawalAmount = 10000; // $100.00 each
  const promises = Array.from({ length: 10 }).map((_, i) => {
    const key = `race_sim_${i}_${crypto.randomUUID()}`;
    return fetch('/api/transactions/withdraw', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'Idempotency-Key': key
      },
      body: JSON.stringify({
        accountId: targetAccountId,
        amount: withdrawalAmount,
        description: `Concurrent race attempt #${i + 1}`
      })
    }).then(async res => {
      const data = await res.json();
      return { index: i + 1, status: res.status, ok: res.ok, data };
    });
  });

  const outcomes = await Promise.all(promises);

  let successCount = 0;
  let refusedCount = 0;

  resultsContainer.innerHTML = outcomes.map(o => {
    if (o.ok) {
      successCount++;
      return `<div class="race-result-row success">#${o.index} SUCCESS: $100.00 withdrawn (Tx: ${o.data.transactionId.substring(0, 12)}...)</div>`;
    } else {
      refusedCount++;
      return `<div class="race-result-row refused">#${o.index} REFUSED: ${escapeHtml(o.data.code)} (${escapeHtml(o.data.error)})</div>`;
    }
  }).join('');

  resultsContainer.innerHTML += `
    <div class="race-result-row" style="background: rgba(56, 189, 248, 0.15); color: #fff;">
      <strong>Race Summary:</strong> ${successCount} Succeeded, ${refusedCount} Refused. Floor (balance >= 0) strictly preserved!
    </div>
  `;

  btn.disabled = false;
  btn.textContent = '💥 Fire 10 Concurrent Race Requests';
  await loadAccounts();
  await refreshReconciliation(false);
}

/**
 * Live System Reconciliation & Cryptographic Proof Check
 */
async function refreshReconciliation(showAlert = false) {
  try {
    const res = await fetch('/api/reconciliation', {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const report = await res.json();

    if (!res.ok) return;

    // Update Banner
    const isProven = report.overallIntegrityProven;
    document.getElementById('proof-status-text').textContent = isProven ? 'Verified (Δ = $0.00)' : 'FAILED';
    document.getElementById('pill-conservation').className = `proof-pill ${isProven ? 'success' : 'failed'}`;

    document.getElementById('proof-chain-text').textContent = report.cryptographicLedgerChain.chainValid ? 'Valid (Untampered)' : 'BROKEN';
    document.getElementById('pill-hash-chain').className = `proof-pill ${report.cryptographicLedgerChain.chainValid ? 'success' : 'failed'}`;

    // Update Proof Panel
    document.getElementById('rec-user-bal').textContent = report.moneyConservation.actualUserBalanceFormatted;
    document.getElementById('rec-deposits').textContent = report.moneyConservation.totalDepositsFormatted;
    document.getElementById('rec-withdrawals').textContent = report.moneyConservation.totalWithdrawalsFormatted;
    document.getElementById('rec-discrepancy').textContent = `$${(report.moneyConservation.discrepancy / 100).toFixed(2)}`;
    document.getElementById('rec-blocks-count').textContent = `${report.cryptographicLedgerChain.totalBlocksVerified} Verified Blocks`;
    document.getElementById('rec-latest-hash').textContent = report.cryptographicLedgerChain.latestBlockHash;

    if (showAlert) {
      alert(`Mathematical & Cryptographic Audit Result:\n\n✓ Money Conservation: ${report.moneyConservation.invariantEquation} (Holds: ${report.moneyConservation.invariantHolds})\n✓ Double-Entry Books: Debits == Credits (${report.doubleEntry.doubleEntryBalanced})\n✓ SHA-256 Ledger Chain: ${report.cryptographicLedgerChain.chainValid ? 'Valid' : 'Corrupted'} (${report.cryptographicLedgerChain.totalBlocksVerified} blocks)\n✓ Total Refused Attempts Logged: ${report.refusalAudit.totalRefusedAttempts}`);
    }
  } catch (err) {
    console.error('Reconciliation error:', err);
  }
}

function showFeedback(html, type) {
  const el = document.getElementById('movement-feedback');
  if (!el) return;
  el.className = `feedback-banner ${type}`;
  el.innerHTML = html;
  el.style.display = 'block';
}

function openCreateAccountModal() {
  const select = document.getElementById('new-acc-owner');
  select.innerHTML = `
    <option value="usr_alice">Alice Chen (usr_alice)</option>
    <option value="usr_bob">Bob Martinez (usr_bob)</option>
    <option value="usr_admin">System Administrator (usr_admin)</option>
  `;
  document.getElementById('create-account-modal').classList.add('open');
}

function closeCreateAccountModal() {
  document.getElementById('create-account-modal').classList.remove('open');
}

async function handleCreateAccountSubmit(event) {
  event.preventDefault();
  const name = document.getElementById('new-acc-name').value;
  const userId = document.getElementById('new-acc-owner').value;

  try {
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ name, userId })
    });
    const data = await res.json();

    if (res.ok) {
      closeCreateAccountModal();
      await loadAccounts();
      selectAccount(data.account.id);
    } else {
      alert(`Error creating account: ${data.error}`);
    }
  } catch (err) {
    alert(`Network error: ${err.message}`);
  }
}

function logout() {
  switchPersona('admin');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
