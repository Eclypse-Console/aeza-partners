import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useFetcher } from "react-router";
import type { IPlayerProps } from "@lottiefiles/react-lottie-player";

import logoVideoUrl from "../../assets/aeza-logo-animation/aeza-logo-reveal-transparent.webm";
import aezaLogoImage from "../../assets/aeza-logo.png";
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
          <img className={styles.introLogo} src={aezaLogoImage} alt="aeza" />
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

type DropdownOption = { value: string; label: string };

function ListDropdown({
  id,
  value,
  options,
  placeholder,
  onChange,
  disabled,
}: {
  id?: string;
  value: string;
  options: DropdownOption[];
  placeholder: string;
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

  const selected = options.find((option) => option.value === value);

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
        <span className={selected ? undefined : styles.dropdownPlaceholder}>
          {selected ? selected.label : placeholder}
        </span>
      </button>
      {open && (
        <ul className={styles.dropdownPanel} role="listbox">
          {options.map((option) => (
            <li
              key={option.value}
              role="option"
              tabIndex={0}
              aria-selected={value === option.value}
              className={
                value === option.value
                  ? `${styles.dropdownOption} ${styles.dropdownOptionActive}`
                  : styles.dropdownOption
              }
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onChange(option.value);
                  setOpen(false);
                }
              }}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const CATEGORY_DROPDOWN_OPTIONS: DropdownOption[] = CATEGORY_OPTIONS.map(
  (option) => ({ value: option, label: option }),
);

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
  return (
    <ListDropdown
      id={id}
      value={value}
      options={CATEGORY_DROPDOWN_OPTIONS}
      placeholder="Select a category"
      onChange={onChange}
      disabled={disabled}
    />
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
              stylist builds the look from products you already sell, so
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
        eyebrow="03 · FIT & SETUP"
        title="Your size chart, learned, and you're live in a minute"
        large
        description={
          <>
            Generic charts don&apos;t work: an L in one brand isn&apos;t an
            L in yours. Aeza maps each shopper to your real measurements, so
            fewer wrong-size orders leave your warehouse.
          </>
        }
        visual={{ type: "lottie", src: aezaSizeLottieUrl }}
        reversed
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

// ---------- Screen C: product dashboard ----------

export type DashboardProduct = {
  id: string;
  title: string;
  status: string;
  imageUrl: string | null;
  thumbnailUrl?: string | null;
  published: boolean;
  syncStatus: string;
};

type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type Collection = { id: string; title: string; productCount: number };
type Counts = { published: number; total: number | null };

type ListResponse = {
  products: DashboardProduct[];
  pageInfo: PageInfo;
  counts: Counts | null;
  error: string | null;
};

type SaveResponse =
  | {
      published: number;
      unpublished: number;
      publishedTotal: number;
      saved: Array<{ id: string; published: boolean }>;
      missing: string[];
    }
  | { error: string };

type BulkResponse =
  | {
      affected: number;
      truncated: boolean;
      nextCursor: string | null;
      limit: number;
      published: boolean;
    }
  | { error: string };

// Mirrors PublishMode in services/product-sync.server.ts (server-only module).
type PublishMode = "selected" | "all";

type ModeResponse = { mode: PublishMode } | { error: string };

// Set when a bulk run stopped at its safety limit: the cursor to continue
// from, and which direction (publish / unpublish) it was running.
type BulkResume = { cursor: string; published: boolean };

type ToastMessage = { id: number; kind: "success" | "error"; text: string };

// Product id -> the publish state the brand has selected but not yet saved.
// Only products whose selection differs from their saved state are in here.
type PendingChanges = Record<string, boolean>;

const AEZA_SITE_URL = "https://aeza.in";
const AEZA_SITE_LABEL = "aeza.in";

function plural(count: number, word: string) {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, toast.kind === "error" ? 7000 : 4000);
    return () => clearTimeout(timer);
    // Restart the timer only when a new toast replaces this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id]);

  const isError = toast.kind === "error";

  return (
    <div className={styles.toastViewport}>
      <div
        key={toast.id}
        role={isError ? "alert" : "status"}
        className={`${styles.toast} ${isError ? styles.toastError : styles.toastSuccess}`}
      >
        <span className={styles.toastIcon} aria-hidden="true">
          {isError ? "!" : "✓"}
        </span>
        <span className={styles.toastText}>{toast.text}</span>
        <button
          type="button"
          className={styles.toastClose}
          aria-label="Dismiss notification"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
    </div>
  );
}

// Shown after products are published, so the brand knows what happens next:
// their products aren't on the marketplace the instant they hit Save.
function GoLiveNotice({
  count,
  onDismiss,
}: {
  count: number;
  onDismiss: () => void;
}) {
  return (
    <div className={styles.goLiveNotice} role="status">
      <span className={styles.goLiveIcon} aria-hidden="true">
        <svg viewBox="0 0 20 20" width="18" height="18">
          <path
            d="M10 2.5l1.9 4.3 4.6.4-3.5 3 1 4.6L10 12.4l-4 2.4 1-4.6-3.5-3 4.6-.4z"
            fill="currentColor"
          />
        </svg>
      </span>
      <div className={styles.goLiveText}>
        <p className={styles.goLiveTitle}>
          {count === 1
            ? "Your product is on its way to "
            : `${count.toLocaleString()} products are on their way to `}
          {AEZA_SITE_LABEL}
        </p>
        <p className={styles.goLiveBody}>
          {count === 1 ? "It" : "They"}&apos;ll be live on the Aeza marketplace
          soon. There&apos;s nothing else you need to do.
        </p>
      </div>
      <div className={styles.goLiveActions}>
        <a
          href={AEZA_SITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.goLiveLink}
        >
          Visit {AEZA_SITE_LABEL}
        </a>
        <button
          type="button"
          className={styles.toastClose}
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function ProductStatusBadge({
  product,
  pendingState,
}: {
  product: DashboardProduct;
  pendingState: boolean | undefined;
}) {
  if (pendingState !== undefined) {
    return (
      <span className={`${styles.statusBadge} ${styles.statusBadgePending}`}>
        {pendingState ? "Will publish" : "Will unpublish"}
      </span>
    );
  }
  if (!product.published) {
    return (
      <span className={`${styles.statusBadge} ${styles.statusBadgeIdle}`}>
        Not published
      </span>
    );
  }
  if (product.syncStatus === "error") {
    return (
      <span className={`${styles.statusBadge} ${styles.statusBadgeError}`}>
        Needs attention
      </span>
    );
  }
  return (
    <span className={`${styles.statusBadge} ${styles.statusBadgePublished}`}>
      On Aeza
    </span>
  );
}

// Memoised: selecting a card only re-renders that card, since every prop
// is either a primitive or stable (the product object and onToggle keep
// their identity until the product itself changes).
const ProductCard = memo(function ProductCard({
  product,
  pendingState,
  disabled,
  onToggle,
}: {
  product: DashboardProduct;
  pendingState: boolean | undefined;
  disabled: boolean;
  onToggle: (productId: string, savedPublished: boolean) => void;
}) {
  const selected = pendingState ?? product.published;
  const isDraft = product.status !== "ACTIVE";

  // A real checkbox inside a label: the whole card is the click target, and
  // keyboard / screen reader users get native checkbox behaviour. Selecting
  // only changes local state, nothing is sent until the brand hits Save.
  return (
    <label
      className={[
        styles.productCard,
        selected ? styles.productCardSelected : "",
        pendingState !== undefined ? styles.productCardChanged : "",
        disabled ? styles.productCardDisabled : "",
      ].join(" ")}
    >
      <input
        type="checkbox"
        className={styles.visuallyHidden}
        checked={selected}
        disabled={disabled}
        onChange={() => onToggle(product.id, product.published)}
      />

      <div className={styles.productCardMedia}>
        {product.thumbnailUrl || product.imageUrl ? (
          <img
            src={product.thumbnailUrl || product.imageUrl!}
            alt=""
            loading="lazy"
            decoding="async"
            width={480}
            height={480}
            className={styles.productCardImage}
          />
        ) : (
          <div className={styles.productCardPlaceholder} aria-hidden="true">
            No image
          </div>
        )}
        <span className={styles.productCardCheck} aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path
              d="M3.5 8.5l3 3 6-7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        {isDraft && (
          <span className={styles.productCardDraft}>
            {product.status.charAt(0) + product.status.slice(1).toLowerCase()}
          </span>
        )}
      </div>

      <div className={styles.productCardBody}>
        <p className={styles.productCardTitle} title={product.title}>
          {product.title}
        </p>
        <ProductStatusBadge product={product} pendingState={pendingState} />
      </div>
    </label>
  );
});

// Record `selected` as the wanted state for a product, or drop the pending
// entry when that's simply its saved state again. Returns the same object
// when nothing changes, so React can skip the re-render.
function withSelection(
  previous: PendingChanges,
  productId: string,
  savedPublished: boolean,
  selected: boolean,
): PendingChanges {
  if (selected === savedPublished) {
    if (!(productId in previous)) return previous;
    const next = { ...previous };
    delete next[productId];
    return next;
  }
  if (previous[productId] === selected) return previous;
  return { ...previous, [productId]: selected };
}

function formatSyncTime(date: Date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function ProductCardSkeleton() {
  return (
    <div className={styles.productCardSkeleton} aria-hidden="true">
      <div className={styles.skeletonMedia} />
      <div className={styles.skeletonLine} />
      <div className={styles.skeletonLineShort} />
    </div>
  );
}

export function ScreenC({
  brandName,
  initialProducts,
  initialPageInfo,
  initialCounts,
  collections,
  productsError,
  initialPublishMode,
}: {
  brandName: string;
  initialProducts: DashboardProduct[];
  initialPageInfo: PageInfo;
  initialCounts: Counts;
  collections: Collection[];
  productsError: string | null;
  initialPublishMode: PublishMode;
}) {
  const [products, setProducts] = useState(initialProducts);
  const [pageInfo, setPageInfo] = useState(initialPageInfo);
  const [counts, setCounts] = useState(initialCounts);
  const [collectionId, setCollectionId] = useState("");
  const [pending, setPending] = useState<PendingChanges>({});
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [bulkResume, setBulkResume] = useState<BulkResume | null>(null);
  // How many products the latest save / bulk action just published, for the
  // "going live on aeza.in" banner. Null once dismissed or nothing published.
  const [goLiveCount, setGoLiveCount] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<"publish" | "unpublish" | null>(
    null,
  );

  const listFetcher = useFetcher<ListResponse>();
  const bulkFetcher = useFetcher<BulkResponse>();
  const saveFetcher = useFetcher<SaveResponse>();
  const modeFetcher = useFetcher<ModeResponse>();
  const [publishMode, setPublishMode] = useState(initialPublishMode);
  // "all": every active product is on Aeza automatically, so manual
  // selection and bulk actions are switched off.
  const showAll = publishMode === "all";
  // Whether the in-flight list request replaces the list (first page of a
  // view) or extends it ("Load more").
  const loadModeRef = useRef<"replace" | "append">("replace");
  // Set while a "Sync" reload is in flight, so its result can be announced.
  const syncingRef = useRef(false);
  const toastIdRef = useRef(0);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  // Client-only (set after mount) so server and browser render the same.
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  const listLoading = listFetcher.state !== "idle";
  const bulkRunning = bulkFetcher.state !== "idle";
  const saving = saveFetcher.state !== "idle";
  const changingMode = modeFetcher.state !== "idle";
  const busy = listLoading || bulkRunning || saving || changingMode;

  const { pendingEntries, toPublishCount } = useMemo(() => {
    const entries = Object.entries(pending);
    return {
      pendingEntries: entries,
      toPublishCount: entries.filter(([, value]) => value).length,
    };
  }, [pending]);
  const pendingCount = pendingEntries.length;
  const toUnpublishCount = pendingCount - toPublishCount;
  const hasPending = pendingCount > 0;

  const selectedCount = useMemo(
    () =>
      products.filter((product) => pending[product.id] ?? product.published)
        .length,
    [products, pending],
  );
  const syncing = listLoading && loadModeRef.current === "replace";
  const appending = listLoading && loadModeRef.current === "append";

  const selectedCollection = collections.find(
    (collection) => collection.id === collectionId,
  );
  const scopeLabel = selectedCollection
    ? `in “${selectedCollection.title}”`
    : "in your store";

  const collectionOptions: DropdownOption[] = [
    { value: "", label: "All products" },
    ...collections.map((collection) => ({
      value: collection.id,
      label: `${collection.title} (${collection.productCount})`,
    })),
  ];

  const showToast = (kind: ToastMessage["kind"], text: string) => {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, kind, text });
  };

  const loadView = (collection: string, after?: string | null) => {
    loadModeRef.current = after ? "append" : "replace";
    const params = new URLSearchParams();
    if (collection) params.set("collection", collection);
    if (after) params.set("after", after);
    listFetcher.load(`/app/products/list?${params.toString()}`);
  };

  useEffect(() => {
    setLastSynced(new Date());
  }, []);

  // Load the next page automatically as the brand nears the end of the grid.
  // The "Load more" button stays as a visible, clickable fallback.
  const canLoadMore = pageInfo.hasNextPage && !busy;
  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !canLoadMore || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          loadView(collectionId, pageInfo.endCursor);
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
    // loadView only reads the values listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoadMore, collectionId, pageInfo.endCursor]);

  // Warn before leaving the page with unsaved selections.
  useEffect(() => {
    if (!hasPending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasPending]);

  // Apply a freshly loaded page: replace the list for a new view, or append
  // for "Load more" (skipping any product already shown). Pending selections
  // are kept across views, so a brand can pick products from several
  // collections and save them together.
  useEffect(() => {
    const data = listFetcher.data;
    if (!data) return;
    const wasSync = syncingRef.current;
    syncingRef.current = false;
    if (data.error) {
      showToast("error", data.error);
      return;
    }

    if (loadModeRef.current === "append") {
      setProducts((previous) => {
        const seen = new Set(previous.map((product) => product.id));
        return [
          ...previous,
          ...data.products.filter((product) => !seen.has(product.id)),
        ];
      });
    } else {
      setProducts(data.products);
    }
    setPageInfo(data.pageInfo);
    if (data.counts) setCounts(data.counts);
    if (loadModeRef.current === "replace") setLastSynced(new Date());
    if (wasSync) showToast("success", "Products synced with Shopify.");
    // Only react to a freshly arrived response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listFetcher.data]);

  // A save finished: apply what the server recorded, clear those pending
  // selections and report the result. On failure the selections stay, so
  // the brand can simply hit Save again.
  useEffect(() => {
    const data = saveFetcher.data;
    if (!data) return;

    if ("error" in data) {
      showToast("error", data.error);
      return;
    }

    const savedState = new Map(data.saved.map((item) => [item.id, item.published]));
    const settled = new Set([...savedState.keys(), ...data.missing]);

    setProducts((previous) =>
      previous.map((product) => {
        const published = savedState.get(product.id);
        if (published === undefined || published === product.published) {
          return product;
        }
        return { ...product, published, syncStatus: "recorded" };
      }),
    );
    setPending((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([id]) => !settled.has(id)),
      ),
    );
    setCounts((previous) => ({ ...previous, published: data.publishedTotal }));

    const parts: string[] = [];
    if (data.published > 0) {
      parts.push(`${plural(data.published, "product")} published to Aeza`);
    }
    if (data.unpublished > 0) {
      parts.push(`${plural(data.unpublished, "product")} unpublished`);
    }
    let text = parts.length
      ? `Saved. ${parts.join(", ")}.`
      : "Saved. Everything was already up to date.";
    if (data.published > 0) {
      text += ` ${data.published === 1 ? "It" : "They"}'ll be live on ${AEZA_SITE_LABEL} soon.`;
      setGoLiveCount(data.published);
    }
    if (data.missing.length > 0) {
      text += ` ${plural(data.missing.length, "product")} no longer exist in Shopify and ${data.missing.length === 1 ? "was" : "were"} skipped.`;
    }
    showToast("success", text);
    // Only react to a freshly arrived response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveFetcher.data]);

  // A bulk action finished: report it, then reload the current view so every
  // card and the counts reflect what actually changed on the server.
  useEffect(() => {
    const data = bulkFetcher.data;
    if (!data) return;

    if ("error" in data) {
      showToast("error", data.error);
      return;
    }

    const verb = data.published ? "published to Aeza" : "unpublished";
    const goingLive = data.published && data.affected > 0;
    showToast(
      "success",
      data.affected === 0
        ? "Nothing to change. Everything was already up to date."
        : `${plural(data.affected, "product")} ${verb}.${
            goingLive
              ? ` ${data.affected === 1 ? "It" : "They"}'ll be live on ${AEZA_SITE_LABEL} soon.`
              : ""
          }`,
    );
    if (goingLive) setGoLiveCount(data.affected);
    setBulkResume(
      data.truncated && data.nextCursor
        ? { cursor: data.nextCursor, published: data.published }
        : null,
    );
    loadView(collectionId);
    // Only react to a freshly arrived response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkFetcher.data]);

  // The publish mode changed: reload so every card and the counts reflect it.
  useEffect(() => {
    const data = modeFetcher.data;
    if (!data) return;

    if ("error" in data) {
      showToast("error", data.error);
      return;
    }

    setPublishMode(data.mode);
    setPending({});
    setConfirming(null);
    setBulkResume(null);
    showToast(
      "success",
      data.mode === "all"
        ? `All active products will be shown on ${AEZA_SITE_LABEL}, including new ones.`
        : "Only the products you select will be shown on Aeza.",
    );
    loadView(collectionId);
    // Only react to a freshly arrived response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeFetcher.data]);

  const changePublishMode = (mode: PublishMode) => {
    if (mode === publishMode) return;
    modeFetcher.submit(
      { mode },
      { method: "POST", action: "/app/products/mode" },
    );
  };

  // Stable identity so memoised cards don't re-render when the parent does.
  const toggleProduct = useCallback(
    (productId: string, savedPublished: boolean) => {
      setPending((previous) =>
        withSelection(
          previous,
          productId,
          savedPublished,
          !(previous[productId] ?? savedPublished),
        ),
      );
    },
    [],
  );

  const selectAll = (selected: boolean) => {
    setPending((previous) =>
      products.reduce(
        (next, product) =>
          withSelection(next, product.id, product.published, selected),
        previous,
      ),
    );
  };

  const sync = () => {
    syncingRef.current = true;
    setBulkResume(null);
    loadView(collectionId);
  };

  const save = () => {
    saveFetcher.submit(
      {
        changes: JSON.stringify(
          pendingEntries.map(([productId, published]) => ({
            productId,
            published,
          })),
        ),
      },
      { method: "POST", action: "/app/products/save" },
    );
  };

  const discard = () => {
    setPending({});
    showToast("success", "Changes discarded.");
  };

  const changeCollection = (nextCollectionId: string) => {
    setCollectionId(nextCollectionId);
    setConfirming(null);
    setBulkResume(null);
    loadView(nextCollectionId);
  };

  const runBulk = (published: boolean, cursor?: string) => {
    setConfirming(null);
    setBulkResume(null);
    bulkFetcher.submit(
      {
        published: String(published),
        collectionId,
        ...(cursor ? { after: cursor } : {}),
      },
      { method: "POST", action: "/app/products/bulk" },
    );
  };

  const showSkeleton = syncing && products.length === 0;

  return (
    <div className={styles.dashboardWrapper}>
      <div className={styles.dashboardHeader}>
        <h1 className={styles.headline}>You&apos;re connected to Aeza</h1>
        <p className={styles.body}>
          {brandName ? `${brandName}: ` : ""}
          {showAll
            ? `every active product in your store is shown on Aeza's marketplace, and new products are added automatically.`
            : `select the products you want on Aeza's marketplace, then save. Nothing changes until you hit Save, and published products go live on ${AEZA_SITE_LABEL} soon after. You can update your selection anytime.`}
        </p>
        <div
          className={styles.bulkActions}
          role="group"
          aria-label="Which products appear on Aeza"
        >
          <button
            type="button"
            className={showAll ? styles.bulkButtonPrimary : styles.bulkButton}
            aria-pressed={showAll}
            disabled={busy || hasPending}
            onClick={() => changePublishMode("all")}
          >
            Show all products on Aeza
          </button>
          <button
            type="button"
            className={showAll ? styles.bulkButton : styles.bulkButtonPrimary}
            aria-pressed={!showAll}
            disabled={busy || hasPending}
            onClick={() => changePublishMode("selected")}
          >
            Only selected products
          </button>
        </div>
      </div>

      {!productsError && (
        <>
          <div className={styles.statsBar}>
            <div className={styles.statBlock}>
              <p className={styles.statNumber}>
                {counts.published.toLocaleString()}
              </p>
              <p className={styles.statCaption}>published to Aeza</p>
            </div>
            {counts.total !== null && (
              <div className={styles.statBlock}>
                <p className={styles.statNumberMuted}>
                  {counts.total.toLocaleString()}
                </p>
                <p className={styles.statCaption}>
                  {counts.total === 1 ? "product" : "products"} {scopeLabel}
                </p>
              </div>
            )}
          </div>

          <div className={styles.toolbar}>
            {collections.length > 0 && (
              <div className={styles.toolbarField}>
                <label className={styles.darkLabel} htmlFor="collectionFilter">
                  Filter by collection
                </label>
                <ListDropdown
                  id="collectionFilter"
                  value={collectionId}
                  options={collectionOptions}
                  placeholder="All products"
                  disabled={busy}
                  onChange={changeCollection}
                />
              </div>
            )}

            <div className={styles.bulkActions}>
              {showAll ? null : confirming ? (
                <>
                  <span className={styles.bulkConfirmText}>
                    {confirming === "publish" ? "Publish" : "Unpublish"} every
                    product {scopeLabel}? This applies right away.
                  </span>
                  <button
                    type="button"
                    className={styles.bulkButtonPrimary}
                    disabled={busy}
                    onClick={() => runBulk(confirming === "publish")}
                  >
                    Yes, {confirming}
                  </button>
                  <button
                    type="button"
                    className={styles.bulkButton}
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={styles.bulkButtonPrimary}
                    disabled={busy || hasPending}
                    title={
                      hasPending
                        ? "Save or discard your selection first"
                        : undefined
                    }
                    onClick={() => setConfirming("publish")}
                  >
                    {selectedCollection ? "Publish collection" : "Publish all"}
                  </button>
                  <button
                    type="button"
                    className={styles.bulkButton}
                    disabled={busy || hasPending}
                    title={
                      hasPending
                        ? "Save or discard your selection first"
                        : undefined
                    }
                    onClick={() => setConfirming("unpublish")}
                  >
                    {selectedCollection
                      ? "Unpublish collection"
                      : "Unpublish all"}
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {goLiveCount !== null && (
        <GoLiveNotice
          count={goLiveCount}
          onDismiss={() => setGoLiveCount(null)}
        />
      )}

      {bulkRunning && (
        <div className={styles.infoBanner}>
          Updating products… this can take a moment for large catalogs.
        </div>
      )}

      {bulkResume && !bulkRunning && (
        <div className={styles.infoBanner}>
          <span>
            Large catalog: stopped partway through. Continue to process the
            rest.
          </span>
          <button
            type="button"
            className={styles.bannerAction}
            disabled={busy}
            onClick={() => runBulk(bulkResume.published, bulkResume.cursor)}
          >
            Continue
          </button>
        </div>
      )}

      {productsError && (
        <div className={styles.errorBanner}>{productsError}</div>
      )}

      {!productsError && products.length === 0 && !listLoading && (
        <div className={styles.emptyState}>
          {selectedCollection
            ? "This collection has no products."
            : "No products found in this store yet. Add products in Shopify, then refresh this page."}
        </div>
      )}

      {!productsError && (
        <div className={styles.gridHeader}>
          <p className={styles.gridHeaderText}>
            {products.length > 0
              ? `${selectedCount.toLocaleString()} of ${plural(products.length, "product")} selected`
              : null}
          </p>
          <div className={styles.gridHeaderActions}>
            {products.length > 0 && !showAll && (
              <>
                <button
                  type="button"
                  className={styles.textButton}
                  disabled={busy || selectedCount === products.length}
                  onClick={() => selectAll(true)}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className={styles.textButton}
                  disabled={busy || selectedCount === 0}
                  onClick={() => selectAll(false)}
                >
                  Clear all
                </button>
                <span className={styles.gridHeaderDivider} aria-hidden="true" />
              </>
            )}
            <button
              type="button"
              className={styles.syncButton}
              disabled={busy}
              onClick={sync}
              title={
                lastSynced
                  ? `Last synced at ${formatSyncTime(lastSynced)}`
                  : undefined
              }
            >
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                aria-hidden="true"
                className={syncing ? styles.syncIconSpinning : undefined}
              >
                <path
                  d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {syncing ? "Syncing…" : "Sync products"}
            </button>
          </div>
        </div>
      )}

      {showSkeleton && (
        <div className={styles.productGrid}>
          {Array.from({ length: 8 }, (_, index) => (
            <ProductCardSkeleton key={index} />
          ))}
        </div>
      )}

      {products.length > 0 && (
        <div
          className={`${styles.productGrid} ${syncing ? styles.productListLoading : ""}`}
        >
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              pendingState={pending[product.id]}
              disabled={saving || bulkRunning || changingMode || showAll}
              onToggle={toggleProduct}
            />
          ))}
          {appending &&
            Array.from({ length: 4 }, (_, index) => (
              <ProductCardSkeleton key={`more-${index}`} />
            ))}
        </div>
      )}

      {pageInfo.hasNextPage && (
        <button
          ref={loadMoreRef}
          type="button"
          className={styles.loadMoreButton}
          disabled={busy}
          onClick={() => loadView(collectionId, pageInfo.endCursor)}
        >
          {appending ? "Loading…" : "Load more products"}
        </button>
      )}

      {hasPending && (
        <div
          className={styles.saveBar}
          role="region"
          aria-label="Unsaved changes"
        >
          <div className={styles.saveBarText}>
            <span className={styles.saveBarTitle}>
              {plural(pendingCount, "unsaved change")}
            </span>
            <span className={styles.saveBarDetail}>
              {[
                toPublishCount > 0 ? `${toPublishCount} to publish` : null,
                toUnpublishCount > 0
                  ? `${toUnpublishCount} to unpublish`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          <div className={styles.saveBarActions}>
            <button
              type="button"
              className={styles.bulkButton}
              disabled={saving}
              onClick={discard}
            >
              Discard
            </button>
            <button
              type="button"
              className={styles.bulkButtonPrimary}
              disabled={saving}
              onClick={save}
            >
              {saving ? (
                <span className={styles.buttonBusy}>
                  <span className={styles.spinner} aria-hidden="true" />
                  Saving…
                </span>
              ) : (
                "Save changes"
              )}
            </button>
          </div>
        </div>
      )}

      {toast && <Toast toast={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
