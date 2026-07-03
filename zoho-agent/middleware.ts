import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";

function unauthorizedApi() {
  return NextResponse.json({ error: "Authentication required." }, { status: 401 });
}

export async function middleware(request: NextRequest) {
  const url = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const isApi = request.nextUrl.pathname.startsWith("/api/");

  if (!url || !key) {
    if (isApi) return unauthorizedApi();
    return NextResponse.redirect(new URL("/login", request.url));
  }

  let response = NextResponse.next({
    request
  });

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      }
    }
  });

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    if (isApi) return unauthorizedApi();
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/records/:path*",
    "/imports/:path*",
    "/run/:path*",
    "/runs/:path*",
    "/settings/:path*",
    "/admin/:path*",
    "/api/:path*"
  ]
};
