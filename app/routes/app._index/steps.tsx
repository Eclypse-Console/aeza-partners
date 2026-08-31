import { useEffect, useRef, useState, type ComponentType } from "react";
import type { IPlayerProps } from "@lottiefiles/react-lottie-player";

import logoVideoUrl from "../../assets/aeza-logo-animation/aeza-logo-reveal-transparent.webm";
import aezaShopLottieUrl from "../../assets/lottie-jsons/Aeza-Shop.json?url";
import aezaSizeLottieUrl from "../../assets/lottie-jsons/Aeza-Size.json?url";
import styles from "./styles.module.css";

export function Step1Logo({ onAdvance }: { onAdvance: () => void }) {
  const advancedRef = useRef(false);

  const advance = () => {
    if (advancedRef.current) return;
    advancedRef.current = true;
    onAdvance();
  };

  useEffect(() => {
    const timer = setTimeout(advance, 3000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.step1}>
      <video
        className={styles.step1Video}
        src={logoVideoUrl}
        autoPlay
        muted
        playsInline
        onEnded={advance}
      />
      <button
        type="button"
        className={styles.step1Continue}
        onClick={advance}
      >
        Continue
      </button>
    </div>
  );
}

export function Step2Intro({ onAdvance }: { onAdvance: () => void }) {
  return (
    <div className={styles.step}>
      <div className={styles.stepInner}>
        <h1 className={styles.headline}>Meet your AI stylist</h1>
        <p className={styles.body}>
          Aeza turns conversation into outfits, matches you to the right size
          in every brand, and lets shoppers see a look on themselves before
          they buy.
        </p>
        <button
          type="button"
          className={styles.ctaButton}
          onClick={onAdvance}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

type FeatureVisual =
  | { type: "lottie"; src: string }
  | { type: "icon"; icon: "camera" };

// lottie-web (a dependency of @lottiefiles/react-lottie-player) touches the
// `document` global as soon as its module is evaluated, which crashes React
// Router's server render. Loading it via a dynamic import inside useEffect
// keeps it out of the SSR bundle entirely — it only ever loads in the browser.
function LottieVisual({ src }: { src: string }) {
  const [Player, setPlayer] = useState<ComponentType<IPlayerProps> | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    import("@lottiefiles/react-lottie-player").then((mod) => {
      if (!cancelled) setPlayer(() => mod.Player);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!Player) return null;

  return (
    <Player src={src} autoplay loop style={{ width: "100%", height: "100%" }} />
  );
}

function FeatureVisualSlot({ visual }: { visual: FeatureVisual }) {
  return (
    <div className={styles.featureVisual}>
      {visual.type === "lottie" ? (
        <LottieVisual src={visual.src} />
      ) : (
        <s-icon type={visual.icon} size="base"></s-icon>
      )}
    </div>
  );
}

function FeatureCard({
  title,
  description,
  visual,
}: {
  title: string;
  description: string;
  visual: FeatureVisual;
}) {
  return (
    <div className={styles.featureCard}>
      <FeatureVisualSlot visual={visual} />
      <h3 className={styles.featureTitle}>{title}</h3>
      <p className={styles.featureDescription}>{description}</p>
    </div>
  );
}

export function Step3Features({ onAdvance }: { onAdvance: () => void }) {
  return (
    <div className={styles.step}>
      <div className={styles.stepInnerWide}>
        <div className={styles.featuresGrid}>
          <FeatureCard
            title="AI Stylist"
            description="Shop through conversation, not endless scrolling — recommendations tailored to taste, body type, and occasion."
            visual={{ type: "lottie", src: aezaShopLottieUrl }}
          />
          <FeatureCard
            title="Dynamic Sizing"
            description="Different brands size differently. Aeza matches shoppers to the right fit in every brand, every time."
            visual={{ type: "lottie", src: aezaSizeLottieUrl }}
          />
          <FeatureCard
            title="Virtual Try-On"
            description="Shoppers see any outfit on themselves before they buy — less guesswork, fewer returns."
            visual={{ type: "icon", icon: "camera" }}
          />
        </div>
        <button
          type="button"
          className={styles.ctaButton}
          onClick={onAdvance}
        >
          Onboard your brand
        </button>
      </div>
    </div>
  );
}

export function Step5Confirmation() {
  return (
    <div className={styles.step}>
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
