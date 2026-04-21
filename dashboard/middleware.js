import { NextResponse } from 'next/server';

export function middleware(request) {
  const { pathname } = request.nextUrl;
  
  // Skip auth for API routes and static assets
  if (pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  const password = process.env.LUSI_ACCESS_PASSWORD;
  
  // If no password set, allow through
  if (!password) return NextResponse.next();

  // Check auth cookie
  const authCookie = request.cookies.get('lusi_auth');
  if (authCookie?.value === password) {
    if (pathname === '/login') {
      return NextResponse.redirect(new URL('/', request.url));
    }
    return NextResponse.next();
  }

  // Redirect to login if not authenticated
  if (pathname !== '/login') {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)']
};
