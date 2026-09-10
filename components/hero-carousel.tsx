"use client";

import Link from "next/link";
import { useCallback, useState, type KeyboardEvent } from "react";

export type HeroMedia =
  | { type: "image"; src: string }
  | { type: "video"; src: string; poster?: string };

export interface HeroSlide {
  id: string;
  title: string;
  subtitle: string;
  ctaLabel: string;
  href: string;
  media?: HeroMedia;
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={direction === "left" ? "m15 18-6-6 6-6" : "m9 6 6 6-6 6"} />
    </svg>
  );
}

export function HeroCarousel({
  slides,
  previousLabel,
  nextLabel,
  carouselLabel,
  goToSlideLabel,
}: {
  slides: HeroSlide[];
  previousLabel: string;
  nextLabel: string;
  carouselLabel: string;
  goToSlideLabel: string;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const count = slides.length;
  const currentIndex = count === 0 ? 0 : activeIndex % count;

  const showPrevious = useCallback(() => {
    setActiveIndex((current) => (current - 1 + count) % count);
  }, [count]);

  const showNext = useCallback(() => {
    setActiveIndex((current) => (current + 1) % count);
  }, [count]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (count < 2) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      showPrevious();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      showNext();
    }
  }

  if (count === 0) return null;

  return (
    <section
      className="relative mb-10 min-h-92 overflow-hidden rounded-2xl bg-brand-700 text-white shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 sm:min-h-105"
      aria-label={carouselLabel}
      aria-roledescription="carousel"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {slides.map((slide, index) => {
        const active = index === currentIndex;

        return (
          <article
            key={slide.id}
            className={`absolute inset-0 transition-opacity duration-500 motion-reduce:transition-none ${
              active ? "z-10 opacity-100" : "pointer-events-none opacity-0"
            }`}
            aria-hidden={!active}
            inert={!active ? true : undefined}
          >
            {slide.media?.type === "video" ? (
              <video
                className="absolute inset-0 size-full object-cover"
                src={slide.media.src}
                poster={slide.media.poster}
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
                aria-hidden="true"
              />
            ) : slide.media?.type === "image" ? (
              // روابط صور المورد متغيرة ولا تمر عبر محسن Next كي لا يُعاد
              // إرسال كوكيز المتجر إليها أو تتطلب قائمة مضيفين مفتوحة.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={slide.media.src}
                alt=""
                loading={index === 0 ? "eager" : "lazy"}
                fetchPriority={index === 0 ? "high" : "auto"}
                referrerPolicy="no-referrer"
                className="absolute inset-0 size-full object-cover"
              />
            ) : null}

            <div className="absolute inset-0 bg-gradient-to-r from-ink-900/95 via-brand-800/85 to-brand-500/25 rtl:bg-gradient-to-l" />

            <div className="relative z-10 flex min-h-92 items-center px-16 py-12 sm:min-h-105 sm:px-20 lg:px-24">
              <div className="max-w-2xl">
                {index === 0 ? (
                  <h1 className="line-clamp-3 text-3xl font-bold leading-tight drop-shadow-sm sm:text-4xl">
                    {slide.title}
                  </h1>
                ) : (
                  <h2 className="line-clamp-3 text-3xl font-bold leading-tight drop-shadow-sm sm:text-4xl">
                    {slide.title}
                  </h2>
                )}
                <p className="mt-3 max-w-xl leading-relaxed text-white/85">
                  {slide.subtitle}
                </p>
                <Link
                  href={slide.href}
                  tabIndex={active ? undefined : -1}
                  className="mt-7 inline-flex min-h-11 items-center justify-center rounded-lg bg-white px-6 text-sm font-semibold text-brand-700 shadow-sm transition hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  {slide.ctaLabel}
                </Link>
              </div>
            </div>
          </article>
        );
      })}

      {count > 1 && (
        <>
          <button
            type="button"
            onClick={showPrevious}
            aria-label={previousLabel}
            className="absolute left-3 top-1/2 z-20 grid size-11 -translate-y-1/2 place-items-center rounded-full border border-white/30 bg-ink-900/45 text-white shadow-lg backdrop-blur-sm transition hover:scale-105 hover:bg-ink-900/65 sm:left-5"
          >
            <Chevron direction="left" />
          </button>
          <button
            type="button"
            onClick={showNext}
            aria-label={nextLabel}
            className="absolute right-3 top-1/2 z-20 grid size-11 -translate-y-1/2 place-items-center rounded-full border border-white/30 bg-ink-900/45 text-white shadow-lg backdrop-blur-sm transition hover:scale-105 hover:bg-ink-900/65 sm:right-5"
          >
            <Chevron direction="right" />
          </button>

          <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 gap-2 rounded-full bg-ink-900/35 px-3 py-2 backdrop-blur-sm">
            {slides.map((slide, index) => (
              <button
                key={slide.id}
                type="button"
                onClick={() => setActiveIndex(index)}
                aria-label={`${goToSlideLabel} ${index + 1}`}
                aria-current={index === currentIndex ? "true" : undefined}
                className={`h-2.5 rounded-full transition-all ${
                  index === currentIndex
                    ? "w-7 bg-white"
                    : "w-2.5 bg-white/55 hover:bg-white/80"
                }`}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
