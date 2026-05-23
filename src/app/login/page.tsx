import { LoginPage } from "@/components/login-page";

export default async function LoginRoute({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const nextPath = typeof params.next === "string" && params.next.startsWith("/") ? params.next : "/";

  return <LoginPage nextPath={nextPath} />;
}
