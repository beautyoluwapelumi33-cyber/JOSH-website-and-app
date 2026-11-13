/* JOSH — official public site configuration.
 *
 * PUBLIC_SITE_URL is the published website address. Every outbound link the
 * site produces (Share JOSH, canonical tag, Open Graph / Twitter cards, admin
 * "publish link" field) is built from this one value, so a shared link is
 * always the real public website and never a sandbox, localhost or preview
 * address.
 *
 * Change this single value if the public domain changes.
 */
window.JOSH_SITE = {
  name: 'JOSH',
  tagline: 'Watch. Create. Earn.',
  publicUrl: 'https://wypeqn7rsc.dev.onappjet.com',
  shareText: 'JOSH — watch, create and earn from your videos.',
  // Hosts that must never be treated as the permanent public link.
  blockedHostPattern: '^(localhost|127\\.\\d+\\.\\d+\\.\\d+|0\\.0\\.0\\.0|\\[::1\\]|.*\\.local)$'
};
