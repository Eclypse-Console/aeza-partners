import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../../db.server";
import { fetchShopifyProducts, mergeWithPublishState } from "../../models/products.server";

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
    products: [] as Awaited<ReturnType<typeof mergeWithPublishState>>,
    pageInfo: { hasNextPage: false, endCursor: null as string | null },
    productsError: null as string | null,
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
  // the whole page — the dashboard still renders with a clear "couldn't
  // load, try again" state instead of a hard error boundary.
  try {
    const { products, pageInfo } = await fetchShopifyProducts(admin, {
      first: 25,
    });
    const merged = await mergeWithPublishState(session.shop, products);
    return { brandProfile, products: merged, pageInfo, productsError: null };
  } catch (error) {
    console.error("Failed to load products for dashboard:", error);
    return {
      brandProfile,
      products: [],
      pageInfo: { hasNextPage: false, endCursor: null },
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
  const { brandProfile, products, pageInfo, productsError } =
    useLoaderData<typeof loader>();
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

  useEffect(() => {
    if (justSaved) {
      setScreen("C");
    }
  }, [justSaved]);

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
          productsError={productsError}
        />
      )}
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
