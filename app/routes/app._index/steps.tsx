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
import tryOnTutorialImage from "../../assets/try-on-tutorial.png";
import styles from "./styles.module.css";

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
          <button
            type="button"
            className={`${styles.ctaButton} ${styles.introCta}`}
            onClick={onAdvance}
          >
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

type FeatureVisual =
  | { type: "lottie"; src: string }
  | { type: "image"; src: string; alt: string };

function FeatureBullets({ items }: { items: string[] }) {
  return (
    <ul className={styles.featureBulletList}>
      {items.map((item) => (
        <li key={item} className={styles.featureBulletItem}>
          <span className={styles.featureBulletDot} />
          {item}
        </li>
      ))}
    </ul>
  );
}

function FeatureStats({
  stats,
}: {
  stats: { label: string; value: string }[];
}) {
  return (
    <div className={styles.featureStats}>
      {stats.map((stat) => (
        <div key={stat.label} className={styles.featureStatCard}>
          <p className={styles.featureStatLabel}>{stat.label}</p>
          <p className={styles.featureStatValue}>{stat.value}</p>
        </div>
      ))}
    </div>
  );
}

function FeatureRow({
  eyebrow,
  title,
  large,
  description,
  visual,
  reversed,
}: {
  eyebrow?: string;
  title: string;
  large?: boolean;
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
            <img
              className={styles.featureImage}
              src={visual.src}
              alt={visual.alt}
            />
          )}
        </div>
      </div>
      <div className={styles.featureRowText}>
        {eyebrow && <p className={styles.featureEyebrow}>{eyebrow}</p>}
        <h3
          className={
            large
              ? `${styles.featureTitle} ${styles.featureTitleLarge}`
              : styles.featureTitle
          }
        >
          {title}
        </h3>
        <div className={styles.featureDescription}>{description}</div>
      </div>
    </div>
  );
}

const CATEGORY_OPTIONS = [
  "Streetwear",
  "Loungewear",
  "Athleisure",
  "Formal Wear",
  "Casual Wear",
  "Ethnic Wear",
  "Denim",
  "Outerwear & Jackets",
  "Co-ord Sets",
  "Sleepwear",
  "Swimwear",
  "Maternity Wear",
  "Plus Size",
  "Other",
];

function CategoryDropdown({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className={styles.dropdown} ref={containerRef}>
      <button
        id={id}
        type="button"
        className={`${styles.darkInput} ${styles.dropdownTrigger}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className={value ? undefined : styles.dropdownPlaceholder}>
          {value || "Select a category"}
        </span>
      </button>
      {open && (
        <ul className={styles.dropdownPanel} role="listbox">
          {CATEGORY_OPTIONS.map((option) => (
            <li
              key={option}
              role="option"
              tabIndex={0}
              aria-selected={value === option}
              className={
                value === option
                  ? `${styles.dropdownOption} ${styles.dropdownOptionActive}`
                  : styles.dropdownOption
              }
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onChange(option);
                  setOpen(false);
                }
              }}
            >
              {option}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
  const [validationError, setValidationError] = useState<string | null>(null);

  const displayedError = validationError ?? error;

  const handleSubmit = () => {
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
        eyebrow="01 · DISCOVERY"
        title="Conversation that sells your catalog"
        large
        description={
          <>
            <p className={styles.featureDescriptionText}>
              Shoppers describe the occasion, not the SKU. Aeza&apos;s
              stylist builds the look from products you already sell — so
              discovery pulls more of your catalog into every cart.
            </p>
            <FeatureBullets
              items={[
                "Outfit-level recommendations, not single-item search",
                "Higher order value and repeat visits",
                "No merchandising work on your side",
              ]}
            />
          </>
        }
        visual={{ type: "lottie", src: aezaShopLottieUrl }}
        reversed
      />
      <FeatureRow
        eyebrow="02 · CONVERSION"
        title="They see it on themselves before they buy"
        large
        description={
          <>
            <p className={styles.featureDescriptionText}>
              Aeza renders your products on the shopper&apos;s own photo.
              Confidence at the moment of decision means fewer size returns
              and healthier margins on every order.
            </p>
            <FeatureStats
              stats={[
                { label: "Indian apparel returns", value: "1 in 4+" },
                { label: "Add-to-cart rate", value: "Above average" },
              ]}
            />
          </>
        }
        visual={{
          type: "image",
          src: tryOnTutorialImage,
          alt: "Virtual try-on tutorial preview",
        }}
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

        <div className={styles.darkFieldGroup}>
          <label className={styles.darkLabel} htmlFor="websiteUrl">
            Website URL
          </label>
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

        <div className={styles.darkFieldGroup}>
          <label className={styles.darkLabel} htmlFor="category">
            Category
          </label>
          <CategoryDropdown
            id="category"
            value={category}
            disabled={isSubmitting}
            onChange={setCategory}
          />
        </div>

        <div className={styles.formRow}>
          <div className={styles.darkFieldGroup}>
            <label className={styles.darkLabel} htmlFor="contactEmail">
              Contact email
            </label>
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

          <div className={styles.darkFieldGroup}>
            <label className={styles.darkLabel} htmlFor="contactPhone">
              Contact phone
            </label>
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
