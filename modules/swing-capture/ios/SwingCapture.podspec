Pod::Spec.new do |s|
  s.name           = 'SwingCapture'
  s.version        = '0.1.0'
  s.summary        = 'Rolling-buffer high-fps swing capture engine'
  s.description    = 'Rolling-buffer high-fps swing capture engine for SimpleSwing'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.frameworks = 'AVFoundation', 'AVKit', 'AudioToolbox', 'CoreMedia', 'CoreVideo', 'Network'
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
