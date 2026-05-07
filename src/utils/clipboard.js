/**
 * Copy text to clipboard with fallback for non-HTTPS (mobile over LAN).
 * navigator.clipboard requires secure context (HTTPS or localhost).
 * On mobile over HTTP, we fall back to the legacy execCommand approach.
 */
export function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }

  // Fallback: create a temporary textarea, select it, and copy
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  return new Promise((resolve, reject) => {
    try {
      document.execCommand('copy');
      resolve();
    } catch (err) {
      reject(err);
    } finally {
      document.body.removeChild(textarea);
    }
  });
}
