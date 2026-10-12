import { requireNativeView } from 'expo';
import * as React from 'react';

import { SwingCaptureViewProps } from './SwingCapture.types';

const NativeView: React.ComponentType<SwingCaptureViewProps> = requireNativeView('SwingCapture');

export default function SwingCaptureView(props: SwingCaptureViewProps) {
  return <NativeView {...props} />;
}
