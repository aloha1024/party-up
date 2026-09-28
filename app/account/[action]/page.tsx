import { notFound } from "next/navigation";
import { UserAccount } from "@/components/user-account";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ action: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { action } = await params;
  if (action !== "login" && action !== "register" && action !== "recover")
    notFound();
  return <UserAccount mode={action} returnTo={(await searchParams).returnTo} />;
}
