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

export function layout(title: string, text: string) {
  const body = escapeHtml(text).replace(/\n/g, '<br>');
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#222">
  <h2 style="color:#7a4a2a">Peluquería Armando</h2><h3>${escapeHtml(title)}</h3><p style="line-height:1.5">${body}</p>
  <p style="color:#888;font-size:12px;margin-top:32px">Recibes este email porque eres cliente de Peluquería Armando.</p></div>`;
}

export async function sendEmail(to: string, subject: string, text: string) {
  const info = await transporter.sendMail({ from: config.smtp.from, to, subject, text, html: layout(subject, text) });
  if (!emailConfigured()) console.log(`[email simulado] para=${to} asunto="${subject}"`);
  return info;
}

/** Envío que nunca rompe el flujo principal (confirmaciones automáticas). */
export function sendEmailSafe(to: string, subject: string, text: string) {
  sendEmail(to, subject, text).catch((e) => console.error('[email] error enviando a', to, e.message));
}
