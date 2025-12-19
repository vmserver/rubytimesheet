;(function(){
  var key = 'theme';
  function setBusy(el, busy){ try { if (!el) return; el.setAttribute('aria-busy', busy ? 'true' : 'false'); } catch(_) {} }
  function applyTheme(){
    try {
      var saved = localStorage.getItem(key) || 'light';
      var prefersDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      var resolved = saved === 'system' ? (prefersDark ? 'dark' : 'light') : saved;
      var root = document.documentElement;
      var body = document.body;
      ['dark'].forEach(function(cls){
        try { root.classList.remove(cls); body && body.classList.remove(cls); } catch(_) {}
      });
      if (resolved !== 'dark' && resolved !== 'light') { resolved = 'light'; }
      if (resolved === 'dark') { try { root.classList.add('dark'); body && body.classList.add('dark'); } catch(_) {} }
      var radios = document.querySelectorAll('[data-theme-option]');
      radios.forEach(function(it){
        var opt = it.getAttribute('data-theme-option');
        try { it.setAttribute('aria-checked', opt === saved ? 'true' : 'false'); } catch(_) {}
      });
    } catch(_) {}
  }
  function getSavedTheme(){ try { return localStorage.getItem(key) || 'light'; } catch(_) { return 'light'; } }
  function setTheme(option){
    try { localStorage.setItem(key, option); } catch(_) {}
    applyTheme();
  }
  function toggleTheme(){
    var cur = getSavedTheme();
    var next = cur === 'dark' ? 'light' : 'dark';
    setTheme(next);
  }
  function closeMenu(){
    var panel = document.getElementById('user-menu-panel');
    var trigger = document.getElementById('user-menu-trigger');
    if (!panel || !trigger) return;
    setBusy(panel, true);
    try {
      var ae = document.activeElement;
      if (ae && panel.contains(ae)) { trigger.focus(); }
    } catch(_) {}
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden','true');
    panel.setAttribute('inert','');
    trigger.setAttribute('aria-expanded','false');
    trigger.setAttribute('aria-pressed','false');
    setBusy(panel, false);
  }
  function openMenu(){
    var panel = document.getElementById('user-menu-panel');
    var trigger = document.getElementById('user-menu-trigger');
    if (!panel || !trigger) return;
    setBusy(panel, true);
    panel.removeAttribute('inert');
    panel.classList.add('open');
    panel.setAttribute('aria-hidden','false');
    trigger.setAttribute('aria-expanded','true');
    trigger.setAttribute('aria-pressed','true');
    var focusable = panel.querySelector('button, a, input');
    if (focusable) try { focusable.focus(); } catch(_) {}
    setBusy(panel, false);
  }
  function toggleMenu(){
    var panel = document.getElementById('user-menu-panel');
    if (!panel) return;
    if (panel.classList.contains('open')) closeMenu(); else openMenu();
  }
  function init(){
    applyTheme();
    var trigger = document.getElementById('user-menu-trigger');
    var panel = document.getElementById('user-menu-panel');
    if (trigger && panel) {
      try {
        trigger.addEventListener('click', function(e){ e.stopPropagation(); toggleMenu(); });
        var options = panel.querySelectorAll('[data-theme-option]');
        options.forEach(function(btn){
          btn.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); var opt = btn.getAttribute('data-theme-option'); if (opt) setTheme(opt); });
          btn.addEventListener('keydown', function(e){ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); var opt = btn.getAttribute('data-theme-option'); if (opt) setTheme(opt); } });
        });
      } catch(_) {}
    }
    document.addEventListener('click', function(e){
      var p = document.getElementById('user-menu-panel');
      var t = document.getElementById('user-menu-trigger');
      if (!p || !t) return;
      if (!p.classList.contains('open')) return;
      var insidePanel = p.contains(e.target);
      var insideTrigger = t.contains(e.target);
      if (!insidePanel && !insideTrigger) closeMenu();
    }, { passive: true });
    document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeMenu(); });
    window.UserMenu = { init: init, toggle: toggleMenu, open: openMenu, close: closeMenu, toggleTheme: toggleTheme, applyTheme: applyTheme, setTheme: setTheme };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
