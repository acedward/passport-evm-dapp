// The MN Bank typefaces, SELF-HOSTED from the @fontsource packages (SIL Open Font License 1.1;
// the licence texts ship with the site under licenses/).
//
// Why not the Google Fonts CDN the mockup used: a request to fonts.googleapis.com hands every
// visitor's IP address to a third party before they have done anything (a German court found
// exactly that to breach the GDPR, LG München I, 3 O 17493/20, January 2022). The bank tells
// customers its servers keep nothing about them, so the page must not leak them to Google
// either. Self-hosting also keeps the site working under a strict CSP, offline, and in the
// browser tests, which refuse every request that leaves the page's own origin.
//
// Only the Latin subset is loaded (the UI is English); any other character falls back to the
// next font in the stack (Georgia / the system sans). font-display: swap, so text shows at once
// in the fallback and never waits for a font.
import '@fontsource/libre-caslon-text/latin-400.css';
import '@fontsource/libre-caslon-text/latin-700.css';
import '@fontsource/source-sans-3/latin-400.css';
import '@fontsource/source-sans-3/latin-400-italic.css';
import '@fontsource/source-sans-3/latin-600.css';
import '@fontsource/source-sans-3/latin-700.css';
