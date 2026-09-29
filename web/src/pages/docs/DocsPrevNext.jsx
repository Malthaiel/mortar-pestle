// Prev/next navigation at the bottom of every docs page. Walks the flattened
// manifest order across categories.

import { navigate } from '../../router.js';
import { IconArrowLeft, IconArrowRight } from '../../components/icons.jsx';

export default function DocsPrevNext({ prev, next, accent }) {
  if (!prev && !next) return null;
  return (
    <div className="docs-prev-next">
      {prev ? (
        <button
          type="button"
          className="docs-pn-card docs-pn-prev"
          onClick={() => navigate(`/docs/${prev.category.id}/${prev.id}`)}
        >
          <span className="docs-pn-direction"><IconArrowLeft size="1.3em"/> Previous</span>
          <span className="docs-pn-cat" style={{ color: accent }}>{prev.category.label}</span>
          <span className="docs-pn-title">{prev.title}</span>
        </button>
      ) : <span className="docs-pn-spacer"/>}
      {next ? (
        <button
          type="button"
          className="docs-pn-card docs-pn-next"
          onClick={() => navigate(`/docs/${next.category.id}/${next.id}`)}
        >
          <span className="docs-pn-direction">Next <IconArrowRight size="1.3em"/></span>
          <span className="docs-pn-cat" style={{ color: accent }}>{next.category.label}</span>
          <span className="docs-pn-title">{next.title}</span>
        </button>
      ) : <span className="docs-pn-spacer"/>}
    </div>
  );
}
