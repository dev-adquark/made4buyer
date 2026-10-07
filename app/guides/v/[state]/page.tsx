import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { decodeGuidesState } from "@/lib/public/listing-routes";
import { GuidesView, guidesMetadata } from "../../guides-view";

/** /guides?page=… (rewritten here by proxy.ts), cached per page (ISR, 5 minutes, purged on publish). */
export const revalidate = 300;

export function generateStaticParams(): Array<{ state: string }> {
  return [];
}

type Params = Promise<{ state: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const s = decodeGuidesState((await params).state);
  if (!s) return { title: "Page not found", robots: { index: false } };
  return guidesMetadata(s);
}

export default async function GuidesStatePage({ params }: { params: Params }) {
  const s = decodeGuidesState((await params).state);
  if (!s) notFound();
  return <GuidesView state={s} />;
}
