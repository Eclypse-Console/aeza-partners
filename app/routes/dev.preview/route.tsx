import { useState } from "react";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import {
  ScreenA,
  ScreenB,
  ScreenC,
  type DashboardProduct,
} from "../app._index/steps";
import onboardingStyles from "../app._index/styles.module.css";
import styles from "./styles.module.css";

// Local-only preview of the onboarding wizard's UI — no Shopify install,
// OAuth, or database required. Renders the exact same screen components as
// the real embedded route. Never reachable once deployed.
export const loader = async () => {
  if (process.env.NODE_ENV === "production") {
    throw new Response("Not Found", { status: 404 });
  }
  return null;
};

type OnboardingScreen = "A" | "B" | "C";

// Static sample catalog so the dashboard can be previewed without a store.
// Toggles here will POST to /app/products/toggle and fail (no session) —
// the preview is for layout only.
const MOCK_PRODUCTS: DashboardProduct[] = [
  {
    id: "gid://shopify/Product/1",
    title: "Sample tee",
    status: "ACTIVE",
    imageUrl: null,
    published: true,
    syncStatus: "recorded",
  },
  {
    id: "gid://shopify/Product/2",
    title: "Sample hoodie",
    status: "ACTIVE",
    imageUrl: null,
    published: false,
    syncStatus: "idle",
  },
  {
    id: "gid://shopify/Product/3",
    title: "Sample cap",
    status: "DRAFT",
    imageUrl: null,
    published: true,
    syncStatus: "error",
  },
];

export default function DevPreview() {
  const [screen, setScreen] = useState<OnboardingScreen>("A");
  const [mockSubmitting, setMockSubmitting] = useState(false);

  const jumpTo = (target: OnboardingScreen) => {
    setMockSubmitting(false);
    setScreen(target);
  };

  return (
    <AppProvider embedded={false}>
      <div className={styles.toolbar}>
        <span className={styles.toolbarLabel}>Preview screen:</span>
        {(["A", "B", "C"] as OnboardingScreen[]).map((s) => (
          <button
            key={s}
            type="button"
            className={
              s === screen
                ? `${styles.toolbarButton} ${styles.toolbarButtonActive}`
                : styles.toolbarButton
            }
            onClick={() => jumpTo(s)}
          >
            {s}
          </button>
        ))}
      </div>

      <div className={onboardingStyles.onboardingWrapper}>
        {screen === "A" && <ScreenA onAdvance={() => jumpTo("B")} />}
        {screen === "B" && (
          <ScreenB
            isSubmitting={mockSubmitting}
            error={null}
            onSubmit={() => {
              // No backend here — just simulates the real submit/success
              // timing so the transition into Screen C can be previewed.
              setMockSubmitting(true);
              setTimeout(() => jumpTo("C"), 500);
            }}
          />
        )}
        {screen === "C" && (
          <ScreenC
            brandName="Preview Brand"
            initialProducts={MOCK_PRODUCTS}
            initialPageInfo={{ hasNextPage: false, endCursor: null }}
            productsError={null}
          />
        )}
      </div>
    </AppProvider>
  );
}
