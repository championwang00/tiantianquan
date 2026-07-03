(function exposeInstagramCarousel(global) {
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
})(typeof globalThis !== "undefined" ? globalThis : self);
