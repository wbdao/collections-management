/** Hash-based router with path params and simple guards. */

let routes = [];
let notFoundHandler = null;
let current = null;

function compile(pattern) {
  const parts = pattern.split('/').filter(Boolean);
  return parts.map((part) => part.startsWith(':') ? { name: part.slice(1) } : { literal: part });
}

function resolve(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.parts.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < route.parts.length; i++) {
      const part = route.parts[i];
      if (part.name) params[part.name] = decodeURIComponent(segments[i]);
      else if (part.literal !== segments[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

export function defineRoutes(definitions) {
  routes = definitions.map((definition) => ({
    ...definition,
    parts: compile(definition.path)
  }));
}

export function setNotFound(handler) {
  notFoundHandler = handler;
}

export function currentPath() {
  return (location.hash || '#/').slice(1).split('?')[0] || '/';
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path.startsWith('/') ? path : `/${path}`}`;
  if (location.hash === target) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  if (replace) location.replace(target);
  else location.hash = target;
}

export function href(path) {
  return `#${path.startsWith('/') ? path : `/${path}`}`;
}

/** Registers the hashchange listener and renders the initial route. */
export function start(render) {
  const onRoute = async () => {
    const path = currentPath();
    const match = resolve(path);
    current = { path, match };
    if (match) await render(match.route, match.params, path);
    else if (notFoundHandler) await notFoundHandler(path);
  };
  window.addEventListener('hashchange', onRoute);
  return onRoute();
}

export function getCurrent() {
  return current;
}
