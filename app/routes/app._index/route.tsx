import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../../db.server";
import {
  fetchCollections,
  fetchShopifyProducts,
  getProductCounts,
  mergeWithPublishState,
} from "../../models/products.server";
import type {
  DashboardProduct,
  ProductCounts,
  ShopifyCollection,
} from "../../models/products.server";

import { ScreenA, ScreenB, ScreenC } from "./steps";
import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const resetOnboarding =
    process.env.NODE_ENV === "development" &&
    url.searchParams.get("resetOnboarding") === "true";

  const empty = {
    brandProfile: null,
    products: [] as DashboardProduct[],
    pageInfo: { hasNextPage: false, endCursor: null as string | null },
    productsError: null as string | null,
    collections: [] as ShopifyCollection[],
    counts: { published: 0, total: null } as ProductCounts,
  };

  if (resetOnboarding) {
    return empty;
  }

  const brandProfile = await prisma.brandProfile.findUnique({
    where: { shop: session.shop },
  });

  if (!brandProfile) {
    return { ...empty, brandProfile: null };
  }

  // A brand only needs its product list once onboarding is complete, and a
  // hiccup fetching it (Shopify API hiccup, rate limit) shouldn't take down
  // the whole page, the dashboard still renders with a clear "couldn't
  // load, try again" state instead of a hard error boundary.
  try {
    const [{ products, pageInfo }, counts, collections] = await Promise.all([
      fetchShopifyProducts(admin, { first: 25 }),
      getProductCounts(admin, session.shop),
      // Collections only power the filter dropdown, so a failure here
      // should never block the dashboard, it just renders without it.
      fetchCollections(admin).catch((error) => {
        console.error("Failed to load collections:", error);
        return [] as ShopifyCollection[];
      }),
    ]);
    const merged = await mergeWithPublishState(session.shop, products);
    return {
      brandProfile,
      products: merged,
      pageInfo,
      productsError: null as string | null,
      collections,
      counts,
    };
  } catch (error) {
    console.error("Failed to load products for dashboard:", error);
    return {
      ...empty,
      brandProfile,
      productsError:
        "Couldn't load your products from Shopify. Refresh to try again.",
    };
  }
};

function normalizeWebsiteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const brandName = String(formData.get("brandName") ?? "").trim();
  const contactEmail = String(formData.get("contactEmail") ?? "").trim();
  const contactPhone = String(formData.get("contactPhone") ?? "").trim();
  const websiteUrl = normalizeWebsiteUrl(
    String(formData.get("websiteUrl") ?? ""),
  );
  const category = String(formData.get("category") ?? "").trim();

  if (
    !brandName ||
    !contactEmail ||
    !contactPhone ||
    !websiteUrl ||
    !category
  ) {
    return { error: "Please fill in all fields before continuing." };
  }

  const brandProfile = await prisma.brandProfile.upsert({
    where: { shop: session.shop },
    update: {
      brandName,
      contactEmail,
      contactPhone,
      websiteUrl,
      category,
    },
    create: {
      shop: session.shop,
      brandName,
      contactEmail,
      contactPhone,
      websiteUrl,
      category,
      status: "pending_review",
    },
  });

  return { brandProfile };
};

type OnboardingScreen = "A" | "B" | "C";

export default function Index() {
  const {
    brandProfile,
    products,
    pageInfo,
    productsError,
    collections,
    counts,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [screen, setScreen] = useState<OnboardingScreen>(
    brandProfile ? "C" : "A",
  );

  const isSubmitting =
    fetcher.state === "submitting" || fetcher.state === "loading";
  const justSaved =
    fetcher.data && "brandProfile" in fetcher.data
      ? fetcher.data.brandProfile
      : null;
  const serverError =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  // Wait for the save AND the loader revalidation that follows it to finish
  // before showing the dashboard, so it mounts with the freshly loaded
  // products rather than the empty list from before onboarding.
  useEffect(() => {
    if (justSaved && !isSubmitting) {
      setScreen("C");
    }
  }, [justSaved, isSubmitting]);

  return (
    <div className={styles.onboardingWrapper}>
      {screen === "A" && <ScreenA onAdvance={() => setScreen("B")} />}
      {screen === "B" && (
        <ScreenB
          isSubmitting={isSubmitting}
          error={serverError}
          onSubmit={(data) => fetcher.submit(data, { method: "POST" })}
        />
      )}
      {screen === "C" && (
        <ScreenC
          brandName={
            justSaved && "brandName" in justSaved
              ? justSaved.brandName
              : (brandProfile?.brandName ?? "")
          }
          initialProducts={products}
          initialPageInfo={pageInfo}
          initialCounts={counts}
          collections={collections}
          productsError={productsError}
        />
      )}
    </div>
  );
}

// The dashboard's toggles, bulk actions and pagination post/load against the
// /app/products/* resource routes and keep their own state. By default React
// Router would re-run this page's loader (several Shopify calls) after every
// one of those actions, skip that, but still revalidate for this route's own
// onboarding form submission.
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formAction,
  defaultShouldRevalidate,
}) => {
  if (formAction?.startsWith("/app/products/")) return false;
  return defaultShouldRevalidate;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
