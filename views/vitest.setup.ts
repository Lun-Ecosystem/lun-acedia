import '@testing-library/jest-dom/vitest';

// jsdom has no ResizeObserver; Bits UI measures some controls (slider) with it.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom has no scrollIntoView; Bits Command scrolls the highlighted entry into view.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
