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

import { ScreenA, ScreenB, ScreenC } from "./steps";
import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const resetOnboarding =
    process.env.NODE_ENV === "development" &&
    url.searchParams.get("resetOnboarding") === "true";

  if (resetOnboarding) {
    return { brandProfile: null };
  }

  const brandProfile = await prisma.brandProfile.findUnique({
    where: { shop: session.shop },
  });

  return { brandProfile };
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

  const brandProfile = await prisma.brandProfile.create({
    data: {
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
  const { brandProfile } = useLoaderData<typeof loader>();
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
      {screen === "C" && <ScreenC />}
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
