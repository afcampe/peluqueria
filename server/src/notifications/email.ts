import nodemailer from 'nodemailer';
import { config } from '../config.js';

const transporter = config.smtp.host
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : // Sin SMTP configurado los emails se imprimen en consola (modo desarrollo).
    nodemailer.createTransport({ jsonTransport: true });

export const emailConfigured = () => Boolean(config.smtp.host);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface EmailAction { label: string; url: string; primary?: boolean }

export function layout(title: string, text: string, actions: EmailAction[] = []) {
  const body = escapeHtml(text).replace(/\n/g, '<br>');
  const buttons = actions.map((a) => `<a href="${escapeHtml(a.url)}" style="display:inline-block;margin:6px 8px 6px 0;padding:12px 20px;border-radius:6px;border:1px solid #121212;text-decoration:none;font-weight:600;${a.primary ? 'background:#121212;color:#ffffff' : 'background:#ffffff;color:#121212'}">${escapeHtml(a.label)}</a>`).join('');
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#222">
  <h2 style="color:#7a4a2a">Peluquería Armando</h2><h3>${escapeHtml(title)}</h3><p style="line-height:1.5">${body}</p>${buttons && `<p>${buttons}</p>`}
  <p style="color:#888;font-size:12px;margin-top:32px">Recibes este email porque eres cliente de Peluquería Armando.</p></div>`;
}

export async function sendEmail(to: string, subject: string, text: string, actions: EmailAction[] = []) {
  const plain = actions.length ? `${text}\n\n${actions.map((a) => `${a.label}: ${a.url}`).join('\n')}` : text;
  const info = await transporter.sendMail({ from: config.smtp.from, to, subject, text: plain, html: layout(subject, text, actions) });
  if (!emailConfigured()) console.log(`[email simulado] para=${to} asunto="${subject}"`);
  return info;
}

/** Envío que nunca rompe el flujo principal (confirmaciones automáticas). */
export function sendEmailSafe(to: string | null, subject: string, text: string) {
  if (!to) return; // cliente sin email (ficha importada de la agenda en papel)
  sendEmail(to, subject, text).catch((e) => console.error('[email] error enviando a', to, e.message));
}
