// =============================================
// N Signage — Browser session (hosted website / cloud mode)
// There is no login. On load the page asks the server for this browser's
// anonymous session; it lives in an HttpOnly cookie JavaScript never sees.
// The Pis added in this browser are saved under it.
// =============================================
import axios from 'axios';

/** @returns {Promise<{ok: true, browser: object} | {ok: false, error: string}>} */
export async function ensureSession() {
  try {
    const res = await axios.post('/api/auth?action=session', {}, { timeout: 15000 });
    return { ok: true, browser: res.data.browser };
  } catch (error) {
    const data = error.response?.data;
    if (data?.error) return { ok: false, error: data.error };
    if (error.response?.status === 503) return { ok: false, error: 'The N-Signage cloud service is not configured yet. Please contact support.' };
    if (!error.response) return { ok: false, error: 'Could not reach N-Signage. Check your internet connection.' };
    return { ok: false, error: 'Could not start a session with N-Signage.' };
  }
}
