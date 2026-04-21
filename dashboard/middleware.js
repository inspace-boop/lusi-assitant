import { NextResponse } from 'next/server';

export function middleware(request) {
  const { pathname } = request.nextUrl;
  const password = process.env.LUSI_ACCESS_PASSWORD;

  // 1. If no password is set, allow everything (useful for setup/local dev)
  if (!password) {
    return NextResponse.next();
  }

  // 2. Check for the auth cookie
  const authCookie = request.cookies.get('lusi_auth');
  const isAuthenticated = authCookie?.value === password;

  // 3. Define the login route
  const isLoginPage = pathname === '/login';

  // 4. Redirect logic
  if (!isAuthenticated && !isLoginPage) {
    // Not logged in and not on login page -> Send to login
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthenticated && isLoginPage) {
    // Already logged in but trying to go to login -> Send home
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

// Ensure the middleware doesn't run on static files or the favicon
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
};
