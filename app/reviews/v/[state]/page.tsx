import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { decodeReviewsState } from "@/lib/public/listing-routes";
import { ReviewsView, reviewsMetadata } from "../../reviews-view";

/** /reviews?type=…&page=… (rewritten here by proxy.ts), cached per normalized state (ISR, 5 minutes, purged on publish). */
export const revalidate = 300;

export function generateStaticParams(): Array<{ state: string }> {
  return [];
}

type Params = Promise<{ state: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const s = decodeReviewsState((await params).state);
  if (!s) return { title: "Page not found", robots: { index: false } };
  return reviewsMetadata(s);
}

export default async function ReviewsStatePage({ params }: { params: Params }) {
  const s = decodeReviewsState((await params).state);
  if (!s) notFound();
  return <ReviewsView state={s} />;
}
