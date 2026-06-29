import nodemailer from 'nodemailer';
import type { AppConfig } from './config.js';
import type { SmtpConfig } from './smtp-config.js';

export class EmailService {
  private transporter: nodemailer.Transporter;
  private from: string;

  constructor(config: AppConfig) {
    this.from = config.smtpFrom ?? `Calame <noreply@${config.smtpHost}>`;
    this.transporter = nodemailer.createTransport({
      host: config.smtpHost!,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass ?? '' } : undefined,
    });
  }

  /** Create an EmailService from a SmtpConfig stored in the database. */
  static fromSmtpConfig(config: SmtpConfig): EmailService {
    const instance = Object.create(EmailService.prototype) as EmailService;
    instance.from = config.from || `Calame <noreply@${config.host}>`;
    instance.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    });
    return instance;
  }

  async sendInvitation(options: {
    email: string;
    name: string;
    onboardingUrl: string;
    profileNames: string[];
  }): Promise<void> {
    const { email, name, onboardingUrl, profileNames } = options;
    await this.transporter.sendMail({
      from: this.from,
      to: email,
      subject: 'You have been invited to Calame',
      html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Welcome to Calame, ${name}!</h2>
        <p>You have been invited to access the following data profiles:</p>
        <ul>${profileNames.map((p) => `<li><strong>${p}</strong></li>`).join('')}</ul>
        <p>Click the link below to activate your account and get your access credentials:</p>
        <p><a href="${onboardingUrl}" style="display: inline-block; padding: 12px 24px; background: #4263eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">Activate My Account</a></p>
        <p style="color: #666; font-size: 12px;">This link expires in 72 hours. If you did not expect this invitation, please ignore this email.</p>
      </div>`,
    });
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}

export function isSmtpConfigured(config: AppConfig): boolean {
  return !!config.smtpHost;
}
