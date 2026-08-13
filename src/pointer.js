// src/pointer.js — how precise the current input device is.
//
// A finger or stylus lands with far more scatter than a mouse, so hit radii and
// tap thresholds are widened on coarse pointers. Queried per use rather than
// cached at load, so a hybrid laptop switching between trackpad and touchscreen
// stays right.

export function isCoarsePointer() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

// A length in CSS pixels, widened for coarse pointers.
export function pointerSlop(finePx, coarseFactor = 1.7) {
  return isCoarsePointer() ? finePx * coarseFactor : finePx;
}
