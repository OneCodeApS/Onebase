import { redirect } from "next/navigation";

// /admin/settings has no content of its own — it lands on the first category.
export default function SettingsIndex() {
  redirect("/admin/settings/api");
}
