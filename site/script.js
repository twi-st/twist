/*
 * Landing page behaviour. Kept tiny on purpose: the page is static, and the only
 * thing worth scripting is pointing the download buttons at the actual latest
 * release instead of a hardcoded version.
 */

(() => {
  const REPO = 'twistied/twist';
  const API = `https://api.github.com/repos/${REPO}/releases/latest`;

  // Fill in the repository links from one place, so renaming the repo only
  // means editing REPO above and the matching URLs in the markup.
  const apply = (url) => {
    for (const id of ['download', 'download-top']) {
      const el = document.getElementById(id);
      if (el) el.href = url;
    }
  };

  fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
    .then((response) => (response.ok ? response.json() : null))
    .then((release) => {
      if (!release) return;
      apply(release.html_url);

      // Show the version next to the button when it is known.
      const label = document.querySelector('.fineprint');
      if (label && release.tag_name) {
        label.textContent = `Latest release ${release.tag_name} · Free and open source · MIT licensed`;
      }
    })
    .catch(() => {
      // No network or rate-limited: the markup already points at /releases/latest.
    });
})();
