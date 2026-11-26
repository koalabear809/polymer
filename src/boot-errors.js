// Loaded as a classic script before main.js. If startup fails (including module syntax
// errors, which never reach main.js), show the error on the page instead of a blank window.
(function () {
  function show(text) {
    if (window.__polymerBooted) return; // after boot, the echo area reports errors
    var el = document.getElementById('boot-error');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'boot-error';
      el.style.cssText = 'position:fixed;inset:0;margin:0;padding:16px;overflow:auto;z-index:1000;' +
        'background:#1a1b26;color:#f7768e;font:13px/1.5 Menlo,Consolas,monospace;white-space:pre-wrap';
      el.textContent = 'Polymer failed to start:\n\n';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent += text + '\n\n';
  }
  window.addEventListener('error', function (e) {
    var err = e.error;
    show(err && err.stack ? err.stack : (e.message + ' (' + e.filename + ':' + e.lineno + ')'));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    show(r && r.stack ? r.stack : String(r));
  });
})();
