export {
  CONSENT_TEXT,
  CONSENT_VERSION,
  CONTACT_RETENTION_DAYS,
  FEEDBACK_KINDS,
  FEEDBACK_PLATFORMS,
  FEEDBACK_STATUSES,
  LIMITS,
  type FeedbackContactDoc,
  type FeedbackDoc,
  type FeedbackInput,
  type FeedbackKind,
  type FeedbackPlatform,
  type FeedbackStatus,
  type ValidationResult,
} from './schema';

export { contactExpiryFrom, normalizeScreen, validateFeedback } from './validate';
