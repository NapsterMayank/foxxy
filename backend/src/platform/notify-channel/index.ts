export { CHANNEL_NAMES, textFor } from './channel.port';
export type {
  BilingualText,
  Channel,
  ChannelMessage,
  ChannelName,
  ChannelRecipient,
  ChannelResult,
} from './channel.port';
export { createEmailChannel } from './email-channel';
export type { EmailChannelOptions } from './email-channel';
export { createInAppChannel } from './in-app-channel';
export type { InAppChannelOptions } from './in-app-channel';
export { createPushChannel, createWhatsAppChannel } from './unimplemented-channels';
export { DEFAULT_CHANNELS, createNotificationDispatcher } from './dispatcher';
export type {
  ChannelPolicy,
  ChannelPreferences,
  DispatchOutcome,
  NotificationDispatcher,
  NotificationDispatcherOptions,
} from './dispatcher';
