/**
 * SHEPU ROOMS — google.js
 * Base HTTP client for all Google REST API calls.
 * Handles: Authorization header, retry with exponential backoff, 401 token refresh.
 */

const GoogleAPI = (() => {
  const DEBUG = () => Storage.get('debug_mode') === 'true';

  function log(...args) {
    if (DEBUG()) console.log('[GoogleAPI]', ...args);
  }

  // ── Core fetch with auth + retry ──────────────────────────────
  async function request(url, options = {}, retries = CONFIG.MAX_RETRY_ATTEMPTS) {
    const token = await Auth.getAccessToken();

    const fetchOptions = {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    };

    log('REQ', options.method || 'GET', url);

    let lastErr;
    let attempt = 0;

    while (attempt <= retries) {
      try {
        const res = await fetch(url, fetchOptions);

        if (res.status === 204) return null; // No content

        if (res.status === 401) {
          // Token expired — get fresh token and retry once
          log('401 — refreshing token');
          const freshToken = await Auth.getAccessToken();
          fetchOptions.headers['Authorization'] = `Bearer ${freshToken}`;
          const retryRes = await fetch(url, fetchOptions);
          if (!retryRes.ok) throw await toApiError(retryRes);
          return retryRes.status === 204 ? null : retryRes.json();
        }

        if (res.status === 429 || res.status >= 500) {
          // Rate limited or server error — backoff
          const wait = CONFIG.BASE_BACKOFF_MS * Math.pow(2, attempt);
          log(`HTTP ${res.status} — waiting ${wait}ms (attempt ${attempt + 1})`);
          await sleep(wait);
          attempt++;
          continue;
        }

        if (!res.ok) {
          throw await toApiError(res);
        }

        const data = await res.json();
        log('RES', res.status, url);
        return data;

      } catch (err) {
        if (err.name === 'TypeError') {
          // Network error (offline)
          lastErr = new Error('Network offline or request failed');
          lastErr.isNetwork = true;
          break;
        } else {
          lastErr = err;
        }

        // Do not retry 4xx client errors (e.g. 403 Forbidden, 404 Not Found)
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
          break;
        }

        if (attempt >= retries) break;
        const wait = CONFIG.BASE_BACKOFF_MS * Math.pow(2, attempt);
        await sleep(wait);
        attempt++;
      }
    }

    throw lastErr || new Error('Request failed after retries');
  }

  async function toApiError(res) {
    let body = {};
    try { body = await res.json(); } catch { /* ignore */ }
    const msg = body?.error?.message || body?.error?.status || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body   = body;
    return err;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── Convenience methods ───────────────────────────────────────
  return {
    get:    (url, opts)  => request(url, { method: 'GET',    ...opts }),
    post:   (url, body, opts) => request(url, { method: 'POST',   body: JSON.stringify(body), ...opts }),
    put:    (url, body, opts) => request(url, { method: 'PUT',    body: JSON.stringify(body), ...opts }),
    request,
  };
})();

window.GoogleAPI = GoogleAPI;
