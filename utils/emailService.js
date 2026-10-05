// ====================================================================
// Email: Resend (HTTPS) + optional Gmail SMTP fallback
// - Resend without verified domain: only to your Resend account email
// - SMTP (local): can send to any recipient
// ====================================================================

const nodemailer = require('nodemailer');

/** Builds the From header from EMAIL_FROM or SMTP_USER in .env. */
function getFromAddress() {
  return (
    process.env.EMAIL_FROM ||
    (process.env.SMTP_USER
      ? `ReeferON <${process.env.SMTP_USER.trim()}>`
      : 'ReeferON <onboarding@resend.dev>')
  ).trim();
}

function getMobileAppUrl() {
  return (process.env.MOBILE_APP_URL || process.env.EXPO_GO_URL || '').trim();
}

function getMobileDeepLink() {
  return (process.env.MOBILE_DEEP_LINK || 'reeferon://login').trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildCredentialsHtml({ fullName, email, password, roleLabel, includeMobile, warehouseName, chamberLimit }) {
  const appUrl = getMobileAppUrl();
  const deepLink = getMobileDeepLink();

  let appBlock = '';
  if (includeMobile) {
    const parts = [];
    if (appUrl) {
      parts.push(
        `App link: <a href="${escapeHtml(appUrl)}" style="color:#0066cc;">${escapeHtml(appUrl)}</a>`
      );
    }
    if (deepLink) {
      parts.push(
        `Open app: <a href="${escapeHtml(deepLink)}" style="color:#0066cc;">${escapeHtml(deepLink)}</a>`
      );
    }
    if (parts.length) {
      appBlock = `<p>${parts.join('<br/>')}</p>`;
    }
  }

  let accessBlock = '';
  if (warehouseName) {
    accessBlock = `<p>Warehouse / Data Access: ${escapeHtml(warehouseName)}` +
      (chamberLimit ? `<br/>Chambers assigned: 1 to ${escapeHtml(String(chamberLimit))}` : '') +
      `</p>`;
  }

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5;">
    <p>Dear ${escapeHtml(fullName || 'User')},</p>
    <p>Your ReeferON ${escapeHtml(roleLabel)} account is ready.</p>
    <p>
      Email: ${escapeHtml(email)}<br/>
      Password: ${escapeHtml(password)}
    </p>
    ${accessBlock}
    ${appBlock}
    <p>Please keep your password confidential.</p>
    <p>Regards,<br/>ReeferON Team</p>
  </div>`;
}

function buildCredentialsText({ fullName, email, password, roleLabel, includeMobile, warehouseName, chamberLimit }) {
  const lines = [
    `Dear ${fullName || 'User'},`,
    '',
    `Your ReeferON ${roleLabel} account is ready.`,
    '',
    `Email: ${email}`,
    `Password: ${password}`,
    ''
  ];
  if (warehouseName) {
    lines.push(`Warehouse / Data Access: ${warehouseName}`);
    if (chamberLimit) lines.push(`Chambers assigned: 1 to ${chamberLimit}`);
    lines.push('');
  }

  if (includeMobile) {
    const appUrl = getMobileAppUrl();
    const deepLink = getMobileDeepLink();
    if (appUrl) lines.push(`App link: ${appUrl}`);
    if (deepLink) lines.push(`Open app: ${deepLink}`);
    if (appUrl || deepLink) lines.push('');
  }

  lines.push(
    'Please keep your password confidential.',
    '',
    'Regards,',
    'ReeferON Team'
  );

  return lines.join('\n');
}

function getSmtpConfig() {
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, '').trim();
  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false';
  return { user, pass, host, port, secure };
}

function isResendRecipientRestriction(msg) {
  return /only send testing emails to your own email/i.test(String(msg || ''));
}

async function sendViaResend({ to, subject, html, text, from }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    console.log(`📧 Sending via Resend to ${to} from ${from}…`);
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        text: text || undefined
      }),
      signal: controller.signal
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.message || body?.error?.message || `Resend HTTP ${res.status}`;
      console.error('❌ Resend error:', msg);
      return { sent: false, error: msg, provider: 'resend' };
    }

    console.log(`📧 Resend OK to ${to} (id: ${body.id || 'n/a'})`);
    return { sent: true, id: body.id || null, provider: 'resend' };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Resend request timed out' : err.message;
    console.error('❌ Resend error:', msg);
    return { sent: false, error: msg, provider: 'resend' };
  } finally {
    clearTimeout(timer);
  }
}

async function sendViaSmtp({ to, subject, html, text, from }) {
  const { user, pass, host, port, secure } = getSmtpConfig();
  if (!user || !pass) {
    return {
      sent: false,
      skipped: true,
      error: 'SMTP_USER / SMTP_PASS not set.',
      provider: 'smtp'
    };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 15000
  });

  try {
    // Use Gmail address as from when SMTP is used (must match authenticated user)
    const smtpFrom = process.env.EMAIL_FROM_SMTP || `ReeferON <${user}>`;
    console.log(`📧 Sending via SMTP to ${to} from ${smtpFrom}…`);
    const info = await Promise.race([
      transporter.sendMail({
        from: smtpFrom,
        to,
        subject,
        text: text || undefined,
        html
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('SMTP timed out after 15s')), 15000)
      )
    ]);
    console.log(`📧 SMTP OK to ${to} (id: ${info.messageId || 'n/a'})`);
    return { sent: true, id: info.messageId || null, provider: 'smtp' };
  } catch (err) {
    console.error('❌ SMTP error:', err.message);
    try {
      transporter.close();
    } catch (_) {}
    return { sent: false, error: err.message, provider: 'smtp' };
  }
}

/**
 * Send credentials email.
 * Prefer SMTP when configured (any recipient). Else Resend.
 * If Resend fails due to "own email only", fall back to SMTP when available.
 */
async function sendEmail({ to, subject, html, text }) {
  const from = getFromAddress();
  const { user, pass } = getSmtpConfig();
  const hasSmtp = !!(user && pass);
  const hasResend = !!(process.env.RESEND_API_KEY || '').trim();

  // Prefer SMTP for any-recipient delivery when available (typical local setup)
  if (hasSmtp && String(process.env.EMAIL_PREFER_SMTP || 'true').toLowerCase() !== 'false') {
    const smtpResult = await sendViaSmtp({ to, subject, html, text, from });
    if (smtpResult.sent) return smtpResult;
    // If SMTP failed and Resend exists, try Resend
    if (hasResend) {
      const resendResult = await sendViaResend({ to, subject, html, text, from });
      if (resendResult) return resendResult;
    }
    return smtpResult;
  }

  if (hasResend) {
    const resendResult = await sendViaResend({ to, subject, html, text, from });
    if (resendResult?.sent) return resendResult;
    // Testing-mode restriction → try SMTP if configured
    if (hasSmtp && isResendRecipientRestriction(resendResult?.error)) {
      console.warn('⚠️ Resend blocked other recipients — falling back to SMTP…');
      return sendViaSmtp({ to, subject, html, text, from });
    }
    if (hasSmtp && resendResult && !resendResult.sent) {
      return sendViaSmtp({ to, subject, html, text, from });
    }
    return (
      resendResult || {
        sent: false,
        error:
          'Resend failed. Without a verified domain you can only email your Resend account address. Verify a domain at resend.com/domains, or set SMTP_USER/SMTP_PASS for local sending.'
      }
    );
  }

  return {
    sent: false,
    skipped: true,
    error:
      'No email provider configured. Set SMTP_USER/SMTP_PASS (any recipient, local) or RESEND_API_KEY + verified domain (deploy).'
  };
}

async function sendOperatorCredentialsEmail({
  email,
  password,
  full_name,
  warehouse_name,
  chamber_limit
}) {
  const payload = {
    roleLabel: 'Data Operator',
    fullName: full_name,
    email,
    password,
    includeMobile: true,
    warehouseName: warehouse_name || '',
    chamberLimit: chamber_limit || null
  };

  return sendEmail({
    to: email,
    subject: 'ReeferON — Login Details',
    text: buildCredentialsText(payload),
    html: buildCredentialsHtml(payload)
  });
}

async function sendSubAdminCredentialsEmail({ email, password, full_name }) {
  const payload = {
    roleLabel: 'Customer',
    fullName: full_name,
    email,
    password,
    includeMobile: false
  };

  return sendEmail({
    to: email,
    subject: 'ReeferON — Login Details',
    text: buildCredentialsText(payload),
    html: buildCredentialsHtml(payload)
  });
}

module.exports = {
  sendEmail,
  sendOperatorCredentialsEmail,
  sendSubAdminCredentialsEmail
};
