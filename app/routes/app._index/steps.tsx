import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type { IPlayerProps } from "@lottiefiles/react-lottie-player";

import logoVideoUrl from "../../assets/aeza-logo-animation/aeza-logo-reveal-transparent.webm";
import aezaShopLottieUrl from "../../assets/lottie-jsons/Aeza-Shop.json?url";
import aezaSizeLottieUrl from "../../assets/lottie-jsons/Aeza-Size.json?url";
import styles from "./styles.module.css";

const CONSENT_LABEL =
  "I agree to allow AEZA to use our product catalog data (titles, descriptions, images, variants) to train AI models for styling and product discovery purposes on the AEZA platform.";

// Module-level caches so the Lottie player module and each animation's JSON
// are only ever fetched once, no matter how many components ask for them.
// preloadScreenBAnimations() is kicked off while Screen A is still showing
// (video + intro), so by the time Screen B mounts the data is already in
// memory and playback can start immediately instead of waiting on a fetch.
type LottiePlayerModule = typeof import("@lottiefiles/react-lottie-player");
let lottiePlayerPromise: Promise<LottiePlayerModule> | null = null;

function preloadLottiePlayer() {
  if (!lottiePlayerPromise) {
    lottiePlayerPromise = import("@lottiefiles/react-lottie-player");
  }
  return lottiePlayerPromise;
}

const lottieDataCache = new Map<string, Promise<object>>();

function preloadLottieData(url: string) {
  let cached = lottieDataCache.get(url);
  if (!cached) {
    cached = fetch(url).then((response) => response.json());
    lottieDataCache.set(url, cached);
  }
  return cached;
}

function preloadScreenBAnimations() {
  preloadLottiePlayer();
  preloadLottieData(aezaShopLottieUrl);
  preloadLottieData(aezaSizeLottieUrl);
}

// ---------- Screen A: animation + intro, in-place crossfade ----------

export function ScreenA({ onAdvance }: { onAdvance: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showIntro, setShowIntro] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  const revealIntro = () => setShowIntro(true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // autoPlay's success/failure isn't observable, so play() is called
    // manually to catch a browser-blocked autoplay and reveal the fallback.
    video.play().catch(() => setAutoplayBlocked(true));
    // Screen B is always next, so start warming its Lottie animations now.
    preloadScreenBAnimations();
  }, []);

  return (
    <div className={styles.screenAStage}>
      <div
        className={`${styles.screenALayer} ${showIntro ? styles.screenALayerHidden : styles.screenALayerVisible}`}
      >
        <div className={styles.step1VideoFrame}>
          <video
            ref={videoRef}
            className={styles.step1Video}
            src={logoVideoUrl}
            muted
            playsInline
            onEnded={revealIntro}
          />
        </div>
        <button
          type="button"
          className={`${styles.step1Continue} ${autoplayBlocked ? styles.step1ContinueVisible : ""}`}
          disabled={!autoplayBlocked}
          aria-hidden={!autoplayBlocked}
          onClick={revealIntro}
        >
          Continue
        </button>
      </div>

      <div
        className={`${styles.screenALayer} ${showIntro ? styles.screenALayerVisible : styles.screenALayerHidden}`}
      >
        <div className={styles.stepInner}>
          <div className={styles.introLogo}>
            <svg
              className={styles.introSparkle}
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M12 2 14.1 9.4 21.5 11.5 14.1 13.6 12 21 9.9 13.6 2.5 11.5 9.9 9.4 12 2Z"
                fill="var(--aeza-green)"
              />
            </svg>
            <span className={styles.introLogoText}>aeza</span>
          </div>
          <p className={styles.introTagline}>Aeza for Shopify brands</p>
          <h1 className={styles.headline}>
            Put your catalog in front of India&apos;s{" "}
            <span className={styles.accentGreen}>AI stylist</span> marketplace
          </h1>
          <p className={styles.body}>
            Sync your Shopify products to Aeza and reach shoppers through
            conversational styling, virtual try-on and true-to-brand sizing.
          </p>
          <div className={styles.introBadges}>
            <span className={styles.introBadge}>
              <span className={styles.introBadgeDot} />
              AI stylist
            </span>
            <span className={styles.introBadge}>
              <span className={styles.introBadgeDot} />
              Virtual try-on
            </span>
            <span className={styles.introBadge}>
              <span className={styles.introBadgeDot} />
              Dynamic sizing
            </span>
          </div>
          <button type="button" className={styles.ctaButton} onClick={onAdvance}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Screen B: zigzag feature rows + form, one scroll ----------

// lottie-web (a dependency of @lottiefiles/react-lottie-player) touches the
// `document` global as soon as its module is evaluated, which crashes React
// Router's server render. Loading it via a dynamic import inside useEffect
// keeps it out of the SSR bundle entirely — it only ever loads in the browser.
//
// Both the player module and the animation JSON are pulled from the shared
// preload caches (warmed during Screen A) rather than fetched fresh here, and
// the parsed JSON object is passed as `src` instead of a URL so Player never
// has to do its own fetch — by the time this mounts, playback can start on
// the very first frame with no visible delay.
function LottieVisual({ src }: { src: string }) {
  const [ready, setReady] = useState<{
    Player: ComponentType<IPlayerProps>;
    data: object;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([preloadLottiePlayer(), preloadLottieData(src)]).then(
      ([playerModule, data]) => {
        if (!cancelled) setReady({ Player: playerModule.Player, data });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (!ready) return null;

  const { Player, data } = ready;
  return (
    <Player src={data} autoplay loop style={{ width: "100%", height: "100%" }} />
  );
}

function CameraPlaceholderIcon() {
  return (
    <svg
      className={styles.placeholderIcon}
      width="56"
      height="56"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function FieldIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      className={styles.fieldIcon}
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const BrandIcon = () => (
  <FieldIcon>
    <path d="M20.59 13.41 12 22 2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
    <circle cx="7" cy="7" r="1.5" />
  </FieldIcon>
);

const EmailIcon = () => (
  <FieldIcon>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </FieldIcon>
);

const PhoneIcon = () => (
  <FieldIcon>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92Z" />
  </FieldIcon>
);

const WebsiteIcon = () => (
  <FieldIcon>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9S9.6 5.6 12 3Z" />
  </FieldIcon>
);

const CategoryIcon = () => (
  <FieldIcon>
    <path d="M20.59 13.41 12 22 2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
    <circle cx="7" cy="7" r="1.5" />
  </FieldIcon>
);

type FeatureVisual = { type: "lottie"; src: string } | { type: "icon" };

function FeatureRow({
  title,
  description,
  visual,
  reversed,
}: {
  title: string;
  description: ReactNode;
  visual: FeatureVisual;
  reversed?: boolean;
}) {
  return (
    <div
      className={
        reversed
          ? `${styles.featureRow} ${styles.featureRowReversed}`
          : styles.featureRow
      }
    >
      <div className={styles.featureRowMedia}>
        <div className={styles.featureMediaCard}>
          {visual.type === "lottie" ? (
            <LottieVisual src={visual.src} />
          ) : (
            <CameraPlaceholderIcon />
          )}
        </div>
      </div>
      <div className={styles.featureRowText}>
        <h3 className={styles.featureTitle}>{title}</h3>
        <p className={styles.featureDescription}>{description}</p>
      </div>
    </div>
  );
}

const FASHION_CATEGORIES = [
  "Women's Apparel",
  "Men's Apparel",
  "Kidswear",
  "Footwear",
  "Bags & Accessories",
  "Jewelry & Watches",
  "Eyewear",
  "Activewear & Athleisure",
  "Ethnic & Festive Wear",
  "Lingerie & Innerwear",
  "Beauty & Personal Care",
  "Other",
];

export function ScreenB({
  isSubmitting,
  error,
  onSubmit,
}: {
  isSubmitting: boolean;
  error?: string | null;
  onSubmit: (data: {
    brandName: string;
    contactEmail: string;
    contactPhone: string;
    websiteUrl: string;
    category: string;
  }) => void;
}) {
  const [brandName, setBrandName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [category, setCategory] = useState("");
  const [consent, setConsent] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const displayedError = validationError ?? error;

  const handleSubmit = () => {
    if (!consent) {
      setValidationError(
        "You must agree to the data use terms before continuing.",
      );
      return;
    }
    if (
      !brandName.trim() ||
      !contactEmail.trim() ||
      !contactPhone.trim() ||
      !websiteUrl.trim() ||
      !category
    ) {
      setValidationError("Please fill in all fields before continuing.");
      return;
    }
    setValidationError(null);
    onSubmit({ brandName, contactEmail, contactPhone, websiteUrl, category });
  };

  return (
    <div className={styles.screenB}>
      <FeatureRow
        title="AI Stylist"
        description={
          <>
            Turn conversation into sales. Aeza&apos;s AI stylist recommends
            outfits straight from your catalog, so shoppers discover more of
            what you sell driving{" "}
            <span className={styles.accentGreen}>higher order value</span>{" "}
            and <span className={styles.accentGreen}>repeat visits</span>.
          </>
        }
        visual={{ type: "lottie", src: aezaShopLottieUrl }}
      />
      <FeatureRow
        title="Virtual Try-On"
        description={
          <>
            Let shoppers see it before they buy it. Aeza renders your
            products on real bodies, building the confidence that leads to
            checkout{" "}
            <span className={styles.accentGreen}>fewer size returns</span>{" "}
            and{" "}
            <span className={styles.accentGreen}>stronger margins</span> on
            every order.
          </>
        }
        visual={{ type: "icon" }}
        reversed
      />
      <FeatureRow
        title="Dynamic Sizing"
        description={
          <>
            Every brand fits differently generic charts don&apos;t work.
            Aeza learns your true fit and matches every shopper to it, so
            you get{" "}
            <span className={styles.accentGreen}>fewer wrong-size orders</span>{" "}
            and shoppers who trust you enough to{" "}
            <span className={styles.accentGreen}>buy again</span>.
          </>
        }
        visual={{ type: "lottie", src: aezaSizeLottieUrl }}
      />

      <div className={styles.formCard}>
        <div className={styles.formHeader}>
          <h2 className={styles.formHeading}>Onboard your brand</h2>
          <p className={styles.formSubheading}>
            Takes less than a minute we&apos;ll review and follow up by
            email.
          </p>
        </div>

        {displayedError && (
          <div className={styles.errorBanner}>{displayedError}</div>
        )}

        <div className={styles.darkFieldGroup}>
          <label className={styles.darkLabel} htmlFor="brandName">
            Brand name
          </label>
          <div className={styles.inputWithIcon}>
            <BrandIcon />
            <input
              id="brandName"
              className={styles.darkInput}
              type="text"
              placeholder="Your brand's name"
              value={brandName}
              disabled={isSubmitting}
              required
              onChange={(event) => setBrandName(event.target.value)}
            />
          </div>
        </div>

        <div className={styles.darkFieldGroup}>
          <label className={styles.darkLabel} htmlFor="websiteUrl">
            Website URL
          </label>
          <div className={styles.inputWithIcon}>
            <WebsiteIcon />
            <input
              id="websiteUrl"
              className={styles.darkInput}
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://yourbrand.com"
              value={websiteUrl}
              disabled={isSubmitting}
              required
              onChange={(event) => setWebsiteUrl(event.target.value)}
            />
          </div>
        </div>

        <div className={styles.darkFieldGroup}>
          <label className={styles.darkLabel} htmlFor="category">
            Category
          </label>
          <div className={styles.inputWithIcon}>
            <CategoryIcon />
            <select
              id="category"
              className={`${styles.darkInput} ${styles.darkSelect}`}
              value={category}
              disabled={isSubmitting}
              required
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="" disabled>
                Select a category
              </option>
              {FASHION_CATEGORIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={styles.formRow}>
          <div className={styles.darkFieldGroup}>
            <label className={styles.darkLabel} htmlFor="contactEmail">
              Contact email
            </label>
            <div className={styles.inputWithIcon}>
              <EmailIcon />
              <input
                id="contactEmail"
                className={styles.darkInput}
                type="email"
                placeholder="you@brand.com"
                value={contactEmail}
                disabled={isSubmitting}
                required
                onChange={(event) => setContactEmail(event.target.value)}
              />
            </div>
          </div>

          <div className={styles.darkFieldGroup}>
            <label className={styles.darkLabel} htmlFor="contactPhone">
              Contact phone
            </label>
            <div className={styles.inputWithIcon}>
              <PhoneIcon />
              <input
                id="contactPhone"
                className={styles.darkInput}
                type="tel"
                placeholder="+91 00000 00000"
                value={contactPhone}
                disabled={isSubmitting}
                required
                onChange={(event) => setContactPhone(event.target.value)}
              />
            </div>
          </div>
        </div>

        <div className={styles.darkCheckboxRow}>
          <input
            id="aiTrainingConsent"
            className={styles.darkCheckbox}
            type="checkbox"
            checked={consent}
            disabled={isSubmitting}
            required
            onChange={(event) => setConsent(event.target.checked)}
          />
          <label className={styles.darkCheckboxLabel} htmlFor="aiTrainingConsent">
            {CONSENT_LABEL}
          </label>
        </div>

        <button
          type="button"
          className={styles.formSubmitButton}
          disabled={isSubmitting}
          onClick={handleSubmit}
        >
          {isSubmitting ? "Submitting…" : "Onboard"}
        </button>
      </div>
    </div>
  );
}

// ---------- Screen C: confirmation ----------

export function ScreenC() {
  return (
    <div className={styles.screenAStage}>
      <div className={styles.stepInner}>
        <h1 className={styles.headline}>You&apos;re onboarded to Aeza</h1>
        <p className={styles.body}>
          Congratulations — you&apos;re onboarded to Aeza. We&apos;ll be in
          touch shortly.
        </p>
      </div>
    </div>
  );
}
