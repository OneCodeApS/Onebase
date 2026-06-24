import { SettingsSubSidebar } from "./_components/SettingsSubSidebar";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <SettingsSubSidebar />
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}
