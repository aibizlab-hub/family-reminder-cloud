/* ============================================================
   FAMILY REMINDER — ui.js
   Pure visual / UX enhancements ONLY.
   It never redefines any function from the inline app script and
   never touches a DOM id/class the app logic relies on.
   - Applies a sensible default theme (follows OS preference when
     the user hasn't chosen one) and keeps the toggle working.
   - Smooth cross-fade when switching light/dark.
   - ESC + backdrop tap close the open modal/confirm sheet.
   ============================================================ */
(function () {
  'use strict';

  var THEME_LS = 'dark-mode';
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');

  function metaTheme() {
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', document.body.classList.contains('dark-mode') ? '#15131b' : '#4f46e5');
  }

  // Apply OS preference only when the user hasn't explicitly chosen yet.
  function applyInitialTheme() {
    var stored = null;
    try { stored = localStorage.getItem(THEME_LS); } catch (e) {}
    if (stored === null && prefersDark && prefersDark.matches) {
      document.body.classList.add('dark-mode');
      try { localStorage.setItem(THEME_LS, 'true'); } catch (e) {}
    }
    metaTheme();
  }

  // Soft full-screen cross-fade so theme switches feel intentional.
  function playThemeFlash() {
    var flash = document.createElement('div');
    flash.setAttribute('aria-hidden', 'true');
    flash.style.cssText =
      'position:fixed;inset:0;z-index:9999;pointer-events:none;opacity:0;' +
      'transition:opacity .26s ease;';
    flash.style.background = document.body.classList.contains('dark-mode') ? '#15131b' : '#faf7f3';
    document.body.appendChild(flash);
    requestAnimationFrame(function () { flash.style.opacity = '0.55'; });
    setTimeout(function () { flash.style.opacity = '0'; }, 130);
    setTimeout(function () { if (flash.parentNode) flash.parentNode.removeChild(flash); }, 460);
  }

  function bindThemeToggle() {
    var btn = document.querySelector('[title="切換深色模式"]');
    if (!btn) return;
    btn.addEventListener('click', function () {
      // The inline toggleDarkMode() has already flipped the class by now.
      metaTheme();
      playThemeFlash();
    });
    // Keep meta color in sync if the class ever changes by other means.
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () { metaTheme(); });
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  }

  // Close any open sheet with ESC or a tap on the dimmed backdrop.
  function bindSheetDismiss() {
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (typeof closeModal === 'function') {
        closeModal('modal-reminder');
        closeModal('modal-birthday');
      }
      if (typeof closeConfirm === 'function') closeConfirm();
    });

    document.querySelectorAll('.modal-overlay, .confirm-overlay').forEach(function (ov) {
      ov.addEventListener('click', function (e) {
        if (e.target !== ov) return;            // tapped inside the sheet -> ignore
        if (ov.classList.contains('confirm-overlay')) {
          if (typeof closeConfirm === 'function') closeConfirm();
        } else if (typeof closeModal === 'function') {
          closeModal(ov.id);
        }
      });
    });
  }

  function init() {
    applyInitialTheme();
    bindThemeToggle();
    bindSheetDismiss();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
