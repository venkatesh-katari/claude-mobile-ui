const PIN_KEY = 'claude_mobile_pin';

export function getPin() {
  return sessionStorage.getItem(PIN_KEY) || '';
}

export function setPin(pin) {
  sessionStorage.setItem(PIN_KEY, pin);
}

export function clearPin() {
  sessionStorage.removeItem(PIN_KEY);
}

// Drop-in fetch wrapper that injects the X-Pin header on all /api calls
export function apiFetch(url, options = {}) {
  const pin = getPin();
  const headers = { ...(options.headers || {}) };
  if (pin) headers['X-Pin'] = pin;
  return fetch(url, { ...options, headers });
}
