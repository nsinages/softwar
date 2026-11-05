// =============================================
// N Signage — Customer account client (hosted website / cloud mode)
// Username + password. The session lives in an HttpOnly cookie that
// JavaScript never sees; nothing secret is kept in browser storage.
// =============================================
import axios from 'axios';

/** Fired when the server says the login session is gone (expired / revoked). */
export const LOGGED_OUT_EVENT = 'nsignage:logged-out';

function message(error, fallback) {
  const data = error.response?.data;
  if (data?.error) return data.error;
  if (error.response?.status === 503) return 'The N-Signage cloud service is not configured yet. Please contact support.';
  if (!error.response) return 'Could not reach N-Signage. Check your internet connection.';
  return fallback;
}

/** @returns {Promise<{ok:true,user:object}|{ok:false,loggedOut?:boolean,error?:string}>} */
export async function getMe() {
  try {
    const res = await axios.get('/api/auth?action=me', { timeout: 15000 });
    return { ok: true, user: res.data.user };
  } catch (error) {
    if (error.response?.status === 401) return { ok: false, loggedOut: true };
    return { ok: false, error: message(error, 'Could not check your login.') };
  }
}

async function post(action, body, fallback) {
  try {
    const res = await axios.post(`/api/auth?action=${action}`, body, { timeout: 30000 });
    return { ok: true, ...res.data };
  } catch (error) {
    return { ok: false, reason: error.response?.data?.reason, error: message(error, fallback) };
  }
}

export const login = (username, password) => post('login', { username, password }, 'Login failed.');
export const register = (username, password, displayName) =>
  post('register', { username, password, displayName }, 'Could not create the account.');
export const logout = () => post('logout', {}, 'Logout failed.');
export const logoutOthers = () => post('logout-others', {}, 'Could not sign out other sessions.');
export const changePassword = (currentPassword, newPassword) =>
  post('change-password', { currentPassword, newPassword }, 'Could not change the password.');
export const recoverAccount = (username, recoveryKey, newPassword) =>
  post('recover', { username, recoveryKey, newPassword }, 'Could not reset the password.');
export const regenerateRecoveryKey = (password) =>
  post('regenerate-recovery', { password }, 'Could not create a new recovery key.');

export const PASSWORD_MIN = 10;
export const USERNAME_RX = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;
