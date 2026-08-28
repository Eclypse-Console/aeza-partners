import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

const CONSENT_LABEL =
  "I agree to allow AEZA to use our product catalog data (titles, descriptions, images, variants) to train AI models for styling and product discovery purposes on the AEZA platform.";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const brandProfile = await prisma.brandProfile.findUnique({
    where: { shop: session.shop },
  });

  return { brandProfile };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const aiTrainingConsent = formData.get("aiTrainingConsent") === "true";
  if (!aiTrainingConsent) {
    return {
      error: "You must agree to the data use terms before continuing.",
    };
  }

  const brandName = String(formData.get("brandName") ?? "").trim();
  const contactEmail = String(formData.get("contactEmail") ?? "").trim();
  const contactPhone = String(formData.get("contactPhone") ?? "").trim();

  if (!brandName || !contactEmail || !contactPhone) {
    return { error: "Please fill in all fields before continuing." };
  }

  const brandProfile = await prisma.brandProfile.create({
    data: {
      shop: session.shop,
      brandName,
      contactEmail,
      contactPhone,
      aiTrainingConsent: true,
      consentTimestamp: new Date(),
      status: "pending_review",
    },
  });

  return { brandProfile };
};

export default function Index() {
  const { brandProfile: existingProfile } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [brandName, setBrandName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const isSubmitting =
    fetcher.state === "submitting" || fetcher.state === "loading";

  const savedProfile =
    fetcher.data && "brandProfile" in fetcher.data
      ? fetcher.data.brandProfile
      : null;
  const serverError =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  const profile = savedProfile ?? existingProfile;

  const handleSubmit = () => {
    if (!consent) {
      setValidationError(
        "You must agree to the data use terms before continuing.",
      );
      return;
    }
    if (!brandName.trim() || !contactEmail.trim() || !contactPhone.trim()) {
      setValidationError("Please fill in all fields before continuing.");
      return;
    }
    setValidationError(null);
    fetcher.submit(
      {
        brandName,
        contactEmail,
        contactPhone,
        aiTrainingConsent: "true",
      },
      { method: "POST" },
    );
  };

  if (profile) {
    return (
      <s-page heading="AEZA">
        <s-section>
          <s-banner tone="success" heading="You're connected to AEZA">
            <s-paragraph>
              You're connected to AEZA, {profile.brandName}. Status:{" "}
              {profile.status}. We'll be in touch shortly.
            </s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  const displayedError = validationError ?? serverError;

  return (
    <s-page heading="Connect to AEZA">
      <s-section heading="Brand onboarding">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Tell us about your brand to finish connecting your store to AEZA.
          </s-paragraph>

          {displayedError && (
            <s-banner tone="critical" heading="Can't submit yet">
              <s-paragraph>{displayedError}</s-paragraph>
            </s-banner>
          )}

          <s-text-field
            label="Brand name"
            value={brandName}
            required
            disabled={isSubmitting}
            onInput={(event) => setBrandName(event.currentTarget.value)}
          />

          <s-email-field
            label="Contact email"
            value={contactEmail}
            required
            disabled={isSubmitting}
            onInput={(event) => setContactEmail(event.currentTarget.value)}
          />

          <s-text-field
            label="Contact phone"
            value={contactPhone}
            required
            disabled={isSubmitting}
            onInput={(event) => setContactPhone(event.currentTarget.value)}
          />

          <s-checkbox
            label={CONSENT_LABEL}
            checked={consent}
            required
            disabled={isSubmitting}
            onChange={(event) => setConsent(event.currentTarget.checked)}
          />

          <s-button
            variant="primary"
            disabled={isSubmitting}
            {...(isSubmitting ? { loading: true } : {})}
            onClick={handleSubmit}
          >
            Submit
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
