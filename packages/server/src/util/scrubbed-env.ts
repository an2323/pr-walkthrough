/**
 * What a build/browser legitimately needs from our environment: PATH/HOME/locale/tmp,
 * caches (so yarn and Playwright find what the image installed), and proxy/CA settings.
 * Never our secrets — this list is the only way anything gets through.
 */
export const ENV_KEEP = [
  "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM", "NVM_DIR", "COREPACK_HOME",
  "PLAYWRIGHT_BROWSERS_PATH", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "YARN_CACHE_FOLDER",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
] as const;

export function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep: readonly string[] = ENV_KEEP;
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

