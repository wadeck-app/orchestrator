import '@testing-library/jest-dom';


// jsdom has no ResizeObserver. Radix's Switch measures its hidden checkbox with one whenever the switch sits inside a
// <form> (the job form's "Restart on exit"); a real browser has it, so this stands in for it and measures nothing.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}

    unobserve(): void {}

    disconnect(): void {}
  };
}
