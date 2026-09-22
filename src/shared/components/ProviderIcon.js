"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { getProviderIconSrc, getProviderIconSvgSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";

function resolveSrc(src, providerId) {
  if (providerId) return getProviderIconSrc(providerId);
  if (!src) return null;
  const m = String(src).match(/^\/providers\/([^/]+)\.png$/i);
  if (m) return getProviderIconSrc(m[1]);
  return src;
}

export default function ProviderIcon({
  src,
  providerId,
  alt,
  size = 32,
  className = "",
  fallbackText = "?",
  fallbackColor,
}) {
  const effectiveSrc = resolveSrc(src, providerId);
  const [failed, setFailed] = useState({ primary: null, svg: null });
  const svgSrc = getProviderIconSvgSrc(providerId || effectiveSrc?.match(/^\/providers\/([^/]+)\.png$/i)?.[1]);
  const currentSrc = failed.primary === effectiveSrc ? svgSrc : effectiveSrc;

  if (!currentSrc || (failed.svg === svgSrc && failed.primary === effectiveSrc && failed.svg !== null)) {
    return (
      <span
        className={`inline-flex items-center justify-center font-bold rounded-lg ${className}`.trim()}
        style={{
          width: size,
          height: size,
          color: fallbackColor,
          fontSize: Math.max(10, Math.floor(size * 0.38)),
        }}
      >
        {fallbackText}
      </span>
    );
  }

  return (
    <img
      src={currentSrc}
      alt={alt}
      width={size}
      height={size}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => {
        if (currentSrc === effectiveSrc && svgSrc) {
          setFailed({ primary: effectiveSrc, svg: null });
          return;
        }
        const m = effectiveSrc?.match(/^\/providers\/([^/]+)\.\w+$/i);
        if (m) markProviderIconMissing(m[1]);
        if (providerId) markProviderIconMissing(providerId);
        setFailed({ primary: effectiveSrc, svg: svgSrc });
      }}
    />
  );
}

ProviderIcon.propTypes = {
  src: PropTypes.string,
  providerId: PropTypes.string,
  alt: PropTypes.string,
  size: PropTypes.number,
  className: PropTypes.string,
  fallbackText: PropTypes.string,
  fallbackColor: PropTypes.string,
};
