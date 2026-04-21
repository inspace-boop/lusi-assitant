import { NextResponse } from 'next/server';

export function middleware(request) {
  // Only protect the root route or api routes
  const password = process.env.LUSI_ACCESS_PASSWORD;
  
  // If no password configured, bypass for local dev
  if (!password) {
    return NextResponse.next();
  }

  // Check cookie
  const authCookie = request.cookies.get('lusi_auth');
  
  const isAuthRoute = request.nextUrl.pathname === '/login';
  
  if (authCookie?.value === password) {
    if (isAuthRoute) {
      return NextResponse.redirect(new URL('/', request.url));
    }
    return NextResponse.next();
  }

  // Allow API routes to be protected (returns 401)
  if (request.nextUrl.pathname.startsWith('/api/') && request.nextUrl.pathname !== '/api/auth') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Redirect to login if not authenticated
  if (!isAuthRoute && !request.nextUrl.pathname.startsWith('/_next') && !request.nextUrl.pathname.startsWith('/api')) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
