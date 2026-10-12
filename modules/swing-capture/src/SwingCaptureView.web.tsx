import { SwingCaptureViewProps } from './SwingCapture.types';

// SwingCaptureView is not available on the web platform.
export default function SwingCaptureView(_props: SwingCaptureViewProps) {
  throw new Error('SwingCaptureView is not available on the web platform.');
}
