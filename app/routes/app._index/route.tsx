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

import { Step1Logo, Step2Intro, Step3Features, Step5Confirmation } from "./steps";
import styles from "./styles.module.css";

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

type ActionFetcher = ReturnType<typeof useFetcher<typeof action>>;

function Step4Form({ fetcher }: { fetcher: ActionFetcher }) {
  const [brandName, setBrandName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const isSubmitting =
    fetcher.state === "submitting" || fetcher.state === "loading";

  const serverError =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  const displayedError = validationError ?? serverError;

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

  return (
    <div className={styles.step}>
      <div className={styles.stepInner}>
        <h1 className={styles.headline}>Onboard your brand</h1>
        <div className={styles.formCard}>
          <s-stack direction="block" gap="base">
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

            <button
              type="button"
              className={styles.ctaButton}
              disabled={isSubmitting}
              onClick={handleSubmit}
            >
              {isSubmitting ? "Submitting…" : "Submit"}
            </button>
          </s-stack>
        </div>
      </div>
    </div>
  );
}

type WizardStep = 1 | 2 | 3 | 4 | 5;

export default function Index() {
  const { brandProfile } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [step, setStep] = useState<WizardStep>(brandProfile ? 5 : 1);

  const justSaved =
    fetcher.data && "brandProfile" in fetcher.data
      ? fetcher.data.brandProfile
      : null;

  useEffect(() => {
    if (justSaved) {
      setStep(5);
    }
  }, [justSaved]);

  switch (step) {
    case 1:
      return <Step1Logo onAdvance={() => setStep(2)} />;
    case 2:
      return <Step2Intro onAdvance={() => setStep(3)} />;
    case 3:
      return <Step3Features onAdvance={() => setStep(4)} />;
    case 4:
      return <Step4Form fetcher={fetcher} />;
    case 5:
    default:
      return <Step5Confirmation />;
  }
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
