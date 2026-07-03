(function exposeInstagramCarousel(global) {
  function extractInstagramEmbeddedCarousel(scriptTexts, pageUrl) {
    const shortcode = String(pageUrl || "").match(/\/p\/([^/?#]+)/)?.[1] || "";
    if (!shortcode) return [];
    let carousel = null;
    const visited = new Set();
    const walk = (value, depth = 0) => {
      if (carousel || value == null || depth > 18 || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (value.code === shortcode && Array.isArray(value.carousel_media)) {
        carousel = value.carousel_media;
        return;
      }
      const children = Array.isArray(value) ? value : Object.values(value);
      for (let index = 0; index < Math.min(children.length, 500); index += 1) walk(children[index], depth + 1);
    };
    for (const text of scriptTexts || []) {
      if (carousel) break;
      if (!String(text || "").includes(shortcode)) continue;
      try { walk(JSON.parse(text)); } catch (_error) { /* Non-JSON scripts are irrelevant. */ }
    }
    return (carousel || []).map((media, index) => normalizeEmbeddedMedia(media, index)).filter(Boolean);
  }

  function normalizeEmbeddedMedia(media, index) {
    const isVideo = Number(media?.media_type) === 2 || /VideoMedia/i.test(String(media?.__typename || ""));
    const versions = Array.isArray(media?.video_versions) ? media.video_versions : [];
    const video = versions.slice().sort((a, b) => Number(b?.width || 0) * Number(b?.height || 0) - Number(a?.width || 0) * Number(a?.height || 0))[0];
    const images = Array.isArray(media?.image_versions2?.candidates) ? media.image_versions2.candidates : [];
    const image = images.slice().sort((a, b) => Number(b?.width || 0) * Number(b?.height || 0) - Number(a?.width || 0) * Number(a?.height || 0))[0];
    const src = isVideo ? String(video?.url || "") : String(media?.display_uri || image?.url || "");
    if (!/^https?:\/\//i.test(src)) return null;
    const durationMatch = String(media?.video_dash_manifest || "").match(/mediaPresentationDuration="PT([\d.]+)S"/i);
    return {
      index,
      type: isVideo ? "video" : "image",
      src,
      poster: isVideo ? String(media?.display_uri || image?.url || "") : "",
      mediaId: String(media?.pk || media?.id || "").replace(/^POLARIS_/, ""),
      shortcode: String(media?.code || ""),
      description: String(media?.accessibility_caption || "").trim(),
      duration: durationMatch ? Number(durationMatch[1]) : Number(media?.video_duration || 0),
      width: Number(media?.original_width || video?.width || image?.width || 0),
      height: Number(media?.original_height || video?.height || image?.height || 0)
    };
  }

  async function traverseInstagramCarousel({ read, signature, clickPrevious, clickNext, waitForChange, maxTransitions = 30 }) {
    const initial = signature();
    const backwards = [];
    const backwardSeen = new Set([initial]);
    for (let step = 0; step < maxTransitions; step += 1) {
      const before = signature();
      if (!clickPrevious()) break;
      const after = await waitForChange(before);
      if (!after || backwardSeen.has(after)) break;
      backwardSeen.add(after);
      backwards.push(after);
    }

    const ordered = [];
    const assetSeen = new Set();
    const append = () => {
      for (const asset of read() || []) {
        const key = `${asset.type}:${asset.mediaId || asset.src || asset.poster || ""}`;
        if (!assetSeen.has(key)) { assetSeen.add(key); ordered.push({ ...asset, index: ordered.length }); }
      }
    };
    append();
    const forwardSeen = new Set([signature()]);
    for (let step = 0; step < maxTransitions; step += 1) {
      const before = signature();
      if (!clickNext()) break;
      const after = await waitForChange(before);
      if (!after || forwardSeen.has(after)) break;
      forwardSeen.add(after);
      append();
    }

    for (let step = 0; step < maxTransitions && signature() !== initial; step += 1) {
      const before = signature();
      const move = backwards.length && !backwardSeen.has(signature()) ? clickPrevious : clickPrevious;
      if (!move()) break;
      if (!await waitForChange(before)) break;
    }
    if (signature() !== initial) {
      for (let step = 0; step < maxTransitions && signature() !== initial; step += 1) {
        const before = signature(); if (!clickNext()) break; if (!await waitForChange(before)) break;
      }
    }
    return ordered;
  }
  global.traverseInstagramCarousel = traverseInstagramCarousel;
  global.extractInstagramEmbeddedCarousel = extractInstagramEmbeddedCarousel;
})(typeof globalThis !== "undefined" ? globalThis : self);
