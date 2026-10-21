import '@testing-library/jest-dom/vitest';

// jsdom has no ResizeObserver; Bits UI measures some controls (slider) with it.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
