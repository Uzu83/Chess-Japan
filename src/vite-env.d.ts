/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FEEDBACK_URL?: string;
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
