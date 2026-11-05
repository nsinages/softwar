// =============================================
// N Signage — Customer account client (hosted website / cloud mode)
// The session is an HttpOnly cookie set by /api/auth; JavaScript never sees it.
// =============================================
import axios from 'axios';

function message(error, fallback) {
  const data = error.response?.data;
  if (data?.error) return data.error;
  if (error.response?.status === 503) return 'The N-Signage cloud service is not configured yet. Please contact support.';
  if (!error.response) return 'Could not reach N-Signage. Check your internet connection.';
  return fallback;
}

/** @returns {Promise<{ok: true, account: object} | {ok: false, loggedOut?: boolean, error?: string}>} */
export async function getMe() {
  try {
    const res = await axios.get('/api/auth?action=me', { timeout: 15000 });
    return { ok: true, account: res.data.account };
  } catch (error) {
    if (error.response?.status === 401) return { ok: false, loggedOut: true };
    return { ok: false, error: message(error, 'Could not check your login.') };
  }
}

async function post(action, body, fallback) {
  try {
    const res = await axios.post(`/api/auth?action=${action}`, body, { timeout: 20000 });
    return { ok: true, account: res.data.account };
  } catch (error) {
    return { ok: false, error: message(error, fallback) };
  }
}

export const login = (email, password) => post('login', { email, password }, 'Login failed.');
export const register = (email, password, name) => post('register', { email, password, name }, 'Could not create the account.');
export const logout = () => post('logout', {}, 'Logout failed.');
