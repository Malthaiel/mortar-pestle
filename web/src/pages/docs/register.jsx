// Registers the Docs page's left-sidebar content (the category → entry tree)
// with the route-keyed page-sidebar registry. Imported for its side effect
// from main.jsx so it runs once at module load, before first render — the
// host analogue of how modules self-register via the module loader.

import DocsNav from './DocsNav.jsx';
import { registerPageSidebar } from '../../module-sdk/registry.js';

registerPageSidebar('docs', {
  label: 'Docs',
  renderSecondary: ({ route, accent }) => <DocsNav route={route} accent={accent} />,
});
