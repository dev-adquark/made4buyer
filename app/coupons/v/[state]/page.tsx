import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { decodeCouponsState } from "@/lib/public/listing-routes";
import { CouponsView, couponsMetadata } from "../../coupons-view";

/** /coupons?page=… (rewritten here by proxy.ts), cached per page (ISR, 5 minutes). */
export const revalidate = 300;

export function generateStaticParams(): Array<{ state: string }> {
  return [];
}

type Params = Promise<{ state: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const s = decodeCouponsState((await params).state);
  if (!s) return { title: "Page not found", robots: { index: false } };
  return couponsMetadata(s);
}

export default async function CouponsStatePage({ params }: { params: Params }) {
  const s = decodeCouponsState((await params).state);
  if (!s) notFound();
  return <CouponsView state={s} />;
}
