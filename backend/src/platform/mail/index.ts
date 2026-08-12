export { RecordingMail, createConsoleMail } from './mail.port';
export type { MailMessage, MailPort, MailTemplate } from './mail.port';
export { createGuardedMail } from './guarded-mail';
export { renderMail } from './mail-templates';
export type { RenderedMail } from './mail-templates';
export {
  SMTP_TIMEOUT_DEFAULTS,
  createNodemailerTransport,
  createSmtpMail,
} from './smtp-mail';
export type {
  MailEnvelope,
  MailTransport,
  SmtpConfig,
  SmtpMailOptions,
  SmtpSender,
  SmtpTransportFactory,
  SmtpTransportOptions,
} from './smtp-mail';
