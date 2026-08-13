import { DEFAULT_CORS_ALLOW_HEADERS, resolveCors } from './cors';

describe('DEFAULT_CORS_ALLOW_HEADERS', () => {
  it('includes apikey so logged-in preflight can succeed', () => {
    expect(DEFAULT_CORS_ALLOW_HEADERS).toMatch(/apikey/i);
    expect(DEFAULT_CORS_ALLOW_HEADERS).toMatch(/authorization/i);
    expect(DEFAULT_CORS_ALLOW_HEADERS).toMatch(/x-turnstile-token/i);
  });
});

describe('resolveCors', () => {
  it('default Allow-Headers includes apikey', () => {
    const { headers } = resolveCors({
      origin: 'https://chess-japan.pages.dev',
      allowedOrigins: ['https://chess-japan.pages.dev'],
      isHosted: true,
    });
    expect(headers['Access-Control-Allow-Headers']).toMatch(/apikey/i);
  });
});
