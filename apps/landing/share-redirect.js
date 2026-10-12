// The /r/<code> page's redirect (api/_share.js). A file rather than an inline
// script so the CSP's script-src 'self' allows it without a per-code hash.
location.replace(document.currentScript.dataset.target);
