/**
 * Worker opcional para acessar o AquaGuard por um endereço gratuito workers.dev.
 * Crie a variável RENDER_ORIGIN com a URL do Render, sem barra no final.
 */
export default {
  async fetch(request, env) {
    if (!env.RENDER_ORIGIN) return new Response('RENDER_ORIGIN não configurada.', { status: 500 });
    const incoming = new URL(request.url);
    const origin = new URL(env.RENDER_ORIGIN);
    const target = new URL(incoming.pathname + incoming.search, origin);
    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Host', incoming.host);
    headers.set('X-Forwarded-Proto', 'https');
    const upstream = await fetch(new Request(target, {
      method: request.method,
      headers,
      body: ['GET','HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual'
    }));
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set('Cache-Control', incoming.pathname.startsWith('/api/') ? 'no-store' : (responseHeaders.get('Cache-Control') || 'no-cache'));
    const location = responseHeaders.get('Location');
    if (location && location.startsWith(origin.origin)) responseHeaders.set('Location', location.replace(origin.origin, incoming.origin));
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  }
};
