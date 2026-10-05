/**
 * Expo Push HTTP helpers (no FCM SDK required).
 *
 * sendExpoPush(tokens, payload, { db, cleanupTargets })
 *   → sends alerts; on DeviceNotRegistered / InvalidCredentials clears token
 *     from sub_admins / do_operators so future sends stay reliable.
 * Receipt check runs ~12s later for delayed delivery failures.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

/** True for valid Expo push token strings stored on sub_admins / do_operators. */
function isExpoPushToken(token) {
  const t = String(token || '').trim();
  return t.startsWith('ExponentPushToken[') || t.startsWith('ExpoPushToken[');
}

/** Detects Expo errors that mean the device token should be cleared from DB. */
function isDeadTokenError(detailsOrMessage) {
  const text = JSON.stringify(detailsOrMessage || '').toLowerCase();
  return text.includes('devicenotregistered') || text.includes('invalidcredentials');
}

/**
 * Clear dead Expo tokens from one or more tables.
 * @param {import('mysql2/promise').Pool} db
 * @param {string[]} tokens
 * @param {{ table: string, column?: string }[]} targets
 */
async function clearDeadExpoPushTokens(db, tokens, targets) {
  const dead = [...new Set((tokens || []).map((t) => String(t || '').trim()).filter(isExpoPushToken))];
  if (!dead.length || !db || !Array.isArray(targets) || !targets.length) return { cleared: 0 };

  let cleared = 0;
  for (const target of targets) {
    const table = String(target.table || '').trim();
    const column = String(target.column || 'expo_push_token').trim();
    if (!/^[a-zA-Z0-9_]+$/.test(table) || !/^[a-zA-Z0-9_]+$/.test(column)) continue;
    try {
      const placeholders = dead.map(() => '?').join(',');
      const [result] = await db.query(
        `UPDATE \`${table}\` SET \`${column}\` = NULL, updated_at = NOW()
         WHERE \`${column}\` IN (${placeholders})`,
        dead
      );
      cleared += Number(result?.affectedRows) || 0;
    } catch (err) {
      // Some tables may lack updated_at — retry without it
      try {
        const placeholders = dead.map(() => '?').join(',');
        const [result] = await db.query(
          `UPDATE \`${table}\` SET \`${column}\` = NULL WHERE \`${column}\` IN (${placeholders})`,
          dead
        );
        cleared += Number(result?.affectedRows) || 0;
      } catch (err2) {
        console.warn(`clearDeadExpoPushTokens ${table}:`, err2?.message || err2);
      }
    }
  }
  if (cleared > 0) {
    console.warn(`[push] Cleared ${cleared} dead Expo token row(s).`);
  }
  return { cleared };
}

/**
 * @param {string|string[]} tokens
 * @param {{ title: string, body: string, data?: object, channelId?: string }} payload
 * @param {{ db?: object, cleanupTargets?: { table: string, column?: string }[] }} [opts]
 */
async function sendExpoPush(tokens, payload, opts = {}) {
  const list = (Array.isArray(tokens) ? tokens : [tokens])
    .map((t) => String(t || '').trim())
    .filter(isExpoPushToken);

  if (!list.length) return { ok: true, sent: 0, deadTokens: [] };

  const messages = list.map((to) => ({
    to,
    sound: 'default',
    title: payload.title,
    body: payload.body,
    data: payload.data || {},
    channelId: payload.channelId || 'permission-alerts',
    priority: 'high'
  }));

  const deadTokens = [];
  const ticketIds = [];

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(messages)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('Expo push HTTP error:', res.status, json);
      return { ok: false, sent: 0, deadTokens: [], error: json };
    }

    const tickets = Array.isArray(json?.data) ? json.data : [];
    tickets.forEach((ticket, idx) => {
      const token = list[idx];
      if (!ticket) return;
      if (ticket.status === 'error') {
        const errCode = ticket.details?.error || ticket.message || '';
        if (isDeadTokenError(errCode) || isDeadTokenError(ticket)) {
          if (token) deadTokens.push(token);
        }
      } else if (ticket.status === 'ok' && ticket.id) {
        ticketIds.push({ id: ticket.id, token });
      }
    });

    if (opts.db && opts.cleanupTargets?.length && deadTokens.length) {
      await clearDeadExpoPushTokens(opts.db, deadTokens, opts.cleanupTargets);
    }

    // Async receipt check (DeviceNotRegistered often appears here)
    if (opts.db && opts.cleanupTargets?.length && ticketIds.length) {
      setTimeout(() => {
        fetchExpoPushReceiptsAndCleanup(opts.db, ticketIds, opts.cleanupTargets).catch(() => {});
      }, 12_000);
    }

    return {
      ok: true,
      sent: messages.length,
      tickets,
      deadTokens: [...new Set(deadTokens)]
    };
  } catch (err) {
    console.warn('Expo push failed:', err?.message || err);
    return { ok: false, sent: 0, deadTokens: [], error: err?.message || String(err) };
  }
}

async function fetchExpoPushReceiptsAndCleanup(db, ticketPairs, cleanupTargets) {
  const ids = (ticketPairs || []).map((t) => t.id).filter(Boolean);
  if (!ids.length) return;

  try {
    const res = await fetch(EXPO_RECEIPTS_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ids })
    });
    const json = await res.json().catch(() => ({}));
    const receipts = json?.data || {};
    const dead = [];
    for (const pair of ticketPairs) {
      const receipt = receipts[pair.id];
      if (!receipt || receipt.status !== 'error') continue;
      if (isDeadTokenError(receipt.details?.error || receipt) && pair.token) {
        dead.push(pair.token);
      }
    }
    if (dead.length) {
      await clearDeadExpoPushTokens(db, dead, cleanupTargets);
    }
  } catch (err) {
    console.warn('Expo receipt check failed:', err?.message || err);
  }
}

const SUB_ADMIN_PUSH_CLEANUP = [{ table: 'sub_admins', column: 'expo_push_token' }];
const DO_PUSH_CLEANUP = [{ table: 'do_operators', column: 'expo_push_token' }];
const ALL_PUSH_CLEANUP = [...SUB_ADMIN_PUSH_CLEANUP, ...DO_PUSH_CLEANUP];

module.exports = {
  sendExpoPush,
  isExpoPushToken,
  clearDeadExpoPushTokens,
  SUB_ADMIN_PUSH_CLEANUP,
  DO_PUSH_CLEANUP,
  ALL_PUSH_CLEANUP
};
