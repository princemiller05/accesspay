// Styles are imported here (not <link>ed) so Vite finds them in dev and production.
import '../fonts.ts';
import '../../src/styles/accesspay.css';
import '../demo.css';
import './docs.css';
// Show this server's real address in the code examples.
document.querySelectorAll('.base').forEach((el) => (el.textContent = location.origin));
