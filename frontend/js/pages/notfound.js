/** Fallback page for unknown routes or insufficient permissions. */
import { card } from '../components/ui.js';

export function notFoundPage(path) {
  return {
    title: 'Page not found',
    subtitle: 'The requested view is unavailable',
    content: card({
      title: 'Nothing here',
      body: `<p style="color:var(--color-ink-soft)">No view is registered for <code>${String(path).replace(/[<>&"']/g, '')}</code>.</p>
             <p style="margin-top:8px"><a href="#/dashboard">Return to dashboard</a></p>`
    })
  };
}

export function forbiddenPage() {
  return {
    title: 'Access denied',
    subtitle: 'Insufficient permissions',
    content: card({
      title: 'Access denied',
      body: '<p style="color:var(--color-ink-soft)">Your role does not grant access to this view.</p>' +
            '<p style="margin-top:8px"><a href="#/dashboard">Return to dashboard</a></p>'
    })
  };
}
