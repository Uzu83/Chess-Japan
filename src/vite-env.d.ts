/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FEEDBACK_URL?: string;
  readonly VITE_FEEDBACK_TARGET?: string;
  readonly VITE_FEEDBACK_FIREBASE_API_KEY?: string;
  readonly VITE_FEEDBACK_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FEEDBACK_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FEEDBACK_FIREBASE_APP_ID?: string;
  readonly VITE_FEEDBACK_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FEEDBACK_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_KOFI_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_AUTH_ENABLED?: string;
  readonly VITE_OAUTH_GOOGLE_ENABLED?: string;
  readonly VITE_OAUTH_APPLE_ENABLED?: string;
  readonly VITE_PVP_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
