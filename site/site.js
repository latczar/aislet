// Aislet website: two small enhancements. The page works fully without them.

// The demo plays while it's on screen, unless the visitor has asked for less motion; then it stays
// on its last frame (the finished reply) with controls to play it by hand.
const demo = document.querySelector('video.shot__media');
if (demo) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    demo.controls = true;
  } else {
    new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) demo.play().catch(() => { demo.controls = true; });
        else demo.pause();
      }
    }, { threshold: 0.3 }).observe(demo);
  }
}

// Copy buttons for commands. Hidden in the HTML, shown only where the clipboard is available.
for (const button of document.querySelectorAll('[data-copy]')) {
  if (!navigator.clipboard) continue;
  button.hidden = false;
  button.addEventListener('click', async () => {
    const text = document.getElementById(button.dataset.copy).textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select and copy';
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 2000);
  });
}
