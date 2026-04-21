import { NextResponse } from 'next/server';

export async function POST(request) {
  try {
    const { password } = await request.json();
    const correctPassword = process.env.LUSI_ACCESS_PASSWORD;

    if (!correctPassword) {
      // Local dev bypass if env var not set
      const response = NextResponse.json({ success: true });
      response.cookies.set('lusi_auth', 'bypass', { path: '/' });
      return response;
    }

    if (password === correctPassword) {
      const response = NextResponse.json({ success: true });
      // Set simple cookie
      response.cookies.set('lusi_auth', password, { 
        path: '/', 
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 60 * 24 * 30 // 30 days
      });
      return response;
    }

    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
