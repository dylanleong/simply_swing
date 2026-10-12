// Re-export the native module. On web, it will be resolved to SwingCaptureModule.web.ts
// and on native platforms to SwingCaptureModule.ts
export { default } from './src/SwingCaptureModule';
export { default as SwingCaptureView } from './src/SwingCaptureView';
export { useCapturePermissions } from './src/useCapturePermissions';
export * from './src/SwingCapture.types';
