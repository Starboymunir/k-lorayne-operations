// K.Lorayne Operations — Email Service
// Sends customer replies via SMTP (Gmail, Outlook, custom SMTP)
import nodemailer from 'nodemailer';

let transporter = null;
let emailConfig = null;

/**
 * Configure the email transporter with SMTP settings.
 * Call this whenever settings change.
 */
export function configureEmail(settings) {
  const { smtpHost, smtpPort, smtpUser, smtpPass, emailFrom } = settings;

  // Don't create transporter if SMTP is not configured
  if (!smtpHost || !smtpUser || !smtpPass) {
    transporter = null;
    emailConfig = null;
    return false;
  }

  emailConfig = { smtpHost, smtpPort, smtpUser, smtpPass, emailFrom };

  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(smtpPort) || 587,
    secure: parseInt(smtpPort) === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  return true;
}

/**
 * Check if email is configured and ready to send.
 */
export function isEmailConfigured() {
  return transporter !== null && emailConfig !== null;
}

/**
 * Send an email to a customer.
 * @param {string} to — recipient email
 * @param {string} subject — email subject line
 * @param {string} textBody — plain text body
 * @param {object} options — optional: replyTo, ticketId
 * @returns {object} — { success, messageId, error }
 */
export async function sendEmail(to, subject, textBody, options = {}) {
  if (!transporter || !emailConfig) {
    return { success: false, error: 'Email not configured. Set SMTP settings in Settings.' };
  }

  if (!to || !to.includes('@')) {
    return { success: false, error: 'Invalid recipient email address.' };
  }

  const fromName = options.businessName || 'K.Lorayne Apparel';
  const fromAddr = emailConfig.emailFrom || emailConfig.smtpUser;

  // Build HTML body from plain text
  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="border-bottom: 2px solid #c9a96e; padding-bottom: 16px; margin-bottom: 20px;">
        <h2 style="margin:0; color: #1a1a2e; font-size: 18px;">${fromName}</h2>
        ${options.ticketId ? `<p style="margin:4px 0 0; color: #888; font-size: 12px;">Ticket: ${options.ticketId}</p>` : ''}
      </div>
      <div style="color: #333; font-size: 14px; line-height: 1.7; white-space: pre-wrap;">${escapeHtml(textBody)}</div>
      <div style="margin-top: 30px; padding-top: 16px; border-top: 1px solid #eee; color: #999; font-size: 11px;">
        <p style="margin:0;">This email was sent from ${fromName} Support.</p>
        ${options.ticketId ? `<p style="margin:4px 0 0;">Reference: ${options.ticketId}</p>` : ''}
      </div>
    </div>
  `;

  try {
    const info = await transporter.sendMail({
      from: `"${fromName}" <${fromAddr}>`,
      to,
      subject: options.ticketId ? `[${options.ticketId}] ${subject}` : subject,
      text: textBody,
      html: htmlBody,
      replyTo: options.replyTo || fromAddr,
    });

    console.log(`[email] Sent to ${to} — messageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[email] Failed to send to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send a test email to verify SMTP configuration.
 */
export async function sendTestEmail(to) {
  return sendEmail(
    to,
    'K.Lorayne CRM — Email Test',
    'This is a test email to confirm your SMTP settings are working correctly.\n\nIf you received this, your email integration is set up! ✅',
    { businessName: 'K.Lorayne CRM' }
  );
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
