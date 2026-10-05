import {
  useEffect,
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

type ToggleResponse =
  | { product: { id: string; published: boolean; syncStatus: string } }
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

type Notice = {
  kind: "success" | "error";
  text: string;
  // Set when a bulk run stopped at its safety limit: the cursor to continue
  // from, and which direction (publish / unpublish) it was running.
  resume?: { cursor: string; published: boolean };
};

function plural(count: number, word: string) {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

function ProductStatusBadge({
  published,
  syncStatus,
}: {
  published: boolean;
  syncStatus: string;
}) {
  if (!published) {
    return (
      <span className={`${styles.statusBadge} ${styles.statusBadgeIdle}`}>
        Not published
      </span>
    );
  }
  if (syncStatus === "error") {
    return (
      <span className={`${styles.statusBadge} ${styles.statusBadgeError}`}>
        Needs attention
      </span>
    );
  }
  return (
    <span className={`${styles.statusBadge} ${styles.statusBadgePublished}`}>
      Published to Aeza
    </span>
  );
}

function ProductRow({
  product,
  onToggled,
}: {
  product: DashboardProduct;
  onToggled: (productId: string, published: boolean) => void;
}) {
  const fetcher = useFetcher<ToggleResponse>();
  const pending = fetcher.state !== "idle";

  // Optimistic: while a toggle is in flight, show the state being sent
  // rather than waiting for the round trip. Once it settles, the parent's
  // product list (updated through onToggled) is the source of truth.
  const published = fetcher.formData
    ? fetcher.formData.get("published") === "true"
    : product.published;

  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  useEffect(() => {
    if (fetcher.data && "product" in fetcher.data) {
      onToggled(fetcher.data.product.id, fetcher.data.product.published);
    }
    // Only react to a freshly arrived response, not to parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const toggle = () => {
    fetcher.submit(
      { productId: product.id, published: String(!published) },
      { method: "POST", action: "/app/products/toggle" },
    );
  };

  return (
    <div className={styles.productRow}>
      <div className={styles.productRowMedia}>
        {product.imageUrl ? (
          <img src={product.imageUrl} alt="" className={styles.productThumb} />
        ) : (
          <div className={styles.productThumbPlaceholder} aria-hidden="true" />
        )}
      </div>

      <div className={styles.productRowInfo}>
        <p className={styles.productTitle}>{product.title}</p>
        <ProductStatusBadge
          published={published}
          syncStatus={product.syncStatus}
        />
        {error && <p className={styles.productRowError}>{error}</p>}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={published}
        aria-label={`Publish ${product.title} to Aeza`}
        className={`${styles.toggleSwitch} ${published ? styles.toggleSwitchOn : ""}`}
        disabled={pending}
        onClick={toggle}
      >
        <span className={styles.toggleSwitchKnob} />
      </button>
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
}: {
  brandName: string;
  initialProducts: DashboardProduct[];
  initialPageInfo: PageInfo;
  initialCounts: Counts;
  collections: Collection[];
  productsError: string | null;
}) {
  const [products, setProducts] = useState(initialProducts);
  const [pageInfo, setPageInfo] = useState(initialPageInfo);
  const [counts, setCounts] = useState(initialCounts);
  const [collectionId, setCollectionId] = useState("");
  const [viewVersion, setViewVersion] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirming, setConfirming] = useState<"publish" | "unpublish" | null>(
    null,
  );

  const listFetcher = useFetcher<ListResponse>();
  const bulkFetcher = useFetcher<BulkResponse>();
  // Whether the in-flight list request replaces the list (first page of a
  // view) or extends it ("Load more").
  const loadModeRef = useRef<"replace" | "append">("replace");

  const listLoading = listFetcher.state !== "idle";
  const bulkRunning = bulkFetcher.state !== "idle";
  const busy = listLoading || bulkRunning;

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

  const loadView = (collection: string, after?: string | null) => {
    loadModeRef.current = after ? "append" : "replace";
    const params = new URLSearchParams();
    if (collection) params.set("collection", collection);
    if (after) params.set("after", after);
    listFetcher.load(`/app/products/list?${params.toString()}`);
  };

  // Apply a freshly loaded page: replace the list for a new view, or append
  // for "Load more" (skipping any product already shown).
  useEffect(() => {
    const data = listFetcher.data;
    if (!data || data.error) return;

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
      setViewVersion((version) => version + 1);
    }
    setPageInfo(data.pageInfo);
    if (data.counts) setCounts(data.counts);
    // Only react to a freshly arrived response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listFetcher.data]);

  // A bulk action finished: report it, then reload the current view so every
  // row and the counts reflect what actually changed on the server.
  useEffect(() => {
    const data = bulkFetcher.data;
    if (!data) return;

    if ("error" in data) {
      setNotice({ kind: "error", text: data.error });
      return;
    }

    const verb = data.published ? "published to Aeza" : "unpublished";
    const summary =
      data.affected === 0
        ? "Nothing to change. Everything was already up to date."
        : `${plural(data.affected, "product")} ${verb}.`;

    setNotice({
      kind: "success",
      text: data.truncated
        ? `${summary} Stopped after ${data.limit.toLocaleString()} products. Continue to process the rest.`
        : summary,
      resume:
        data.truncated && data.nextCursor
          ? { cursor: data.nextCursor, published: data.published }
          : undefined,
    });
    loadView(collectionId);
    // Only react to a freshly arrived response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkFetcher.data]);

  const handleToggled = (productId: string, published: boolean) => {
    const current = products.find((product) => product.id === productId);
    if (!current || current.published === published) return;

    setProducts((previous) =>
      previous.map((product) =>
        product.id === productId
          ? { ...product, published, syncStatus: "recorded" }
          : product,
      ),
    );
    setCounts((previous) => ({
      ...previous,
      published: Math.max(0, previous.published + (published ? 1 : -1)),
    }));
  };

  const changeCollection = (nextCollectionId: string) => {
    setCollectionId(nextCollectionId);
    setNotice(null);
    setConfirming(null);
    loadView(nextCollectionId);
  };

  const runBulk = (published: boolean, cursor?: string) => {
    setConfirming(null);
    setNotice(null);
    bulkFetcher.submit(
      {
        published: String(published),
        collectionId,
        ...(cursor ? { after: cursor } : {}),
      },
      { method: "POST", action: "/app/products/bulk" },
    );
  };

  const listError = listFetcher.data?.error ?? null;

  return (
    <div className={styles.dashboardWrapper}>
      <div className={styles.dashboardHeader}>
        <h1 className={styles.headline}>You&apos;re connected to Aeza</h1>
        <p className={styles.body}>
          {brandName ? `${brandName}: ` : ""}choose which products to
          publish to Aeza&apos;s marketplace. Publish everything in one click,
          a whole collection at a time, or pick products one by one. You can
          change this anytime.
        </p>
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
              {confirming ? (
                <>
                  <span className={styles.bulkConfirmText}>
                    {confirming === "publish" ? "Publish" : "Unpublish"} every
                    product {scopeLabel}?
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
                    disabled={busy}
                    onClick={() => setConfirming("publish")}
                  >
                    {selectedCollection ? "Publish collection" : "Publish all"}
                  </button>
                  <button
                    type="button"
                    className={styles.bulkButton}
                    disabled={busy}
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

      {bulkRunning && (
        <div className={styles.infoBanner}>
          Updating products… this can take a moment for large catalogs.
        </div>
      )}

      {notice && (
        <div
          className={
            notice.kind === "success" ? styles.successBanner : styles.errorBanner
          }
        >
          <span>{notice.text}</span>
          {notice.resume && (
            <button
              type="button"
              className={styles.bannerAction}
              disabled={busy}
              onClick={() =>
                runBulk(notice.resume!.published, notice.resume!.cursor)
              }
            >
              Continue
            </button>
          )}
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

      {products.length > 0 && (
        <div
          className={`${styles.productList} ${
            listLoading && loadModeRef.current === "replace"
              ? styles.productListLoading
              : ""
          }`}
        >
          {products.map((product) => (
            <ProductRow
              key={`${viewVersion}-${product.id}`}
              product={product}
              onToggled={handleToggled}
            />
          ))}
        </div>
      )}

      {pageInfo.hasNextPage && (
        <button
          type="button"
          className={styles.loadMoreButton}
          disabled={busy}
          onClick={() => loadView(collectionId, pageInfo.endCursor)}
        >
          {listLoading && loadModeRef.current === "append"
            ? "Loading…"
            : "Load more products"}
        </button>
      )}

      {listError && <div className={styles.errorBanner}>{listError}</div>}
    </div>
  );
}
