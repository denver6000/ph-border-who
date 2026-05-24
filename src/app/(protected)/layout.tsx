import { AppTopBar } from "@/components/app-top-bar";

export default function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      <AppTopBar />
      <main className="app-main">{children}</main>
    </>
  );
}
