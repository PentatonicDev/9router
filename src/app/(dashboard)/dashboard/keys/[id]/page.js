import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import KeyAccountsClient from "./KeyAccountsClient";

export default async function KeyDetailPage({ params }) {
  const { id } = await params;
  return (
    <Suspense fallback={<CardSkeleton />}>
      <KeyAccountsClient keyId={id} />
    </Suspense>
  );
}
